pub mod server;
pub mod tools;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rand::RngCore;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use serverhub_ssh::{ShellHandle, SshSession};
use tauri::Manager;
use tokio::sync::{Mutex, RwLock, watch};

use crate::{AppState, now_unix_secs, vault};

const CONFIG_FILENAME: &str = "mcp_config.json";
const SECRET_MCP_TOKEN: &str = "mcp:bearer_token";
const MAX_LOG_ENTRIES: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceSettings {
    /// Local default working directory for relative paths in file transfers.
    pub local_workspace_dir: String,
    /// Optional default server ID or name when a tool call omits server_id.
    pub default_server_id: Option<String>,
    /// Optional default server group filter/assignment.
    pub default_group: Option<String>,
    /// Default remote working directory (e.g. "~" or "/opt/app").
    pub default_remote_dir: String,
    /// Optional whitelist of local root directories allowed for file transfer.
    /// Empty means unrestricted (any readable/writable local path).
    pub allowed_local_roots: Vec<String>,
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        Self {
            local_workspace_dir: home,
            default_server_id: None,
            default_group: None,
            default_remote_dir: "~".to_string(),
            allowed_local_roots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct McpConfig {
    /// Whether the MCP server is enabled (persisted; auto-starts on app launch if true).
    pub enabled: bool,
    /// Bind host (default 127.0.0.1).
    pub host: String,
    /// Bind port (default 17890).
    pub port: u16,
    /// Require Bearer token authentication on MCP endpoints.
    pub require_auth: bool,
    /// Allow modifying workspace settings and server records.
    pub allow_workspace_write: bool,
    /// Allow executing SSH commands and interactive shell sessions.
    pub allow_ssh_exec: bool,
    /// Allow remote file read/write/delete/search operations.
    pub allow_remote_files: bool,
    /// Allow local <-> remote and server <-> server file transfers.
    pub allow_file_transfer: bool,
    /// Automatically trust unknown SSH host keys on first connect (still rejects mismatches).
    pub auto_accept_unknown_host_keys: bool,
    /// Workspace-level settings accessible and configurable via MCP.
    pub workspace: WorkspaceSettings,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "127.0.0.1".to_string(),
            port: 17890,
            require_auth: true,
            allow_workspace_write: true,
            allow_ssh_exec: true,
            allow_remote_files: true,
            allow_file_transfer: true,
            auto_accept_unknown_host_keys: false,
            workspace: WorkspaceSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpLogEntry {
    pub id: u64,
    pub timestamp: i64,
    pub tool: String,
    pub summary: String,
    pub ok: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub running: bool,
    pub bind_url: String,
    pub sse_url: String,
    pub active_clients: usize,
    pub active_ssh_sessions: usize,
    pub total_requests: u64,
    pub last_error: Option<String>,
    pub recent_logs: Vec<McpLogEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatePayload {
    pub config: McpConfig,
    pub status: McpStatus,
    pub token: String,
}

pub struct McpShellSession {
    pub id: String,
    pub server_id: String,
    pub server_name: String,
    pub shell: ShellHandle,
    pub session: SshSession,
    pub buffer: Arc<Mutex<Vec<u8>>>,
    pub closed: Arc<std::sync::atomic::AtomicBool>,
    pub created_at: i64,
    pub last_used: Arc<Mutex<Instant>>,
}

pub struct PooledSshEntry {
    pub session: Arc<SshSession>,
    pub last_used: Instant,
}

pub struct McpRuntime {
    pub config: RwLock<McpConfig>,
    pub token: RwLock<String>,
    pub lifecycle_lock: Mutex<()>,
    pub shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    pub server_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub bound_addr: Mutex<Option<String>>,
    pub last_error: Mutex<Option<String>>,
    pub active_clients: AtomicUsize,
    pub total_requests: AtomicU64,
    pub log_seq: AtomicU64,
    pub logs: Mutex<VecDeque<McpLogEntry>>,
    pub shell_sessions: Mutex<HashMap<String, McpShellSession>>,
    pub ssh_pool: RwLock<HashMap<String, Arc<Mutex<Option<PooledSshEntry>>>>>,
    pub stats_prev: Mutex<HashMap<String, (serverhub_monitor::RawSnapshot, Instant)>>,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            config: RwLock::new(McpConfig::default()),
            token: RwLock::new(String::new()),
            lifecycle_lock: Mutex::new(()),
            shutdown_tx: Mutex::new(None),
            server_task: Mutex::new(None),
            bound_addr: Mutex::new(None),
            last_error: Mutex::new(None),
            active_clients: AtomicUsize::new(0),
            total_requests: AtomicU64::new(0),
            log_seq: AtomicU64::new(1),
            logs: Mutex::new(VecDeque::with_capacity(MAX_LOG_ENTRIES)),
            shell_sessions: Mutex::new(HashMap::new()),
            ssh_pool: RwLock::new(HashMap::new()),
            stats_prev: Mutex::new(HashMap::new()),
        }
    }
}

impl McpRuntime {
    pub fn dec_active_clients(&self) {
        let mut cur = self.active_clients.load(Ordering::Relaxed);
        while cur > 0 {
            match self.active_clients.compare_exchange_weak(
                cur,
                cur - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(next) => cur = next,
            }
        }
    }

    pub async fn evict_pooled_ssh(&self, server_id: &str) {
        self.stats_prev.lock().await.remove(server_id);
        let entry_arc = {
            let mut guard = self.ssh_pool.write().await;
            guard.remove(server_id)
        };
        if let Some(arc) = entry_arc {
            tokio::spawn(async move {
                if let Some(entry) = arc.lock().await.take() {
                    let _ = entry.session.close().await;
                }
            });
        }
    }

    pub async fn evict_all_pooled_ssh(&self) {
        self.stats_prev.lock().await.clear();
        let pool_arcs: Vec<Arc<Mutex<Option<PooledSshEntry>>>> = {
            let mut guard = self.ssh_pool.write().await;
            guard.drain().map(|(_, v)| v).collect()
        };
        for arc in pool_arcs {
            tokio::spawn(async move {
                if let Some(entry) = arc.lock().await.take() {
                    let _ = entry.session.close().await;
                }
            });
        }
    }

    pub async fn close_shell_sessions_for_server(&self, server_id: &str) {
        let mut to_close = Vec::new();
        {
            let mut guard = self.shell_sessions.lock().await;
            let matching_ids: Vec<String> = guard
                .iter()
                .filter(|(_, s)| s.server_id == server_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in matching_ids {
                if let Some(entry) = guard.remove(&id) {
                    to_close.push(entry);
                }
            }
        }
        for entry in to_close {
            tokio::spawn(async move {
                let _ = entry.shell.close().await;
                let _ = entry.session.close().await;
            });
        }
    }

    pub async fn close_all_shell_sessions(&self) {
        let sessions: Vec<McpShellSession> = {
            let mut guard = self.shell_sessions.lock().await;
            guard.drain().map(|(_, v)| v).collect()
        };
        for s in sessions {
            tokio::spawn(async move {
                let _ = s.shell.close().await;
                let _ = s.session.close().await;
            });
        }
    }

    pub async fn reap_idle_resources(&self, pool_idle_ttl: Duration, shell_idle_ttl: Duration) {
        let pool_slots: Vec<(String, Arc<Mutex<Option<PooledSshEntry>>>)> = {
            let guard = self.ssh_pool.read().await;
            guard
                .iter()
                .map(|(k, v)| (k.clone(), Arc::clone(v)))
                .collect()
        };
        let mut empty_keys = Vec::new();
        for (key, slot) in pool_slots {
            if let Ok(mut guard) = slot.try_lock() {
                let expired = guard
                    .as_ref()
                    .is_some_and(|e| e.last_used.elapsed() >= pool_idle_ttl);
                if expired && let Some(old) = guard.take() {
                    empty_keys.push(key);
                    tokio::spawn(async move {
                        let _ = old.session.close().await;
                    });
                }
            }
        }
        if !empty_keys.is_empty() {
            let mut pool = self.ssh_pool.write().await;
            for key in empty_keys {
                let should_remove = pool
                    .get(&key)
                    .is_some_and(|slot| slot.try_lock().is_ok_and(|guard| guard.is_none()));
                if should_remove {
                    pool.remove(&key);
                }
            }
        }

        let mut expired_shells = Vec::new();
        {
            let mut guard = self.shell_sessions.lock().await;
            let mut to_remove = Vec::new();
            for (id, s) in guard.iter() {
                if let Ok(last) = s.last_used.try_lock()
                    && last.elapsed() >= shell_idle_ttl
                {
                    to_remove.push(id.clone());
                }
            }
            for id in to_remove {
                if let Some(entry) = guard.remove(&id) {
                    expired_shells.push(entry);
                }
            }
        }
        for entry in expired_shells {
            tokio::spawn(async move {
                let _ = entry.shell.close().await;
                let _ = entry.session.close().await;
            });
        }
    }
    pub async fn record_log(
        &self,
        tool: impl Into<String>,
        summary: impl Into<String>,
        ok: bool,
        duration_ms: u64,
    ) {
        let id = self.log_seq.fetch_add(1, Ordering::Relaxed);
        let entry = McpLogEntry {
            id,
            timestamp: now_unix_secs(),
            tool: tool.into(),
            summary: summary.into(),
            ok,
            duration_ms,
        };
        let mut logs = self.logs.lock().await;
        if logs.len() >= MAX_LOG_ENTRIES {
            logs.pop_back();
        }
        logs.push_front(entry);
    }

    pub async fn status(&self, cfg: &McpConfig) -> McpStatus {
        let running = self.shutdown_tx.lock().await.is_some();
        let addr = self
            .bound_addr
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| format!("{}:{}", cfg.host, cfg.port));
        let active_ssh_sessions = self.shell_sessions.lock().await.len();
        let last_error = self.last_error.lock().await.clone();
        let recent_logs = self.logs.lock().await.iter().cloned().collect();
        McpStatus {
            running,
            bind_url: format!("http://{addr}/mcp"),
            sse_url: format!("http://{addr}/sse"),
            active_clients: self.active_clients.load(Ordering::Relaxed),
            active_ssh_sessions,
            total_requests: self.total_requests.load(Ordering::Relaxed),
            last_error,
            recent_logs,
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(dir.join(CONFIG_FILENAME))
}

fn is_loopback_bind_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    matches!(h.as_str(), "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

fn format_bind_addr(host: &str, port: u16) -> String {
    let trimmed = host.trim();
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

pub fn load_config_from_disk(app: &tauri::AppHandle) -> McpConfig {
    let Ok(path) = config_path(app) else {
        return McpConfig::default();
    };
    if !path.exists() {
        return McpConfig::default();
    }
    let mut cfg: McpConfig = match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(_) => {
                // Fail-closed on corrupt config file: disable auto-start and keep auth required.
                return McpConfig::default();
            }
        },
        Err(_) => return McpConfig::default(),
    };
    if !is_loopback_bind_host(&cfg.host) && !cfg.require_auth {
        cfg.require_auth = true;
    }
    cfg
}

pub fn save_config_to_disk(app: &tauri::AppHandle, cfg: &McpConfig) -> Result<(), String> {
    use std::io::Write;

    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let json =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化 MCP 配置失败: {e}"))?;
    let tmp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_res = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入 MCP 配置失败: {e}"));
    }
    if let Err(e) = crate::sync_cmds::atomic_replace_file_safe(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存 MCP 配置失败: {e}"));
    }
    Ok(())
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::from("sh_mcp_");
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub async fn ensure_token(app: &tauri::AppHandle, state: &AppState) -> String {
    {
        let guard = state.mcp.token.read().await;
        if !guard.is_empty() {
            return guard.clone();
        }
    }
    let mut guard = state.mcp.token.write().await;
    if !guard.is_empty() {
        return guard.clone();
    }
    if let Some(existing) = vault::resolve_secret(app, state, SECRET_MCP_TOKEN).await
        && !existing.trim().is_empty()
    {
        *guard = existing.clone();
        return existing;
    }
    let token = generate_token();
    let _ = vault::persist_secret(app, state, SECRET_MCP_TOKEN, &token).await;
    *guard = token.clone();
    token
}

pub async fn init_on_startup(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    let cfg = load_config_from_disk(&app);
    {
        let mut guard = state.mcp.config.write().await;
        *guard = cfg.clone();
    }
    let _ = ensure_token(&app, &state).await;
    if cfg.enabled
        && let Err(err) = start_server_inner(&app, &state).await
    {
        let mut last_err = state.mcp.last_error.lock().await;
        *last_err = Some(err);
    }
}

async fn start_server_unlocked(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    if state.mcp.shutdown_tx.lock().await.is_some() {
        return Ok(());
    }

    let cfg = state.mcp.config.read().await.clone();
    let host = if cfg.host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        cfg.host.trim().to_string()
    };
    if !is_loopback_bind_host(&host) && !cfg.require_auth {
        return Err("监听非回环地址时必须开启 Bearer Token 鉴权".to_string());
    }
    let _ = ensure_token(app, state).await;

    let port = if cfg.port == 0 { 17890 } else { cfg.port };
    let bind_addr = format_bind_addr(&host, port);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("无法监听 {bind_addr}: {e}"))?;
    let actual_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or(bind_addr);

    let (tx, rx) = watch::channel(false);
    let app_handle = app.clone();
    let handle = tokio::spawn(async move {
        server::run_http_server(app_handle, listener, rx).await;
    });
    {
        *state.mcp.shutdown_tx.lock().await = Some(tx);
        *state.mcp.server_task.lock().await = Some(handle);
        *state.mcp.bound_addr.lock().await = Some(actual_addr);
        *state.mcp.last_error.lock().await = None;
    }

    Ok(())
}

async fn stop_server_unlocked(state: &AppState) {
    let tx = state.mcp.shutdown_tx.lock().await.take();
    if let Some(tx) = tx {
        let _ = tx.send(true);
    }
    let handle = state.mcp.server_task.lock().await.take();
    *state.mcp.bound_addr.lock().await = None;

    if let Some(handle) = handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }

    // Close any open MCP shell sessions cleanly.
    state.mcp.close_all_shell_sessions().await;

    // Close pooled SSH sessions.
    state.mcp.evict_all_pooled_ssh().await;
}

pub async fn start_server_inner(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    let _lifecycle = state.mcp.lifecycle_lock.lock().await;
    start_server_unlocked(app, state).await
}

pub async fn stop_server_inner(state: &AppState) {
    let _lifecycle = state.mcp.lifecycle_lock.lock().await;
    stop_server_unlocked(state).await;
}

async fn build_payload(app: &tauri::AppHandle, state: &AppState) -> McpStatePayload {
    let cfg = state.mcp.config.read().await.clone();
    let token = ensure_token(app, state).await;
    let status = state.mcp.status(&cfg).await;
    McpStatePayload {
        config: cfg,
        status,
        token,
    }
}

#[tauri::command]
pub async fn mcp_get_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatePayload, String> {
    Ok(build_payload(&app, &state).await)
}

#[tauri::command]
pub async fn mcp_save_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut config: McpConfig,
) -> Result<McpStatePayload, String> {
    if config.host.trim().is_empty() {
        config.host = "127.0.0.1".to_string();
    } else {
        config.host = config.host.trim().to_string();
    }
    if !is_loopback_bind_host(&config.host) && !config.require_auth {
        return Err(
            "监听非回环地址 (非 127.0.0.1 / localhost / ::1) 时必须开启 Bearer Token 鉴权"
                .to_string(),
        );
    }
    if config.port == 0 {
        config.port = 17890;
    }
    if config.workspace.default_remote_dir.trim().is_empty() {
        config.workspace.default_remote_dir = "~".to_string();
    }
    config.workspace.allowed_local_roots = config
        .workspace
        .allowed_local_roots
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    {
        let _lifecycle = state.mcp.lifecycle_lock.lock().await;
        let (was_running, bind_changed) = {
            let prev = state.mcp.config.read().await;
            let running = state.mcp.shutdown_tx.lock().await.is_some();
            let changed = prev.host != config.host || prev.port != config.port;
            (running, changed)
        };

        {
            let mut guard = state.mcp.config.write().await;
            *guard = config.clone();
        }
        save_config_to_disk(&app, &config)?;

        if config.enabled {
            if was_running && bind_changed {
                stop_server_unlocked(&state).await;
                if let Err(err) = start_server_unlocked(&app, &state).await {
                    *state.mcp.last_error.lock().await = Some(err.clone());
                    return Err(err);
                }
            } else if !was_running && let Err(err) = start_server_unlocked(&app, &state).await {
                *state.mcp.last_error.lock().await = Some(err.clone());
                return Err(err);
            }
        } else if was_running {
            stop_server_unlocked(&state).await;
        }
    }

    Ok(build_payload(&app, &state).await)
}

#[tauri::command]
pub async fn mcp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatePayload, String> {
    {
        let _lifecycle = state.mcp.lifecycle_lock.lock().await;
        {
            let mut guard = state.mcp.config.write().await;
            if !is_loopback_bind_host(&guard.host) && !guard.require_auth {
                return Err("监听非回环地址时必须开启 Bearer Token 鉴权".to_string());
            }
            guard.enabled = true;
            save_config_to_disk(&app, &guard)?;
        }
        if let Err(err) = start_server_unlocked(&app, &state).await {
            *state.mcp.last_error.lock().await = Some(err.clone());
            {
                let mut guard = state.mcp.config.write().await;
                guard.enabled = false;
                let _ = save_config_to_disk(&app, &guard);
            }
            return Err(err);
        }
    }
    Ok(build_payload(&app, &state).await)
}

#[tauri::command]
pub async fn mcp_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatePayload, String> {
    {
        let _lifecycle = state.mcp.lifecycle_lock.lock().await;
        {
            let mut guard = state.mcp.config.write().await;
            guard.enabled = false;
            save_config_to_disk(&app, &guard)?;
        }
        stop_server_unlocked(&state).await;
        *state.mcp.last_error.lock().await = None;
    }
    Ok(build_payload(&app, &state).await)
}

#[tauri::command]
pub async fn mcp_regenerate_token(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatePayload, String> {
    let token = generate_token();
    vault::persist_secret(&app, &state, SECRET_MCP_TOKEN, &token).await?;
    {
        let mut guard = state.mcp.token.write().await;
        *guard = token;
    }
    Ok(build_payload(&app, &state).await)
}

#[tauri::command]
pub async fn mcp_clear_logs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<McpStatePayload, String> {
    state.mcp.logs.lock().await.clear();
    Ok(build_payload(&app, &state).await)
}
