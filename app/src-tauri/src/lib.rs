use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serverhub_core::{Server, ServerStore, ssh_config};
use serverhub_monitor::{PROBE_CMD, RawSnapshot, ServerStats};
use serverhub_ssh::{
    Auth, ConnectConfig, KnownHostsStore, ShellEvent, ShellHandle, SshError, SshSession,
};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.serverhub.app";

struct SessionEntry {
    shell: ShellHandle,
    session: SshSession,
}

struct MonitorEntry {
    session: Option<SshSession>,
    prev: Option<(RawSnapshot, Instant)>,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<Uuid, SessionEntry>>>,
    store_lock: Mutex<()>,
    secret_cache: Mutex<HashMap<String, String>>,
    monitor_entries: Mutex<HashMap<String, Arc<Mutex<MonitorEntry>>>>,
}

#[derive(Debug, Serialize)]
struct CmdError {
    kind: String,
    message: String,
    fingerprint: Option<String>,
    expected: Option<String>,
}

impl CmdError {
    fn auth(message: impl Into<String>) -> Self {
        Self {
            kind: "auth".to_string(),
            message: message.into(),
            fingerprint: None,
            expected: None,
        }
    }

    fn connect(message: impl Into<String>) -> Self {
        Self {
            kind: "connect".to_string(),
            message: message.into(),
            fingerprint: None,
            expected: None,
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self {
            kind: "other".to_string(),
            message: message.into(),
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
                fingerprint: Some(got),
                expected: Some(expected),
            },
            SshError::Auth(msg) | SshError::KeyLoad(msg) => Self::auth(msg),
            SshError::Connect(msg) => Self::connect(msg),
            other => Self::other(other.to_string()),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SshAuthInput {
    Password {
        #[serde(default)]
        password: Option<String>,
    },
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

#[derive(Deserialize)]
struct SshConnectInput {
    server_id: Option<String>,
    host: String,
    port: u16,
    username: String,
    auth: SshAuthInput,
    accept_host_key: Option<String>,
}

fn load_known_hosts(app: &tauri::AppHandle) -> Result<KnownHostsStore, CmdError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CmdError::other(format!("无法获取应用数据目录: {e}")))?;
    KnownHostsStore::load_or_create(data_dir.join("known_hosts.json")).map_err(CmdError::from)
}

async fn resolve_secret(state: &AppState, server_id: &str) -> Option<String> {
    if let Some(cached) = state.secret_cache.lock().await.get(server_id).cloned()
        && !cached.is_empty()
    {
        return Some(cached);
    }

    let id = server_id.to_string();
    let found = tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &id).ok()?;
        entry.get_password().ok()
    })
    .await
    .ok()
    .flatten()
    .filter(|s| !s.is_empty());

    if let Some(ref val) = found {
        state
            .secret_cache
            .lock()
            .await
            .insert(server_id.to_string(), val.clone());
    }
    found
}

async fn persist_secret(state: &AppState, server_id: &str, secret: &str) -> Result<(), CmdError> {
    {
        let mut cache = state.secret_cache.lock().await;
        if secret.is_empty() {
            cache.remove(server_id);
        } else {
            cache.insert(server_id.to_string(), secret.to_string());
        }
    }

    let id = server_id.to_string();
    let val = secret.to_string();
    tokio::task::spawn_blocking(move || secret_save(id, val))
        .await
        .map_err(|e| CmdError::other(e.to_string()))?
        .map_err(CmdError::other)
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
    let known_hosts = load_known_hosts(&app)?;

    let mut provided_secret: Option<String> = None;
    let auth = match cfg.auth {
        SshAuthInput::Password { password } => {
            let pw = match password.filter(|p| !p.is_empty()) {
                Some(p) => {
                    provided_secret = Some(p.clone());
                    p
                }
                None => {
                    if let Some(sid) = cfg.server_id.as_deref() {
                        resolve_secret(&state, sid)
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
            let resolved_passphrase = match passphrase.filter(|p| !p.is_empty()) {
                Some(p) => {
                    provided_secret = Some(p.clone());
                    Some(p)
                }
                None => {
                    if let Some(sid) = cfg.server_id.as_deref() {
                        resolve_secret(&state, sid).await
                    } else {
                        None
                    }
                }
            };
            Auth::Key {
                path,
                passphrase: resolved_passphrase,
            }
        }
    };

    let connect_cfg = ConnectConfig {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth,
        accept_host_key: cfg.accept_host_key,
    };

    let session = SshSession::connect(connect_cfg, known_hosts).await?;

    if let (Some(sid), Some(secret)) = (cfg.server_id.as_ref(), provided_secret) {
        let _ = persist_secret(&state, sid, &secret).await;
    }

    let (shell, mut rx) = session.open_shell(cols.max(1), rows.max(1)).await?;

    let id = Uuid::new_v4();
    {
        let mut guard = state.sessions.lock().await;
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
            let mapped = match evt {
                ShellEvent::Data(bytes) => TermEvent::Data(bytes),
                ShellEvent::Exit(code) => TermEvent::Exit(code),
                ShellEvent::Closed => {
                    let _ = on_event.send(TermEvent::Closed);
                    break;
                }
            };
            if on_event.send(mapped).is_err() {
                break;
            }
        }
        let mut guard = sessions.lock().await;
        if let Some(entry) = guard.remove(&id) {
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
        let guard = state.sessions.lock().await;
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
        let guard = state.sessions.lock().await;
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
        let mut guard = state.sessions.lock().await;
        guard.remove(&uuid)
    };
    if let Some(entry) = entry {
        let _ = entry.shell.close().await;
        let _ = entry.session.close().await;
    }
    Ok(())
}

#[tauri::command]
async fn secret_set(
    state: tauri::State<'_, AppState>,
    server_id: String,
    password: String,
) -> Result<(), CmdError> {
    persist_secret(&state, &server_id, &password).await
}

#[tauri::command]
async fn secret_forget(
    state: tauri::State<'_, AppState>,
    server_id: String,
) -> Result<(), CmdError> {
    state.secret_cache.lock().await.remove(&server_id);
    tokio::task::spawn_blocking(move || secret_delete(server_id))
        .await
        .map_err(|e| CmdError::other(e.to_string()))?
        .map_err(CmdError::other)
}

#[tauri::command]
fn secret_save(id: String, secret: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &id).map_err(|e| e.to_string())?;
    if secret.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(&secret).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn secret_get(id: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(id: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn ssh_ping(host: String, port: u16) -> Result<u64, String> {
    let start = Instant::now();
    let res = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await;
    match res {
        Ok(Ok(_stream)) => Ok(start.elapsed().as_millis() as u64),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("超时".to_string()),
    }
}

#[tauri::command]
async fn ssh_test(app: tauri::AppHandle, cfg: SshConnectInput) -> Result<u64, CmdError> {
    let known_hosts = load_known_hosts(&app)?;
    let auth = match cfg.auth {
        SshAuthInput::Password { password } => Auth::Password(password.unwrap_or_default()),
        SshAuthInput::Key { path, passphrase } => Auth::Key { path, passphrase },
    };
    let connect_cfg = ConnectConfig {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth,
        accept_host_key: cfg.accept_host_key,
    };
    let start = Instant::now();
    let session = tokio::time::timeout(
        Duration::from_secs(10),
        SshSession::connect(connect_cfg, known_hosts),
    )
    .await
    .map_err(|_| CmdError::connect("连接超时 (10s)"))??;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let _ = session.close().await;
    Ok(elapsed_ms)
}

fn server_store(app: &tauri::AppHandle) -> Result<ServerStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(ServerStore::new(data_dir.join("servers.json")))
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
async fn servers_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    let _guard = state.store_lock.lock().await;
    server_store(&app)?.load().map_err(|e| e.to_string())
}

#[tauri::command]
async fn servers_upsert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut server: Server,
) -> Result<(), String> {
    let _guard = state.store_lock.lock().await;
    let store = server_store(&app)?;
    let mut list = store.load().map_err(|e| e.to_string())?;
    server.updated_at = now_unix_secs();
    if let Some(existing) = list.iter_mut().find(|s| s.id == server.id) {
        *existing = server;
    } else {
        list.insert(0, server);
    }
    store.save(&list).map_err(|e| e.to_string())
}

#[tauri::command]
async fn servers_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效服务器 ID: {e}"))?;
    let _guard = state.store_lock.lock().await;
    let store = server_store(&app)?;
    let mut list = store.load().map_err(|e| e.to_string())?;
    list.retain(|s| s.id != uuid);
    store.save(&list).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_config_preview() -> Result<Vec<Server>, String> {
    let Ok(home) = std::env::var("HOME") else {
        return Ok(Vec::new());
    };
    let path = std::path::PathBuf::from(home).join(".ssh").join("config");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 ~/.ssh/config 失败: {e}"))?;
    let default_user = std::env::var("USER").unwrap_or_else(|_| "root".to_string());
    Ok(ssh_config::parse(&content, &default_user))
}

#[tauri::command]
async fn servers_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    servers: Vec<Server>,
) -> Result<usize, String> {
    let _guard = state.store_lock.lock().await;
    let store = server_store(&app)?;
    let mut list = store.load().map_err(|e| e.to_string())?;
    let mut added = 0usize;
    for srv in servers {
        let duplicate = list.iter().any(|existing| {
            existing.host == srv.host
                && existing.port == srv.port
                && existing.username == srv.username
        });
        if !duplicate {
            list.push(srv);
            added += 1;
        }
    }
    if added > 0 {
        store.save(&list).map_err(|e| e.to_string())?;
    }
    Ok(added)
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

    let entry_arc = {
        let mut map = state.monitor_entries.lock().await;
        Arc::clone(map.entry(server_id.clone()).or_insert_with(|| {
            Arc::new(Mutex::new(MonitorEntry {
                session: None,
                prev: None,
            }))
        }))
    };

    let mut entry = entry_arc.lock().await;

    let ping_start = Instant::now();
    let latency_ms = match tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect((cfg.host.as_str(), cfg.port)),
    )
    .await
    {
        Ok(Ok(_stream)) => Some(ping_start.elapsed().as_secs_f64() * 1000.0),
        _ => None,
    };

    if entry.session.is_none() {
        let known_hosts = load_known_hosts(&app)?;
        let auth = match cfg.auth {
            SshAuthInput::Password { password } => {
                let pw = match password.filter(|p| !p.is_empty()) {
                    Some(p) => p,
                    None => resolve_secret(&state, &server_id)
                        .await
                        .ok_or_else(|| CmdError::auth("需要密码"))?,
                };
                Auth::Password(pw)
            }
            SshAuthInput::Key { path, passphrase } => {
                let resolved = match passphrase.filter(|p| !p.is_empty()) {
                    Some(p) => Some(p),
                    None => resolve_secret(&state, &server_id).await,
                };
                Auth::Key {
                    path,
                    passphrase: resolved,
                }
            }
        };

        let connect_cfg = ConnectConfig {
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            auth,
            accept_host_key: cfg.accept_host_key,
        };
        let session = SshSession::connect(connect_cfg, known_hosts).await?;
        entry.session = Some(session);
    }

    let output = {
        let session = entry.session.as_ref().expect("session just initialized");
        match session.exec(PROBE_CMD, Duration::from_secs(8)).await {
            Ok((out, _code)) => out,
            Err(e) => {
                if let Some(s) = entry.session.take() {
                    let _ = s.close().await;
                }
                entry.prev = None;
                return Err(CmdError::connect(e.to_string()));
            }
        }
    };

    let cur = RawSnapshot::parse(&output).map_err(|e| CmdError::other(e.to_string()))?;
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
    let entry_arc = state.monitor_entries.lock().await.remove(&server_id);
    if let Some(arc) = entry_arc {
        let mut entry = arc.lock().await;
        entry.prev = None;
        if let Some(session) = entry.session.take() {
            let _ = session.close().await;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_open,
            ssh_write,
            ssh_resize,
            ssh_close,
            secret_save,
            secret_get,
            secret_delete,
            secret_set,
            secret_forget,
            ssh_ping,
            ssh_test,
            servers_list,
            servers_upsert,
            servers_delete,
            ssh_config_preview,
            servers_import,
            monitor_poll,
            monitor_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
