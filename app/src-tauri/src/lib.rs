mod ai_cmds;
mod mcp;
mod sync_cmds;
mod vault;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serverhub_bridge::{BridgeHandle, BridgeMode, CertPinChecker, start_bridge};
use serverhub_core::{
    AuthMethod, AuthStage, Credential, CredentialKind, CredentialStore, Protocol, Server,
    ServerStore, ssh_config,
};
use serverhub_monitor::{PROBE_CMD, RawSnapshot, ServerStats};
use serverhub_ssh::{
    Auth, ConnectConfig, CredentialAuth, HostKeyStatus, KnownHostsStore, ShellEvent, ShellHandle,
    SshAuthStage, SshError, SshSession,
};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::{Mutex, RwLock, Semaphore};
use uuid::Uuid;

const MAX_CONCURRENT_SSH_CONNECTS: usize = 12;
const MAX_CONCURRENT_PINGS: usize = 8;
const MAX_CONCURRENT_GEO_LOOKUPS: usize = 4;
const MAX_ACTIVE_BRIDGES: usize = 32;
const ICMP_CACHE_TTL: Duration = Duration::from_secs(20);
const ICMP_CACHE_MAX_ENTRIES: usize = 512;
const GEO_SUCCESS_CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const GEO_FAILURE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const GEO_CACHE_MAX_ENTRIES: usize = 512;
const MONITOR_IDLE_TTL: Duration = Duration::from_secs(5 * 60);
const MCP_SSH_POOL_IDLE_TTL: Duration = Duration::from_secs(10 * 60);
const MCP_SHELL_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
const SHELL_IPC_COALESCE_CAP: usize = 64 * 1024;

struct SessionEntry {
    shell: ShellHandle,
    session: SshSession,
}

struct MonitorEntry {
    target_sig: String,
    session: Option<SshSession>,
    prev: Option<(RawSnapshot, Instant)>,
    last_used: Instant,
}

type IcmpCacheMap = Arc<RwLock<HashMap<String, (Option<f64>, Instant)>>>;
type AiStreamMap = Arc<Mutex<HashMap<String, (u64, tokio::sync::watch::Sender<bool>)>>>;

pub(crate) struct AppState {
    sessions: Arc<RwLock<HashMap<Uuid, SessionEntry>>>,
    bridges: Arc<Mutex<HashMap<Uuid, BridgeHandle>>>,
    pub(crate) store_lock: RwLock<()>,
    pub(crate) sync_lock: Mutex<()>,
    pub(crate) vault: RwLock<vault::VaultState>,
    known_hosts: std::sync::RwLock<Option<KnownHostsStore>>,
    monitor_entries: RwLock<HashMap<String, Arc<Mutex<MonitorEntry>>>>,
    pub(crate) connect_semaphore: Arc<Semaphore>,
    ping_semaphore: Arc<Semaphore>,
    geo_semaphore: Arc<Semaphore>,
    icmp_cache: IcmpCacheMap,
    pub(crate) ai_streams: AiStreamMap,
    geo_cache: RwLock<HashMap<String, (Option<GeoInfo>, Instant)>>,
    http_client: reqwest::Client,
    pub(crate) mcp: mcp::McpRuntime,
}

impl AppState {
    pub(crate) async fn evict_server_caches(&self, server_id: &Uuid) {
        let key = server_id.to_string();
        let monitor_arc = {
            let mut guard = self.monitor_entries.write().await;
            guard.remove(&key)
        };
        if let Some(arc) = monitor_arc {
            tokio::spawn(async move {
                if let Some(sess) = arc.lock().await.session.take() {
                    let _ = sess.close().await;
                }
            });
        }
        self.mcp.evict_pooled_ssh(&key).await;
        self.mcp.close_shell_sessions_for_server(&key).await;
    }

    pub(crate) async fn evict_all_server_caches(&self) {
        let monitor_arcs: Vec<Arc<Mutex<MonitorEntry>>> = {
            let mut guard = self.monitor_entries.write().await;
            guard.drain().map(|(_, v)| v).collect()
        };
        for arc in monitor_arcs {
            tokio::spawn(async move {
                if let Some(sess) = arc.lock().await.session.take() {
                    let _ = sess.close().await;
                }
            });
        }
        self.mcp.evict_all_pooled_ssh().await;
        self.mcp.close_all_shell_sessions().await;
    }

    pub(crate) async fn reap_idle_resources(&self) {
        let candidates: Vec<(String, Arc<Mutex<MonitorEntry>>)> = {
            let guard = self.monitor_entries.read().await;
            guard
                .iter()
                .map(|(k, v)| (k.clone(), Arc::clone(v)))
                .collect()
        };
        let mut stale_keys = Vec::new();
        for (key, arc) in candidates {
            if let Ok(mut entry) = arc.try_lock()
                && entry.last_used.elapsed() >= MONITOR_IDLE_TTL
            {
                if let Some(sess) = entry.session.take() {
                    close_session_bg(sess);
                }
                entry.prev = None;
                stale_keys.push(key);
            }
        }
        if !stale_keys.is_empty() {
            let mut map = self.monitor_entries.write().await;
            for key in stale_keys {
                let should_remove = map.get(&key).is_some_and(|arc| {
                    arc.try_lock().is_ok_and(|entry| {
                        entry.session.is_none() && entry.last_used.elapsed() >= MONITOR_IDLE_TTL
                    })
                });
                if should_remove {
                    map.remove(&key);
                }
            }
        }
        self.mcp
            .reap_idle_resources(MCP_SSH_POOL_IDLE_TTL, MCP_SHELL_IDLE_TTL)
            .await;
    }

    pub(crate) async fn shutdown_all(&self) {
        let sessions: Vec<SessionEntry> = {
            let mut guard = self.sessions.write().await;
            guard.drain().map(|(_, v)| v).collect()
        };
        for entry in sessions {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        }
        {
            let mut bridges = self.bridges.lock().await;
            for (_, mut handle) in bridges.drain() {
                handle.close();
            }
        }
        {
            let mut streams = self.ai_streams.lock().await;
            for (_, (_, tx)) in streams.drain() {
                let _ = tx.send(true);
            }
        }
        self.evict_all_server_caches().await;
        mcp::stop_server_inner(self).await;
    }
}

impl Default for AppState {
    fn default() -> Self {
        let http_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(8)
            .tcp_nodelay(true)
            .user_agent("ServerHub-Desktop/0.1")
            .build()
            .expect("failed to build shared HTTP client");
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            bridges: Arc::new(Mutex::new(HashMap::new())),
            store_lock: RwLock::new(()),
            sync_lock: Mutex::new(()),
            vault: RwLock::new(vault::VaultState::default()),
            known_hosts: std::sync::RwLock::new(None),
            monitor_entries: RwLock::new(HashMap::new()),
            connect_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_SSH_CONNECTS)),
            ping_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_PINGS)),
            geo_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_GEO_LOOKUPS)),
            icmp_cache: Arc::new(RwLock::new(HashMap::new())),
            ai_streams: Arc::new(Mutex::new(HashMap::new())),
            geo_cache: RwLock::new(HashMap::new()),
            http_client,
            mcp: mcp::McpRuntime::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct GeoInfo {
    country_code: String,
    label: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct CmdError {
    pub(crate) kind: String,
    pub(crate) message: String,
    pub(crate) host: Option<String>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) expected: Option<String>,
}

impl CmdError {
    fn auth(message: impl Into<String>) -> Self {
        Self {
            kind: "auth".to_string(),
            message: message.into(),
            host: None,
            fingerprint: None,
            expected: None,
        }
    }

    fn connect(message: impl Into<String>) -> Self {
        Self {
            kind: "connect".to_string(),
            message: message.into(),
            host: None,
            fingerprint: None,
            expected: None,
        }
    }

    pub(crate) fn other(message: impl Into<String>) -> Self {
        Self {
            kind: "other".to_string(),
            message: message.into(),
            host: None,
            fingerprint: None,
            expected: None,
        }
    }

    fn busy() -> Self {
        Self {
            kind: "busy".to_string(),
            message: "采集任务正在进行中".to_string(),
            host: None,
            fingerprint: None,
            expected: None,
        }
    }
}

impl From<SshError> for CmdError {
    fn from(err: SshError) -> Self {
        match err {
            SshError::HostKeyUnknown { host, fingerprint } => Self {
                kind: "host_key_unknown".to_string(),
                message: format!("未知主机指纹 ({host}): {fingerprint}"),
                host: Some(host),
                fingerprint: Some(fingerprint),
                expected: None,
            },
            SshError::HostKeyMismatch {
                host,
                expected,
                got,
            } => Self {
                kind: "host_key_mismatch".to_string(),
                message: format!("主机 {host} 公钥指纹不匹配，可能存在中间人攻击"),
                host: Some(host),
                fingerprint: Some(got),
                expected: Some(expected),
            },
            SshError::Auth(msg) | SshError::KeyLoad(msg) => Self::auth(msg),
            SshError::Connect(msg) => Self::connect(msg),
            other => Self::other(other.to_string()),
        }
    }
}

#[derive(Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SshAuthInput {
    Password {
        #[serde(default)]
        password: Option<String>,
    },
    Key {
        path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    Credential {
        #[serde(default)]
        credential_id: String,
        #[serde(default)]
        password: Option<String>,
    },
    KeyboardInteractive {
        #[serde(default)]
        password: Option<String>,
    },
    Ask {
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        key_path: Option<String>,
        #[serde(default)]
        passphrase: Option<String>,
    },
}

#[derive(Deserialize, Clone)]
struct SshConnectInput {
    server_id: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth: SshAuthInput,
    #[serde(default)]
    auth_priority: Vec<AuthStage>,
    #[serde(default)]
    timeout_secs: Option<u64>,
    #[serde(default)]
    keepalive_secs: Option<u64>,
    #[serde(default)]
    jump_hosts: Vec<Uuid>,
    #[serde(default)]
    term_type: Option<String>,
    accept_host_key: Option<String>,
}

pub(crate) fn load_known_hosts(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<KnownHostsStore, CmdError> {
    {
        let guard = state
            .known_hosts
            .read()
            .map_err(|_| CmdError::other("known_hosts 状态锁异常"))?;
        if let Some(store) = guard.as_ref() {
            return Ok(store.clone());
        }
    }
    let mut guard = state
        .known_hosts
        .write()
        .map_err(|_| CmdError::other("known_hosts 状态锁异常"))?;
    if let Some(store) = guard.as_ref() {
        return Ok(store.clone());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::other(format!("无法获取应用数据目录: {e}")))?;
    let store = KnownHostsStore::load_or_create(data_dir.join("known_hosts.json"))
        .map_err(CmdError::from)?;
    *guard = Some(store.clone());
    Ok(store)
}

pub(crate) async fn resolve_secret(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id: &str,
) -> Option<String> {
    vault::resolve_secret(app, state, server_id).await
}

pub(crate) async fn persist_secret(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id: &str,
    secret: &str,
) -> Result<(), CmdError> {
    vault::persist_secret(app, state, server_id, secret)
        .await
        .map_err(CmdError::other)
}

pub(crate) fn map_auth_priority(stages: &[AuthStage]) -> Vec<SshAuthStage> {
    stages
        .iter()
        .map(|s| match s {
            AuthStage::Key => SshAuthStage::Key,
            AuthStage::Credential => SshAuthStage::Credential,
            AuthStage::Password => SshAuthStage::Password,
            AuthStage::KeyboardInteractive => SshAuthStage::KeyboardInteractive,
        })
        .collect()
}

pub(crate) fn credential_store(app: &tauri::AppHandle) -> Result<CredentialStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(CredentialStore::new(data_dir.join("credentials.json")))
}

pub(crate) async fn resolve_credential_auth(
    app: &tauri::AppHandle,
    state: &AppState,
    credential_id: &str,
    server_id: Option<&str>,
    override_secret: Option<String>,
) -> Result<(CredentialAuth, Option<(String, String)>), CmdError> {
    let cid = credential_id.trim();
    if cid.is_empty() {
        return Err(CmdError::auth("未选择登录凭证"));
    }
    let cred_opt = {
        let _guard = state.store_lock.read().await;
        credential_store(app)
            .ok()
            .and_then(|s| s.load().ok())
            .and_then(|list| {
                if let Ok(uuid) = Uuid::parse_str(cid) {
                    list.into_iter().find(|c| c.id == uuid)
                } else {
                    list.into_iter().find(|c| c.name == cid)
                }
            })
    };
    let Some(cred) = cred_opt else {
        return Err(CmdError::auth("关联的登录凭证不存在或已被删除"));
    };

    let vault_key = format!("cred:{}", cred.id);
    let mut persist_pair: Option<(String, String)> = None;
    let secret = match override_secret.filter(|s| !s.is_empty()) {
        Some(s) => {
            persist_pair = Some((vault_key.clone(), s.clone()));
            Some(s)
        }
        None => {
            if let Some(s) = resolve_secret(app, state, &vault_key).await {
                Some(s)
            } else if let Some(sid) = server_id.filter(|s| Uuid::parse_str(s.trim()).is_ok()) {
                resolve_secret(app, state, sid.trim()).await
            } else {
                None
            }
        }
    };

    match cred.kind {
        CredentialKind::Password => {
            let pw = secret
                .ok_or_else(|| CmdError::auth(format!("登录凭证「{}」需要输入密码", cred.name)))?;
            Ok((
                CredentialAuth {
                    username: cred.username.clone(),
                    password: Some(pw),
                    key_path: None,
                    passphrase: None,
                },
                persist_pair,
            ))
        }
        CredentialKind::Key => {
            let path = cred
                .key_path
                .clone()
                .filter(|p| !p.trim().is_empty())
                .unwrap_or_else(|| "~/.ssh/id_ed25519".to_string());
            Ok((
                CredentialAuth {
                    username: cred.username.clone(),
                    password: None,
                    key_path: Some(path),
                    passphrase: secret,
                },
                persist_pair,
            ))
        }
    }
}

pub(crate) async fn resolve_server_auth(
    app: &tauri::AppHandle,
    state: &AppState,
    server: &Server,
) -> Result<Auth, CmdError> {
    let sid = server.id.to_string();
    match &server.auth {
        AuthMethod::Password => {
            let pw = resolve_secret(app, state, &sid)
                .await
                .ok_or_else(|| CmdError::auth(format!("服务器「{}」需要密码", server.name)))?;
            Ok(Auth::Password(pw))
        }
        AuthMethod::Key { path } => {
            let passphrase = resolve_secret(app, state, &sid).await;
            Ok(Auth::Key {
                path: path.clone(),
                passphrase,
            })
        }
        AuthMethod::Credential { credential_id } => {
            let (cred_auth, _) =
                resolve_credential_auth(app, state, credential_id, Some(&sid), None).await?;
            Ok(Auth::Credential(cred_auth))
        }
        AuthMethod::KeyboardInteractive => {
            let pw = resolve_secret(app, state, &sid).await;
            Ok(Auth::KeyboardInteractive { password: pw })
        }
        AuthMethod::Ask { key_path } => {
            if let Some(path) = key_path.as_deref().filter(|p| !p.trim().is_empty()) {
                Ok(Auth::Ask {
                    password: None,
                    key_path: Some(path.to_string()),
                    passphrase: None,
                })
            } else {
                Err(CmdError::auth(format!(
                    "服务器「{}」设置为每次询问密码",
                    server.name
                )))
            }
        }
    }
}

fn collect_jump_servers<'a>(
    hop_ids: &[Uuid],
    all_servers: &'a [Server],
    visited: &mut Vec<Uuid>,
    out: &mut Vec<&'a Server>,
    depth: usize,
) -> Result<(), CmdError> {
    if depth >= 8 {
        return Err(CmdError::connect("跳板机链路超过最大跳数限制 (8 跳)"));
    }
    for &hop_id in hop_ids {
        if visited.contains(&hop_id) {
            continue;
        }
        if out.len() >= 8 {
            return Err(CmdError::connect("跳板机链路超过最大跳数限制 (8 跳)"));
        }
        let hop_srv = all_servers
            .iter()
            .find(|s| s.id == hop_id)
            .ok_or_else(|| CmdError::connect(format!("找不到跳板机节点 ({hop_id})")))?;
        visited.push(hop_id);
        if !hop_srv.jump_hosts.is_empty() {
            collect_jump_servers(&hop_srv.jump_hosts, all_servers, visited, out, depth + 1)?;
        }
        if !out.iter().any(|s| s.id == hop_srv.id) {
            if out.len() >= 8 {
                return Err(CmdError::connect("跳板机链路超过最大跳数限制 (8 跳)"));
            }
            out.push(hop_srv);
        }
    }
    Ok(())
}

pub(crate) async fn resolve_jump_configs(
    app: &tauri::AppHandle,
    state: &AppState,
    self_id: Option<Uuid>,
    hop_ids: &[Uuid],
    accept_host_key: Option<String>,
    auto_trust_unknown_host_key: bool,
) -> Result<Vec<ConnectConfig>, CmdError> {
    if accept_host_key.as_deref().map(str::trim) == Some("*") {
        return Err(CmdError::other("不允许使用通配符接受未知主机指纹"));
    }
    if hop_ids.is_empty() {
        return Ok(Vec::new());
    }
    let all_servers = {
        let _guard = state.store_lock.read().await;
        server_store(app)
            .map_err(CmdError::other)?
            .load()
            .map_err(|e| CmdError::other(e.to_string()))?
    };
    let mut visited = Vec::new();
    if let Some(id) = self_id {
        visited.push(id);
    }
    let mut hop_servers = Vec::new();
    collect_jump_servers(hop_ids, &all_servers, &mut visited, &mut hop_servers, 0)?;

    let mut configs = Vec::with_capacity(hop_servers.len());
    for srv in hop_servers {
        let auth = resolve_server_auth(app, state, srv).await?;
        let username = match &auth {
            Auth::Credential(c) => c
                .username
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&srv.username)
                .to_string(),
            _ => srv.username.clone(),
        };
        configs.push(ConnectConfig {
            host: srv.host.clone(),
            port: srv.port,
            username,
            auth,
            auth_priority: map_auth_priority(&srv.auth_priority),
            timeout_secs: srv.timeout_secs,
            keepalive_secs: srv.keepalive_secs,
            jump_hosts: Vec::new(),
            term_type: srv.term_type.clone(),
            accept_host_key: accept_host_key.clone(),
            auto_trust_unknown_host_key,
        });
    }
    Ok(configs)
}

async fn resolve_input_connect_config(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SshConnectInput,
    allow_vault_fallback: bool,
) -> Result<(ConnectConfig, Option<(String, String)>), CmdError> {
    if cfg.accept_host_key.as_deref().map(str::trim) == Some("*") {
        return Err(CmdError::other("不允许使用通配符接受未知主机指纹"));
    }

    let self_uuid = cfg
        .server_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| Uuid::parse_str(s).ok());
    let valid_sid = self_uuid.map(|u| u.to_string());
    let sid = valid_sid.as_deref();
    let mut persist_target: Option<(String, String)> = None;

    let auth = match &cfg.auth {
        SshAuthInput::Password { password } => {
            let pw = match password.as_ref().filter(|p| !p.is_empty()) {
                Some(p) => {
                    if let Some(id) = sid {
                        persist_target = Some((id.to_string(), p.clone()));
                    }
                    p.clone()
                }
                None => {
                    if allow_vault_fallback && let Some(id) = sid {
                        resolve_secret(app, state, id)
                            .await
                            .ok_or_else(|| CmdError::auth("需要密码"))?
                    } else {
                        return Err(CmdError::auth("需要密码"));
                    }
                }
            };
            Auth::Password(pw)
        }
        SshAuthInput::Key { path, passphrase } => {
            let resolved_passphrase = match passphrase.as_ref().filter(|p| !p.is_empty()) {
                Some(p) => {
                    if let Some(id) = sid {
                        persist_target = Some((id.to_string(), p.clone()));
                    }
                    Some(p.clone())
                }
                None => {
                    if allow_vault_fallback && let Some(id) = sid {
                        resolve_secret(app, state, id).await
                    } else {
                        None
                    }
                }
            };
            Auth::Key {
                path: path.clone(),
                passphrase: resolved_passphrase,
            }
        }
        SshAuthInput::Credential {
            credential_id,
            password,
        } => {
            let (cred_auth, cred_persist) =
                resolve_credential_auth(app, state, credential_id, sid, password.clone()).await?;
            persist_target = cred_persist;
            Auth::Credential(cred_auth)
        }
        SshAuthInput::KeyboardInteractive { password } => {
            let resolved_pw = match password.as_ref().filter(|p| !p.is_empty()) {
                Some(p) => {
                    if let Some(id) = sid {
                        persist_target = Some((id.to_string(), p.clone()));
                    }
                    Some(p.clone())
                }
                None => {
                    if allow_vault_fallback && let Some(id) = sid {
                        resolve_secret(app, state, id).await
                    } else {
                        None
                    }
                }
            };
            Auth::KeyboardInteractive {
                password: resolved_pw,
            }
        }
        SshAuthInput::Ask {
            password,
            key_path,
            passphrase,
        } => {
            let pw = password.clone().filter(|p| !p.is_empty());
            let pp = passphrase.clone().filter(|p| !p.is_empty());
            let kp = key_path.clone().filter(|p| !p.trim().is_empty());
            if pw.is_none() && pp.is_none() && kp.is_none() {
                return Err(CmdError::auth("每次询问：请输入本次连接登录密码"));
            }
            // Ask mode never sets persist_target, so secrets are never written to vault
            Auth::Ask {
                password: pw,
                key_path: kp,
                passphrase: pp,
            }
        }
    };

    let jump_hosts = resolve_jump_configs(
        app,
        state,
        self_uuid,
        &cfg.jump_hosts,
        cfg.accept_host_key.clone(),
        false,
    )
    .await?;

    let username = match &auth {
        Auth::Credential(c) => c
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&cfg.username)
            .to_string(),
        _ => cfg.username.clone(),
    };

    let connect_cfg = ConnectConfig {
        host: cfg.host.clone(),
        port: cfg.port,
        username,
        auth,
        auth_priority: map_auth_priority(&cfg.auth_priority),
        timeout_secs: cfg.timeout_secs,
        keepalive_secs: cfg.keepalive_secs,
        jump_hosts,
        term_type: cfg.term_type.clone(),
        accept_host_key: cfg.accept_host_key.clone(),
        auto_trust_unknown_host_key: false,
    };

    Ok((connect_cfg, persist_target))
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
enum TermEvent {
    Data(Vec<u8>),
    Exit(Option<u32>),
    Closed,
}

#[tauri::command]
async fn ssh_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cfg: SshConnectInput,
    cols: u32,
    rows: u32,
    on_event: Channel<TermEvent>,
) -> Result<String, CmdError> {
    let known_hosts = load_known_hosts(&app, &state)?;
    let (connect_cfg, persist_target) =
        resolve_input_connect_config(&app, &state, &cfg, true).await?;

    let session = SshSession::connect(connect_cfg, known_hosts).await?;

    if let Some((target_id, secret)) = persist_target {
        let _ = persist_secret(&app, &state, &target_id, &secret).await;
    }

    let (shell, mut rx) = match session.open_shell(cols.max(1), rows.max(1)).await {
        Ok(res) => res,
        Err(err) => {
            let _ = session.close().await;
            return Err(CmdError::from(err));
        }
    };

    let id = Uuid::new_v4();
    {
        let mut guard = state.sessions.write().await;
        guard.insert(
            id,
            SessionEntry {
                shell: shell.clone(),
                session,
            },
        );
    }

    let sessions = Arc::clone(&state.sessions);
    tokio::spawn(async move {
        while let Some(evt) = rx.recv().await {
            match evt {
                ShellEvent::Data(mut buf) => {
                    let mut trailing_evt: Option<ShellEvent> = None;
                    while buf.len() < SHELL_IPC_COALESCE_CAP {
                        match rx.try_recv() {
                            Ok(ShellEvent::Data(more)) => buf.extend_from_slice(&more),
                            Ok(other) => {
                                trailing_evt = Some(other);
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    if on_event.send(TermEvent::Data(buf)).is_err() {
                        break;
                    }
                    if let Some(other) = trailing_evt {
                        match other {
                            ShellEvent::Exit(code) => {
                                if on_event.send(TermEvent::Exit(code)).is_err() {
                                    break;
                                }
                            }
                            ShellEvent::Closed => {
                                let _ = on_event.send(TermEvent::Closed);
                                break;
                            }
                            ShellEvent::Data(_) => unreachable!(),
                        }
                    }
                }
                ShellEvent::Exit(code) => {
                    if on_event.send(TermEvent::Exit(code)).is_err() {
                        break;
                    }
                }
                ShellEvent::Closed => {
                    let _ = on_event.send(TermEvent::Closed);
                    break;
                }
            }
        }
        let entry = {
            let mut guard = sessions.write().await;
            guard.remove(&id)
        };
        if let Some(entry) = entry {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        }
    });

    Ok(id.to_string())
}

#[tauri::command]
async fn ssh_write(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), CmdError> {
    let uuid = Uuid::parse_str(&id).map_err(|e| CmdError::other(format!("无效会话 ID: {e}")))?;
    let shell = {
        let guard = state.sessions.read().await;
        guard
            .get(&uuid)
            .map(|entry| entry.shell.clone())
            .ok_or_else(|| CmdError::other("会话不存在或已关闭"))?
    };
    shell.write(data.into_bytes()).await.map_err(CmdError::from)
}

#[tauri::command]
async fn ssh_resize(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), CmdError> {
    let uuid = Uuid::parse_str(&id).map_err(|e| CmdError::other(format!("无效会话 ID: {e}")))?;
    let shell = {
        let guard = state.sessions.read().await;
        guard
            .get(&uuid)
            .map(|entry| entry.shell.clone())
            .ok_or_else(|| CmdError::other("会话不存在或已关闭"))?
    };
    shell
        .resize(cols.max(1), rows.max(1))
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
async fn ssh_close(state: tauri::State<'_, AppState>, id: String) -> Result<(), CmdError> {
    let uuid = Uuid::parse_str(&id).map_err(|e| CmdError::other(format!("无效会话 ID: {e}")))?;
    let entry = {
        let mut guard = state.sessions.write().await;
        guard.remove(&uuid)
    };
    if let Some(entry) = entry {
        let _ = entry.shell.close().await;
        let _ = entry.session.close().await;
    }
    Ok(())
}

fn is_valid_server_secret_key(key: &str) -> bool {
    let trimmed = key.trim();
    !trimmed.is_empty()
        && trimmed == key
        && Uuid::parse_str(trimmed).is_ok()
        && !vault::is_frontend_restricted_secret_key(trimmed)
}

async fn verify_readable_secret_key(
    app: &tauri::AppHandle,
    state: &AppState,
    id: &str,
) -> Result<(), String> {
    if vault::is_frontend_restricted_secret_key(id) {
        return Err("无权读取系统内部密钥命名空间".to_string());
    }
    let _guard = state.store_lock.read().await;
    if let Some(rest) = id.strip_prefix("cred:") {
        let uuid = Uuid::parse_str(rest).map_err(|_| "无效凭证密钥标识".to_string())?;
        let exists = credential_store(app)?
            .load()
            .map_err(|e| e.to_string())?
            .iter()
            .any(|c| c.id == uuid);
        if !exists {
            return Err("关联的登录凭证不存在".to_string());
        }
        return Ok(());
    }
    let uuid = Uuid::parse_str(id).map_err(|_| "无效服务器密钥标识".to_string())?;
    let exists = server_store(app)?
        .load()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|s| s.id == uuid);
    if !exists {
        return Err("关联的服务器不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn secret_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
    password: String,
) -> Result<(), CmdError> {
    if !is_valid_server_secret_key(&server_id) {
        return Err(CmdError::other("无权访问系统内部密钥命名空间"));
    }
    persist_secret(&app, &state, &server_id, &password).await
}

#[tauri::command]
async fn secret_forget(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<(), CmdError> {
    if !is_valid_server_secret_key(&server_id) {
        return Err(CmdError::other("无权访问系统内部密钥命名空间"));
    }
    vault::delete_secret(&app, &state, &server_id)
        .await
        .map_err(CmdError::other)
}

#[tauri::command]
async fn secret_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    secret: String,
) -> Result<(), String> {
    if !is_valid_server_secret_key(&id) {
        return Err("无权访问系统内部密钥命名空间".to_string());
    }
    vault::persist_secret(&app, &state, &id, &secret).await
}

#[tauri::command]
async fn secret_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    verify_readable_secret_key(&app, &state, &id).await?;
    Ok(vault::resolve_secret(&app, &state, &id).await)
}

#[tauri::command]
async fn secret_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if !is_valid_server_secret_key(&id) {
        return Err("无权删除系统内部密钥命名空间".to_string());
    }
    vault::delete_secret(&app, &state, &id).await
}

#[cfg(target_os = "macos")]
async fn write_system_clipboard(text: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut cmd = tokio::process::Command::new("/usr/bin/pbcopy");
    cmd.env_remove("LC_ALL")
        .env("LC_CTYPE", "UTF-8")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("启动 pbcopy 失败: {e}"))?;

    let payload = text.as_bytes().to_vec();
    let output = tokio::time::timeout(Duration::from_secs(3), async {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&payload)
                .await
                .map_err(|e| format!("写入剪贴板数据失败: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("关闭剪贴板输入流失败: {e}"))?;
        }
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("等待 pbcopy 结束失败: {e}"))
    })
    .await
    .map_err(|_| "写入剪贴板超时".to_string())??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("写入剪贴板失败: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn write_system_clipboard(text: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $t = [Console]::In.ReadToEnd(); if ($t.Length -gt 0) { Set-Clipboard -Value $t } else { Set-Clipboard -Value $null }",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

    let payload = text.as_bytes().to_vec();
    let output = tokio::time::timeout(Duration::from_secs(5), async {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&payload)
                .await
                .map_err(|e| format!("写入剪贴板数据失败: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("关闭剪贴板输入流失败: {e}"))?;
        }
        child
            .wait_with_output()
            .await
            .map_err(|e| format!("等待剪贴板进程结束失败: {e}"))
    })
    .await
    .map_err(|_| "写入剪贴板超时".to_string())??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("写入剪贴板失败: {}", stderr.trim()));
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
async fn write_system_clipboard(text: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let candidates: &[(&str, &[&str])] = if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        &[
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ]
    } else {
        &[
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
            ("wl-copy", &[]),
        ]
    };

    let mut last_err = String::from("未找到可用的剪贴板工具 (wl-copy / xclip / xsel)");
    for (program, args) in candidates {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(*args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                last_err = format!("启动 {program} 失败: {e}");
                continue;
            }
        };
        let payload = text.as_bytes().to_vec();
        let res = tokio::time::timeout(Duration::from_secs(3), async {
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(&payload)
                    .await
                    .map_err(|e| format!("写入 {program} 失败: {e}"))?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|e| format!("关闭 {program} 输入流失败: {e}"))?;
            }
            child
                .wait()
                .await
                .map_err(|e| format!("等待 {program} 结束失败: {e}"))
        })
        .await;

        match res {
            Ok(Ok(status)) if status.success() => return Ok(()),
            Ok(Ok(status)) => last_err = format!("{program} 退出异常: {status}"),
            Ok(Err(e)) => last_err = e,
            Err(_) => last_err = format!("{program} 超时"),
        }
    }
    Err(last_err)
}

#[tauri::command]
async fn clipboard_write(text: String) -> Result<(), String> {
    write_system_clipboard(&text).await
}

fn parse_icmp_time_ms(stdout: &str) -> Option<f64> {
    for token in stdout.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if let Some(rest) = lower
            .strip_prefix("time=")
            .or_else(|| lower.strip_prefix("time<"))
            .or_else(|| token.strip_prefix("时间="))
            .or_else(|| token.strip_prefix("时间<"))
        {
            let num_str = rest.trim_end_matches("ms").trim_end_matches(',').trim();
            if let Ok(ms) = num_str.parse::<f64>()
                && ms.is_finite()
                && ms >= 0.0
            {
                return Some(ms);
            }
        }
    }
    // Fallback for Chinese Windows GBK stdout where "时间=" or "时间<" is non-UTF8 (\xca\xb1\xbc\xe4)
    // and lossily decoded into replacement characters followed by `=12ms` or `<1ms`.
    for token in stdout.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if let Some(ms_part) = lower.strip_suffix("ms")
            && let Some(idx) = ms_part.rfind(['=', '<'])
            && let Ok(ms) = ms_part[idx + 1..].parse::<f64>()
            && ms.is_finite()
            && ms >= 0.0
        {
            return Some(ms);
        }
    }
    None
}

pub(crate) fn is_valid_ping_host(host: &str) -> bool {
    let trimmed = host.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 255
        && !trimmed.starts_with('-')
        && !trimmed.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | ';' | '&' | '|' | '`')
        })
}

fn strip_ipv6_brackets(host: &str) -> &str {
    let trimmed = host.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

pub(crate) async fn icmp_ping_ms(host: &str) -> Option<f64> {
    let target = strip_ipv6_brackets(host).to_string();
    if !is_valid_ping_host(&target) {
        return None;
    }
    let is_ipv6 = target.contains(':');
    let mut cmd = tokio::process::Command::new(if cfg!(target_os = "macos") {
        if is_ipv6 { "/sbin/ping6" } else { "/sbin/ping" }
    } else {
        "ping"
    });
    cmd.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if cfg!(target_os = "windows") {
        cmd.args(["-n", "1", "-w", "1000", &target]);
    } else if cfg!(target_os = "macos") {
        if is_ipv6 {
            cmd.args(["-c", "1", "--", &target]);
        } else {
            cmd.args(["-c", "1", "-W", "1000", "--", &target]);
        }
    } else {
        cmd.args(["-c", "1", "-W", "1", "--", &target]);
    }

    let output = tokio::time::timeout(Duration::from_millis(1200), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_icmp_time_ms(&stdout)
}

async fn tcp_ping_ms(host: &str, port: u16) -> Option<f64> {
    let target = strip_ipv6_brackets(host);
    if !is_valid_ping_host(target) || port == 0 {
        return None;
    }
    let start = Instant::now();
    let res = tokio::time::timeout(
        Duration::from_millis(1500),
        tokio::net::TcpStream::connect((target, port)),
    )
    .await;
    match res {
        Ok(Ok(stream)) => {
            drop(stream);
            Some(start.elapsed().as_secs_f64() * 1000.0)
        }
        _ => None,
    }
}

async fn cached_icmp_ping_ms(state: &AppState, host: &str, allow_wait: bool) -> Option<f64> {
    let key = strip_ipv6_brackets(host).to_ascii_lowercase();
    if !is_valid_ping_host(&key) {
        return None;
    }
    {
        let cache = state.icmp_cache.read().await;
        if let Some((val, at)) = cache.get(&key)
            && at.elapsed() < ICMP_CACHE_TTL
        {
            return *val;
        }
    }

    let _permit = if allow_wait {
        state.ping_semaphore.acquire().await.ok()?
    } else {
        state.ping_semaphore.try_acquire().ok()?
    };
    // Re-check cache after acquiring semaphore in case another task just populated it.
    {
        let cache = state.icmp_cache.read().await;
        if let Some((val, at)) = cache.get(&key)
            && at.elapsed() < ICMP_CACHE_TTL
        {
            return *val;
        }
    }
    let val = icmp_ping_ms(&key).await;
    {
        let mut cache = state.icmp_cache.write().await;
        if cache.len() >= ICMP_CACHE_MAX_ENTRIES {
            cache.retain(|_, (_, at)| at.elapsed() < ICMP_CACHE_TTL);
            if cache.len() >= ICMP_CACHE_MAX_ENTRIES {
                cache.clear();
            }
        }
        cache.insert(key, (val, Instant::now()));
    }
    val
}

#[tauri::command]
async fn ssh_ping(
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<u64, String> {
    if let Some(ms) = cached_icmp_ping_ms(&state, &host, true).await {
        return Ok(ms.round().max(1.0) as u64);
    }
    // Fallback to TCP connect probe when ICMP is blocked by cloud security groups / firewalls.
    if let Some(ms) = tcp_ping_ms(&host, port).await {
        return Ok(ms.round().max(1.0) as u64);
    }
    Err("ICMP/TCP 连接超时".to_string())
}

#[tauri::command]
async fn ssh_test(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cfg: SshConnectInput,
) -> Result<u64, CmdError> {
    let known_hosts = load_known_hosts(&app, &state)?;
    let (connect_cfg, _) = resolve_input_connect_config(&app, &state, &cfg, true).await?;
    let total_timeout = connect_cfg
        .timeout_secs
        .unwrap_or(10)
        .clamp(1, 300)
        .saturating_mul((connect_cfg.jump_hosts.len() as u64) + 1)
        .saturating_add(4);
    let start = Instant::now();
    let session = tokio::time::timeout(
        Duration::from_secs(total_timeout),
        SshSession::connect(connect_cfg, known_hosts),
    )
    .await
    .map_err(|_| CmdError::connect(format!("连接超时 ({total_timeout}s)")))??;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let _ = session.close().await;
    Ok(elapsed_ms)
}

#[tauri::command]
async fn credentials_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Credential>, String> {
    let _guard = state.store_lock.read().await;
    credential_store(&app)?.load().map_err(|e| e.to_string())
}

#[tauri::command]
async fn credentials_upsert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut credential: Credential,
    secret: Option<String>,
) -> Result<Credential, String> {
    {
        let _guard = state.store_lock.write().await;
        let store = credential_store(&app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        credential.updated_at = now_unix_secs();
        if let Some(existing) = list.iter_mut().find(|c| c.id == credential.id) {
            *existing = credential.clone();
        } else {
            list.insert(0, credential.clone());
        }
        store.save(&list).map_err(|e| e.to_string())?;
    }
    if let Some(sec) = secret.filter(|s| !s.is_empty()) {
        let key = format!("cred:{}", credential.id);
        vault::persist_secret(&app, &state, &key, &sec).await?;
    }
    Ok(credential)
}

#[tauri::command]
async fn credentials_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效凭证 ID: {e}"))?;
    {
        let _guard = state.store_lock.write().await;
        let store = credential_store(&app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        list.retain(|c| c.id != uuid);
        store.save(&list).map_err(|e| e.to_string())?;
        sync_cmds::record_credential_deletion(&app, &uuid.to_string());
    }
    let key = format!("cred:{uuid}");
    let _ = vault::delete_secret(&app, &state, &key).await;
    Ok(())
}

fn server_store(app: &tauri::AppHandle) -> Result<ServerStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(ServerStore::new(data_dir.join("servers.json")))
}

pub(crate) fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn server_connection_changed(old: &Server, new: &Server) -> bool {
    old.host != new.host
        || old.port != new.port
        || old.username != new.username
        || old.protocol != new.protocol
        || old.auth != new.auth
        || old.auth_priority != new.auth_priority
        || old.jump_hosts != new.jump_hosts
        || old.timeout_secs != new.timeout_secs
        || old.keepalive_secs != new.keepalive_secs
        || old.term_type != new.term_type
}

#[tauri::command]
async fn servers_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    let _guard = state.store_lock.read().await;
    server_store(&app)?.load().map_err(|e| e.to_string())
}

#[tauri::command]
async fn servers_upsert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut server: Server,
) -> Result<(), String> {
    if server.host.trim().is_empty() {
        return Err("主机地址不能为空".to_string());
    }
    if server.port == 0 {
        return Err("端口号必须在 1-65535 之间".to_string());
    }
    let server_id = server.id;
    let should_evict = {
        let _guard = state.store_lock.write().await;
        let store = server_store(&app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        server.updated_at = now_unix_secs();
        let evict = if let Some(existing) = list.iter_mut().find(|s| s.id == server.id) {
            let changed = server_connection_changed(existing, &server);
            *existing = server;
            changed
        } else {
            list.insert(0, server);
            false
        };
        store.save(&list).map_err(|e| e.to_string())?;
        evict
    };
    if should_evict {
        state.evict_server_caches(&server_id).await;
    }
    Ok(())
}

#[tauri::command]
async fn servers_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效服务器 ID: {e}"))?;
    {
        let _guard = state.store_lock.write().await;
        let store = server_store(&app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        list.retain(|s| s.id != uuid);
        for other in &mut list {
            if other.jump_hosts.contains(&uuid) {
                other.jump_hosts.retain(|&hop| hop != uuid);
                other.updated_at = now_unix_secs();
            }
        }
        store.save(&list).map_err(|e| e.to_string())?;
        sync_cmds::record_server_deletion(&app, &uuid.to_string());
    }
    let _ = vault::delete_secret(&app, &state, &uuid.to_string()).await;
    state.evict_server_caches(&uuid).await;
    Ok(())
}

#[tauri::command]
async fn known_hosts_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    host_port: String,
) -> Result<bool, CmdError> {
    let store = load_known_hosts(&app, &state)?;
    let key = host_port.trim().to_string();
    tokio::task::spawn_blocking(move || store.remove(&key))
        .await
        .map_err(|e| CmdError::other(format!("移除 known_hosts 任务失败: {e}")))?
        .map_err(CmdError::from)
}

#[tauri::command]
async fn ssh_config_preview() -> Result<Vec<Server>, String> {
    let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) else {
        return Ok(Vec::new());
    };
    let path = std::path::PathBuf::from(home).join(".ssh").join("config");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let default_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_string());
    ssh_config::parse_file(&path, &default_user)
        .map_err(|e| format!("读取 ~/.ssh/config 失败: {e}"))
}

#[tauri::command]
async fn servers_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    servers: Vec<Server>,
    secrets: Option<HashMap<String, String>>,
) -> Result<usize, String> {
    let mut secrets_to_save: Vec<(String, String)> = Vec::new();
    let added = {
        let _guard = state.store_lock.write().await;
        let store = server_store(&app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        let mut added = 0usize;
        for mut srv in servers {
            if srv.host.trim().is_empty() || srv.port == 0 {
                continue;
            }
            let duplicate = list.iter().any(|existing| {
                existing.host == srv.host
                    && existing.port == srv.port
                    && existing.username == srv.username
                    && existing.protocol == srv.protocol
            });
            if duplicate {
                continue;
            }
            let orig_id = srv.id.to_string();
            if list.iter().any(|existing| existing.id == srv.id) {
                srv.id = Uuid::new_v4();
            }
            let final_id = srv.id.to_string();
            if let Some(sec) = secrets
                .as_ref()
                .and_then(|map| map.get(&orig_id))
                .filter(|s| !s.is_empty())
            {
                secrets_to_save.push((final_id, sec.clone()));
            }
            list.push(srv);
            added += 1;
        }
        if added > 0 {
            store.save(&list).map_err(|e| e.to_string())?;
        }
        added
    };
    for (sid, secret) in secrets_to_save {
        let _ = vault::persist_secret(&app, &state, &sid, &secret).await;
    }
    Ok(added)
}

fn close_session_bg(session: SshSession) {
    tokio::spawn(async move {
        let _ = session.close().await;
    });
}

fn monitor_target_signature(cfg: &SshConnectInput) -> String {
    let auth_tag = match &cfg.auth {
        SshAuthInput::Password { .. } => "password".to_string(),
        SshAuthInput::Key { path, .. } => format!("key:{path}"),
        SshAuthInput::Credential { credential_id, .. } => format!("cred:{credential_id}"),
        SshAuthInput::KeyboardInteractive { .. } => "kbint".to_string(),
        SshAuthInput::Ask { key_path, .. } => {
            format!("ask:{}", key_path.as_deref().unwrap_or(""))
        }
    };
    format!(
        "{}:{}:{}|{:?}|{:?}|{:?}|{}",
        cfg.host.trim().to_ascii_lowercase(),
        cfg.port,
        cfg.username.trim(),
        cfg.jump_hosts,
        cfg.timeout_secs,
        cfg.keepalive_secs,
        auth_tag
    )
}

async fn connect_monitor_session(
    state: &AppState,
    connect_cfg: ConnectConfig,
    known_hosts: KnownHostsStore,
) -> Result<SshSession, CmdError> {
    let _permit = tokio::time::timeout(Duration::from_secs(20), state.connect_semaphore.acquire())
        .await
        .map_err(|_| CmdError::connect("并发连接排队超时，请稍后重试"))?
        .map_err(|_| CmdError::other("连接信号量异常"))?;

    let total_timeout = connect_cfg
        .timeout_secs
        .unwrap_or(10)
        .clamp(1, 300)
        .saturating_mul((connect_cfg.jump_hosts.len() as u64) + 1)
        .saturating_add(4);

    tokio::time::timeout(
        Duration::from_secs(total_timeout),
        SshSession::connect(connect_cfg, known_hosts),
    )
    .await
    .map_err(|_| CmdError::connect(format!("连接超时 ({total_timeout}s)")))?
    .map_err(CmdError::from)
}

#[tauri::command]
async fn monitor_poll(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    cfg: SshConnectInput,
) -> Result<ServerStats, CmdError> {
    let server_id = cfg
        .server_id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CmdError::other("缺少 server_id"))?;
    let target_sig = monitor_target_signature(&cfg);

    let entry_arc = {
        if let Some(existing) = state.monitor_entries.read().await.get(&server_id) {
            Arc::clone(existing)
        } else {
            let mut map = state.monitor_entries.write().await;
            Arc::clone(map.entry(server_id.clone()).or_insert_with(|| {
                Arc::new(Mutex::new(MonitorEntry {
                    target_sig: target_sig.clone(),
                    session: None,
                    prev: None,
                    last_used: Instant::now(),
                }))
            }))
        }
    };

    // Single-flight guard: never stack duplicate polls on the same server's mutex.
    let Ok(mut entry) = entry_arc.try_lock() else {
        return Err(CmdError::busy());
    };
    entry.last_used = Instant::now();

    if entry.target_sig != target_sig {
        if let Some(old) = entry.session.take() {
            close_session_bg(old);
        }
        entry.prev = None;
        entry.target_sig = target_sig;
    }

    let host_for_ping = strip_ipv6_brackets(&cfg.host).to_ascii_lowercase();
    let is_lan = is_private_host(&host_for_ping);
    let mut reused_session = entry.session.is_some();

    if entry.session.is_none() {
        let known_hosts = load_known_hosts(&app, &state)?;
        let connect_res = match resolve_input_connect_config(&app, &state, &cfg, true).await {
            Ok((connect_cfg, _)) => connect_monitor_session(&state, connect_cfg, known_hosts).await,
            Err(err) => Err(err),
        };
        match connect_res {
            Ok(session) => entry.session = Some(session),
            Err(err) => {
                let is_empty = entry.session.is_none() && entry.prev.is_none();
                drop(entry);
                if is_empty {
                    let mut map = state.monitor_entries.write().await;
                    if map
                        .get(&server_id)
                        .is_some_and(|cur| Arc::ptr_eq(cur, &entry_arc))
                    {
                        map.remove(&server_id);
                    }
                }
                return Err(err);
            }
        }
    }

    let (icmp_ms, mut probe_res, mut ssh_rtt_ms) = {
        let session = entry.session.as_ref().expect("session just initialized");
        let ping_host = host_for_ping.clone();
        let ping_sem = Arc::clone(&state.ping_semaphore);
        let icmp_cache = Arc::clone(&state.icmp_cache);
        let (ping_tx, ping_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let val = if !is_valid_ping_host(&ping_host) {
                None
            } else {
                let cached = {
                    let cache = icmp_cache.read().await;
                    cache
                        .get(&ping_host)
                        .filter(|(_, at)| at.elapsed() < ICMP_CACHE_TTL)
                        .map(|(v, _)| *v)
                };
                if let Some(v) = cached {
                    v
                } else if let Ok(_permit) = ping_sem.try_acquire() {
                    let cached_after = {
                        let cache = icmp_cache.read().await;
                        cache
                            .get(&ping_host)
                            .filter(|(_, at)| at.elapsed() < ICMP_CACHE_TTL)
                            .map(|(v, _)| *v)
                    };
                    if let Some(v) = cached_after {
                        v
                    } else {
                        let measured = icmp_ping_ms(&ping_host).await;
                        let mut cache = icmp_cache.write().await;
                        if cache.len() >= ICMP_CACHE_MAX_ENTRIES {
                            cache.retain(|_, (_, at)| at.elapsed() < ICMP_CACHE_TTL);
                            if cache.len() >= ICMP_CACHE_MAX_ENTRIES {
                                cache.clear();
                            }
                        }
                        cache.insert(ping_host, (measured, Instant::now()));
                        measured
                    }
                } else {
                    None
                }
            };
            let _ = ping_tx.send(val);
        });
        let start = Instant::now();
        let res = session.exec(PROBE_CMD, Duration::from_secs(6)).await;
        let rtt = res
            .as_ref()
            .ok()
            .map(|_| start.elapsed().as_secs_f64() * 1000.0);
        // Never abort the background ping task: if it takes > 80ms, let it finish updating
        // icmp_cache so subsequent monitor polls get an immediate cache hit.
        let icmp = tokio::time::timeout(Duration::from_millis(80), ping_rx)
            .await
            .ok()
            .and_then(Result::ok)
            .flatten();
        (icmp, res, rtt)
    };

    // If a reused idle SSH session was dropped by NAT/firewall, transparently reconnect once.
    if probe_res.is_err() && reused_session {
        reused_session = false;
        let _ = reused_session;
        if let Some(s) = entry.session.take() {
            close_session_bg(s);
        }
        let known_hosts = load_known_hosts(&app, &state)?;
        let (connect_cfg, _) = resolve_input_connect_config(&app, &state, &cfg, true).await?;
        let session = connect_monitor_session(&state, connect_cfg, known_hosts).await?;
        let start = Instant::now();
        probe_res = session.exec(PROBE_CMD, Duration::from_secs(6)).await;
        ssh_rtt_ms = probe_res
            .as_ref()
            .ok()
            .map(|_| start.elapsed().as_secs_f64() * 1000.0);
        entry.session = Some(session);
    }

    let latency_ms = match (icmp_ms, ssh_rtt_ms) {
        (Some(icmp), Some(ssh)) if !is_lan && icmp < 4.0 && ssh > 8.0 => Some(ssh),
        (Some(icmp), _) => Some(icmp),
        (None, Some(ssh)) => Some(ssh),
        (None, None) => None,
    };

    let output = match probe_res {
        Ok((out, _code)) => out,
        Err(e) => {
            if let Some(s) = entry.session.take() {
                close_session_bg(s);
            }
            entry.prev = None;
            return Err(CmdError::connect(e.to_string()));
        }
    };

    let cur = match RawSnapshot::parse(&output) {
        Ok(snap) => snap,
        Err(e) => {
            entry.prev = None;
            return Err(CmdError::other(e.to_string()));
        }
    };
    let now = Instant::now();
    let stats = match entry.prev.as_ref() {
        Some((prev_snap, prev_at)) => ServerStats::compute(
            Some(prev_snap),
            &cur,
            now.duration_since(*prev_at).as_secs_f64(),
            latency_ms,
        ),
        None => ServerStats::compute(None, &cur, 0.0, latency_ms),
    };
    entry.prev = Some((cur, now));
    Ok(stats)
}

#[tauri::command]
async fn monitor_stop(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<(), CmdError> {
    let entry_arc = state.monitor_entries.write().await.remove(&server_id);
    if let Some(arc) = entry_arc {
        tokio::spawn(async move {
            let mut entry = arc.lock().await;
            entry.prev = None;
            if let Some(session) = entry.session.take() {
                close_session_bg(session);
            }
        });
    }
    Ok(())
}

#[derive(Serialize)]
struct BridgeOpenOutput {
    bridge_id: String,
    ws_url: String,
}

#[tauri::command]
async fn bridge_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    host: String,
    port: u16,
    protocol: Protocol,
) -> Result<BridgeOpenOutput, CmdError> {
    let mode = match protocol {
        Protocol::Vnc => BridgeMode::Tcp,
        Protocol::Rdp => BridgeMode::RdCleanPath,
        Protocol::Ssh => {
            return Err(CmdError::other("SSH protocol does not use bridge_open"));
        }
    };

    let target_host = host.trim().to_string();
    if target_host.is_empty() || port == 0 {
        return Err(CmdError::other("无效的目标主机或端口"));
    }

    // Only allow opening local VNC/RDP bridges to servers explicitly configured in ServerStore.
    let target_allowed = {
        let _guard = state.store_lock.read().await;
        let list = server_store(&app)
            .map_err(CmdError::other)?
            .load()
            .map_err(|e| CmdError::other(e.to_string()))?;
        list.iter().any(|s| {
            s.protocol == protocol
                && s.port == port
                && s.host.trim().eq_ignore_ascii_case(&target_host)
        })
    };
    if !target_allowed {
        return Err(CmdError::other(
            "目标未在服务器列表中配置，拒绝建立代理桥接",
        ));
    }

    if state.bridges.lock().await.len() >= MAX_ACTIVE_BRIDGES {
        return Err(CmdError::other(format!(
            "同时打开的桌面桥接连接已达上限 ({MAX_ACTIVE_BRIDGES})"
        )));
    }

    let cert_pin_checker: Option<CertPinChecker> = if protocol == Protocol::Rdp {
        let store = load_known_hosts(&app, &state)?;
        Some(Arc::new(move |host_key: &str, fp: &str| {
            // `host_key` from serverhub_bridge is already prefixed as `rdp:<host>:<port>`.
            match store.trust_if_unknown(host_key, fp) {
                Ok(HostKeyStatus::Known) => Ok(()),
                Ok(HostKeyStatus::Mismatch { expected }) => Err(format!(
                    "RDP 服务器证书指纹变更 ({host_key}): 预期 {expected}, 实际 {fp}"
                )),
                Ok(HostKeyStatus::Unknown) => Err(format!("无法信任 RDP 证书 ({host_key})")),
                Err(e) => Err(e.to_string()),
            }
        }))
    } else {
        None
    };

    let mut handle = start_bridge(target_host, port, mode, cert_pin_checker)
        .await
        .map_err(|e| CmdError::connect(e.to_string()))?;
    let id = handle.id;
    let bridge_id = id.to_string();
    let ws_url = handle.ws_url.clone();
    let done_rx = handle.take_done_rx();
    state.bridges.lock().await.insert(id, handle);
    if let Some(rx) = done_rx {
        let bridges = Arc::clone(&state.bridges);
        tokio::spawn(async move {
            let _ = rx.await;
            bridges.lock().await.remove(&id);
        });
    }
    Ok(BridgeOpenOutput { bridge_id, ws_url })
}

#[tauri::command]
async fn bridge_close(
    state: tauri::State<'_, AppState>,
    bridge_id: String,
) -> Result<(), CmdError> {
    if let Ok(uuid) = Uuid::parse_str(&bridge_id)
        && let Some(mut handle) = state.bridges.lock().await.remove(&uuid)
    {
        handle.close();
    }
    Ok(())
}

fn is_private_v4(v4: std::net::Ipv4Addr) -> bool {
    let octets = v4.octets();
    let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 64;
    let is_benchmark = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || is_cgnat
        || is_benchmark
}

fn is_private_host(host: &str) -> bool {
    let h = strip_ipv6_brackets(host).to_ascii_lowercase();
    if h.is_empty()
        || h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".lan")
        || h.ends_with(".home.arpa")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => is_private_v4(v4),
            std::net::IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return is_private_v4(v4);
                }
                let seg0 = v6.segments()[0];
                let is_link_local = (seg0 & 0xffc0) == 0xfe80;
                v6.is_loopback()
                    || v6.is_unique_local()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || is_link_local
            }
        };
    }
    // Single-label hostnames (no dot and not an IP) are local/LAN names, never query external GeoIP.
    !h.contains('.')
}

fn is_valid_geo_host(host: &str) -> bool {
    let h = strip_ipv6_brackets(host);
    !h.is_empty()
        && h.len() <= 255
        && h != "."
        && h != ".."
        && !h.contains("..")
        && !h.starts_with('.')
        && !h.ends_with('.')
        && !h.starts_with('-')
        && !h.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(
                    c,
                    '?' | '#' | '/' | '\\' | '@' | '%' | '&' | '=' | '[' | ']'
                )
        })
}

fn encode_url_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b':' => {
                out.push(*b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(&mut out, "%{b:02X}");
            }
        }
    }
    out
}

fn geo_cache_entry_valid(val: &Option<GeoInfo>, inserted_at: Instant) -> bool {
    let ttl = if val.is_some() {
        GEO_SUCCESS_CACHE_TTL
    } else {
        GEO_FAILURE_CACHE_TTL
    };
    inserted_at.elapsed() < ttl
}

async fn insert_geo_cache(state: &AppState, key: String, val: Option<GeoInfo>) {
    let mut cache = state.geo_cache.write().await;
    if cache.len() >= GEO_CACHE_MAX_ENTRIES {
        cache.retain(|_, (v, at)| geo_cache_entry_valid(v, *at));
        if cache.len() >= GEO_CACHE_MAX_ENTRIES {
            cache.clear();
        }
    }
    cache.insert(key, (val, Instant::now()));
}

#[tauri::command]
async fn geo_lookup(
    state: tauri::State<'_, AppState>,
    host: String,
) -> Result<Option<GeoInfo>, String> {
    let key = strip_ipv6_brackets(&host).to_ascii_lowercase();
    if !is_valid_geo_host(&key) {
        return Ok(None);
    }
    if is_private_host(&key) {
        return Ok(Some(GeoInfo {
            country_code: "LOCAL".to_string(),
            label: "内网".to_string(),
        }));
    }
    if let Some((cached, at)) = state.geo_cache.read().await.get(&key).cloned()
        && geo_cache_entry_valid(&cached, at)
    {
        return Ok(cached);
    }

    let _permit = state
        .geo_semaphore
        .acquire()
        .await
        .map_err(|_| "geo_lookup 信号量异常".to_string())?;
    if let Some((cached, at)) = state.geo_cache.read().await.get(&key).cloned()
        && geo_cache_entry_valid(&cached, at)
    {
        return Ok(cached);
    }

    let encoded_host = encode_url_path_segment(&key);
    let url = format!(
        "http://ip-api.com/json/{encoded_host}?lang=zh-CN&fields=status,country,countryCode,regionName,city"
    );
    let resp = state
        .http_client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        insert_geo_cache(&state, key, None).await;
        return Ok(None);
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if val.get("status").and_then(|s| s.as_str()) != Some("success") {
        insert_geo_cache(&state, key, None).await;
        return Ok(None);
    }

    let raw_cc = val
        .get("countryCode")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    let country = val.get("country").and_then(|s| s.as_str()).unwrap_or("");
    let city = val.get("city").and_then(|s| s.as_str()).unwrap_or("");

    let (country_code, label) =
        if raw_cc == "TW" || country.contains("台湾") || country.contains("Taiwan") {
            ("CN".to_string(), "中国台湾".to_string())
        } else if raw_cc == "HK" {
            ("CN".to_string(), "中国香港".to_string())
        } else if raw_cc == "MO" {
            ("CN".to_string(), "中国澳门".to_string())
        } else if raw_cc == "CN" {
            let lbl = if !city.is_empty() {
                format!("中国·{city}")
            } else {
                "中国".to_string()
            };
            ("CN".to_string(), lbl)
        } else {
            let lbl = if !country.is_empty() {
                country.to_string()
            } else {
                raw_cc.clone()
            };
            (raw_cc, lbl)
        };

    if country_code.is_empty() || label.is_empty() {
        insert_geo_cache(&state, key, None).await;
        return Ok(None);
    }

    let info = GeoInfo {
        country_code,
        label,
    };
    insert_geo_cache(&state, key, Some(info.clone())).await;
    Ok(Some(info))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                mcp::init_on_startup(handle).await;
            });

            let reaper_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(60));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    let state = reaper_handle.state::<AppState>();
                    state.reap_idle_resources().await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_close,
            bridge_open,
            bridge_close,
            secret_save,
            secret_get,
            secret_delete,
            secret_set,
            secret_forget,
            clipboard_write,
            ssh_ping,
            ssh_test,
            servers_list,
            servers_upsert,
            servers_delete,
            known_hosts_remove,
            credentials_list,
            credentials_upsert,
            credentials_delete,
            ssh_config_preview,
            servers_import,
            monitor_poll,
            monitor_stop,
            ai_cmds::ai_profiles_list,
            ai_cmds::ai_profiles_upsert,
            ai_cmds::ai_profiles_delete,
            ai_cmds::ai_profiles_set_default,
            ai_cmds::ai_test_connection,
            ai_cmds::ai_list_models,
            ai_cmds::ai_chat_stream,
            ai_cmds::ai_chat_cancel,
            sync_cmds::sync_config_get,
            sync_cmds::sync_config_save,
            sync_cmds::sync_detect_clouds,
            sync_cmds::sync_test_connection,
            sync_cmds::sync_push,
            sync_cmds::sync_pull,
            sync_cmds::sync_now,
            sync_cmds::sync_oauth_authorize,
            mcp::mcp_get_state,
            mcp::mcp_save_config,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_regenerate_token,
            mcp::mcp_clear_logs,
            geo_lookup
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(3), state.shutdown_all()).await;
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_host_validation_blocks_flag_and_shell_injection() {
        assert!(is_valid_ping_host("192.168.1.10"));
        assert!(is_valid_ping_host("prod-01.example.com"));
        assert!(is_valid_ping_host("2001:db8::1"));
        assert!(!is_valid_ping_host(""));
        assert!(!is_valid_ping_host("-f"));
        assert!(!is_valid_ping_host("--help"));
        assert!(!is_valid_ping_host("1.1.1.1; rm -rf /"));
        assert!(!is_valid_ping_host("host\nname"));
    }

    #[test]
    fn parse_icmp_time_handles_locales() {
        assert_eq!(
            parse_icmp_time_ms("64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=12.4 ms"),
            Some(12.4)
        );
        assert_eq!(
            parse_icmp_time_ms("来自 1.1.1.1 的回复: 字节=32 时间<1ms TTL=57"),
            Some(1.0)
        );
        assert_eq!(parse_icmp_time_ms("time=NaN ms"), None);
        assert_eq!(parse_icmp_time_ms("time=inf ms"), None);
        assert_eq!(parse_icmp_time_ms("time=-5.0 ms"), None);
    }

    #[test]
    fn private_and_geo_host_validation_covers_ipv6_cgnat_and_traversal() {
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("100.64.0.1"));
        assert!(is_private_host("[::1]"));
        assert!(is_private_host("fe80::1"));
        assert!(is_private_host("::ffff:127.0.0.1"));
        assert!(is_private_host("intranet"));
        assert!(is_private_host("db.internal"));
        assert!(!is_private_host("1.1.1.1"));
        assert!(!is_private_host("prod.example.com"));

        assert!(!is_valid_geo_host("."));
        assert!(!is_valid_geo_host(".."));
        assert!(!is_valid_geo_host("a..b"));
        assert!(is_valid_geo_host("1.1.1.1"));
        assert!(is_valid_geo_host("[2001:4860:4860::8888]"));
    }
}
