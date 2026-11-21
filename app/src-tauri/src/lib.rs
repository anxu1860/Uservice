use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serverhub_ssh::{Auth, ConnectConfig, KnownHostsStore, ShellEvent, ShellHandle, SshSession};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use uuid::Uuid;

struct SessionEntry {
    shell: ShellHandle,
    session: SshSession,
}

#[derive(Default)]
struct AppState {
    sessions: Arc<Mutex<HashMap<Uuid, SessionEntry>>>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SshAuthInput {
    Password {
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
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    let known_hosts = KnownHostsStore::load_or_create(data_dir.join("known_hosts.json"))
        .map_err(|e| e.to_string())?;

    let auth = match cfg.auth {
        SshAuthInput::Password { password } => Auth::Password(password),
        SshAuthInput::Key { path, passphrase } => Auth::Key { path, passphrase },
    };

    let connect_cfg = ConnectConfig {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth,
    };

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_open, ssh_write, ssh_resize, ssh_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
