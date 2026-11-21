use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serverhub_core::{Server, ServerStore, ssh_config};
use serverhub_ssh::{Auth, ConnectConfig, KnownHostsStore, ShellEvent, ShellHandle, SshSession};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.serverhub.app";

struct SessionEntry {
    shell: ShellHandle,
    session: SshSession,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<Uuid, SessionEntry>>>,
    store_lock: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SshAuthInput {
    Password {
        #[serde(default)]
        password: String,
    },
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

#[derive(Deserialize)]
struct SshConnectInput {
    host: String,
    port: u16,
    username: String,
    auth: SshAuthInput,
}

impl From<SshConnectInput> for ConnectConfig {
    fn from(cfg: SshConnectInput) -> Self {
        let auth = match cfg.auth {
            SshAuthInput::Password { password } => Auth::Password(password),
            SshAuthInput::Key { path, passphrase } => Auth::Key { path, passphrase },
        };
        ConnectConfig {
            host: cfg.host,
            port: cfg.port,
            username: cfg.username,
            auth,
        }
    }
}

fn load_known_hosts(app: &tauri::AppHandle) -> Result<KnownHostsStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    KnownHostsStore::load_or_create(data_dir.join("known_hosts.json")).map_err(|e| e.to_string())
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
) -> Result<String, String> {
    let known_hosts = load_known_hosts(&app)?;
    let connect_cfg = ConnectConfig::from(cfg);

    let session = SshSession::connect(connect_cfg, known_hosts)
        .await
        .map_err(|e| e.to_string())?;
    let (shell, mut rx) = session
        .open_shell(cols.max(1), rows.max(1))
        .await
        .map_err(|e| e.to_string())?;

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
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效会话 ID: {e}"))?;
    let shell = {
        let guard = state.sessions.lock().await;
        guard
            .get(&uuid)
            .map(|entry| entry.shell.clone())
            .ok_or_else(|| "会话不存在或已关闭".to_string())?
    };
    shell
        .write(data.into_bytes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_resize(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效会话 ID: {e}"))?;
    let shell = {
        let guard = state.sessions.lock().await;
        guard
            .get(&uuid)
            .map(|entry| entry.shell.clone())
            .ok_or_else(|| "会话不存在或已关闭".to_string())?
    };
    shell
        .resize(cols.max(1), rows.max(1))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_close(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| format!("无效会话 ID: {e}"))?;
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
async fn ssh_test(app: tauri::AppHandle, cfg: SshConnectInput) -> Result<u64, String> {
    let known_hosts = load_known_hosts(&app)?;
    let connect_cfg = ConnectConfig::from(cfg);
    let start = Instant::now();
    let session = tokio::time::timeout(
        Duration::from_secs(10),
        SshSession::connect(connect_cfg, known_hosts),
    )
    .await
    .map_err(|_| "连接超时 (10s)".to_string())?
    .map_err(|e| e.to_string())?;
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
            ssh_ping,
            ssh_test,
            servers_list,
            servers_upsert,
            servers_delete,
            ssh_config_preview,
            servers_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
