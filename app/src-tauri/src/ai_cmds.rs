use std::sync::atomic::{AtomicU64, Ordering};

use serverhub_ai::{
    AiConfigData, AiProfile, AiProfileStore, AiStreamEvent, ChatMessage, ServerContext,
    TestConnectionResult, base_url_origin, list_models, stream_chat, test_connection,
    validate_base_url,
};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::watch;
use uuid::Uuid;

use crate::{AppState, CmdError, now_unix_secs, persist_secret, resolve_secret, sync_cmds, vault};

const MAX_CONCURRENT_AI_STREAMS: usize = 16;
static AI_STREAM_SEQ: AtomicU64 = AtomicU64::new(1);

fn ai_store(app: &tauri::AppHandle) -> Result<AiProfileStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    AiProfileStore::open(data_dir).map_err(|e| e.to_string())
}

fn secret_key(profile_id: &str) -> String {
    format!("ai:{}", profile_id.trim())
}

#[tauri::command]
pub async fn ai_profiles_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AiConfigData, String> {
    let _guard = state.store_lock.read().await;
    let store = ai_store(&app)?;
    tokio::task::spawn_blocking(move || store.load())
        .await
        .map_err(|e| format!("读取 AI 配置任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_profiles_upsert(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut profile: AiProfile,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
    set_default: Option<bool>,
) -> Result<AiConfigData, String> {
    profile.id = profile.id.trim().to_string();
    if profile.id.is_empty() {
        profile.id = Uuid::new_v4().to_string();
    }
    if !(profile.protocol == serverhub_ai::AiProtocol::Gemini && profile.base_url.trim().is_empty())
    {
        validate_base_url(&profile.base_url).map_err(|e| e.to_string())?;
    }
    profile.updated_at = now_unix_secs().max(0) as u64;

    let _guard = state.store_lock.write().await;
    let key_id = secret_key(&profile.id);
    if clear_api_key.unwrap_or(false) {
        vault::delete_secret(&app, &state, &key_id).await?;
        profile.has_api_key = false;
    } else if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        persist_secret(&app, &state, &key_id, key)
            .await
            .map_err(|e| e.message)?;
        profile.has_api_key = true;
    } else {
        profile.has_api_key = resolve_secret(&app, &state, &key_id).await.is_some();
    }

    let store = ai_store(&app)?;
    let set_def = set_default.unwrap_or(false);
    tokio::task::spawn_blocking(move || store.upsert(profile, set_def))
        .await
        .map_err(|e| format!("保存 AI 配置任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_profiles_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<AiConfigData, String> {
    let trimmed_id = profile_id.trim().to_string();
    let _guard = state.store_lock.write().await;
    let key_id = secret_key(&trimmed_id);
    vault::delete_secret(&app, &state, &key_id).await?;

    let store = ai_store(&app)?;
    let id_for_store = trimmed_id.clone();
    let data = tokio::task::spawn_blocking(move || store.delete(&id_for_store))
        .await
        .map_err(|e| format!("删除 AI 配置任务失败: {e}"))?
        .map_err(|e| e.to_string())?;

    sync_cmds::record_ai_profile_deletion(&app, &trimmed_id);
    Ok(data)
}

#[tauri::command]
pub async fn ai_profiles_set_default(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<AiConfigData, String> {
    let _guard = state.store_lock.write().await;
    let store = ai_store(&app)?;
    let trimmed = profile_id.trim().to_string();
    tokio::task::spawn_blocking(move || store.set_default(&trimmed))
        .await
        .map_err(|e| format!("更新默认 AI 配置任务失败: {e}"))?
        .map_err(|e| e.to_string())
}

/// Resolves the API key for testing/listing models without leaking a stored key to a different origin.
async fn resolve_profile_key_for_probe(
    app: &tauri::AppHandle,
    state: &AppState,
    profile: &AiProfile,
    override_key: Option<String>,
) -> Result<String, CmdError> {
    if let Some(k) = override_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(k.to_string());
    }
    let pid = profile.id.trim();
    if pid.is_empty() {
        return Ok(String::new());
    }

    // Verify that the caller-supplied base_url matches the persisted profile's origin
    // before attaching the stored vault key (prevents exfiltrating keys to arbitrary URLs).
    let stored = {
        let _guard = state.store_lock.read().await;
        let store = ai_store(app).map_err(CmdError::other)?;
        tokio::task::spawn_blocking(move || store.load())
            .await
            .map_err(|e| CmdError::other(format!("读取 AI 配置失败: {e}")))?
            .map_err(|e| CmdError::other(e.to_string()))?
    };
    let Some(saved_profile) = stored.profiles.into_iter().find(|p| p.id == pid) else {
        return Ok(String::new());
    };
    let saved_origin = base_url_origin(saved_profile.protocol, &saved_profile.base_url);
    let req_origin = base_url_origin(profile.protocol, &profile.base_url);
    if saved_origin.is_none() || saved_origin != req_origin {
        return Err(CmdError::auth(
            "Base URL 主机已变更，出于安全考虑请重新输入 API Key 后再测试",
        ));
    }

    Ok(resolve_secret(app, state, &secret_key(pid))
        .await
        .unwrap_or_default())
}

#[tauri::command]
pub async fn ai_test_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile: AiProfile,
    api_key_override: Option<String>,
) -> Result<TestConnectionResult, CmdError> {
    let key = resolve_profile_key_for_probe(&app, &state, &profile, api_key_override).await?;
    test_connection(&profile, &key)
        .await
        .map_err(|e| CmdError::other(e.to_string()))
}

#[tauri::command]
pub async fn ai_list_models(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    profile: AiProfile,
    api_key_override: Option<String>,
) -> Result<Vec<String>, CmdError> {
    let key = resolve_profile_key_for_probe(&app, &state, &profile, api_key_override).await?;
    list_models(&profile, &key)
        .await
        .map_err(|e| CmdError::other(e.to_string()))
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    stream_id: String,
    profile_id: Option<String>,
    messages: Vec<ChatMessage>,
    context: Option<ServerContext>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), CmdError> {
    let config = {
        let _guard = state.store_lock.read().await;
        let store = ai_store(&app).map_err(CmdError::other)?;
        tokio::task::spawn_blocking(move || store.load())
            .await
            .map_err(|e| CmdError::other(format!("读取 AI 配置失败: {e}")))?
            .map_err(|e| CmdError::other(e.to_string()))?
    };

    let target_id = profile_id
        .filter(|s| !s.trim().is_empty())
        .or(config.default_profile_id)
        .ok_or_else(|| CmdError::other("尚未配置 AI 模型，请先前往设置添加 API 配置"))?;

    let profile = config
        .profiles
        .into_iter()
        .find(|p| p.id == target_id)
        .ok_or_else(|| CmdError::other("找不到指定的 AI 模型配置"))?;

    let api_key = resolve_secret(&app, &state, &secret_key(&profile.id))
        .await
        .unwrap_or_default();

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let cancel_tx_for_cb = cancel_tx.clone();
    let run_token = AI_STREAM_SEQ.fetch_add(1, Ordering::Relaxed);
    {
        let mut map = state.ai_streams.lock().await;
        if let Some((_, prev_tx)) = map.remove(&stream_id) {
            let _ = prev_tx.send(true);
        }
        if map.len() >= MAX_CONCURRENT_AI_STREAMS {
            return Err(CmdError::other(format!(
                "同时进行的 AI 对话流已达上限 ({MAX_CONCURRENT_AI_STREAMS})，请稍后重试"
            )));
        }
        map.insert(stream_id.clone(), (run_token, cancel_tx));
    }

    let streams = state.ai_streams.clone();
    tokio::spawn(async move {
        let res = stream_chat(
            &profile,
            &api_key,
            &messages,
            context.as_ref(),
            cancel_rx,
            |ev| {
                if on_event.send(ev).is_err() {
                    let _ = cancel_tx_for_cb.send(true);
                }
            },
        )
        .await;

        if let Err(err) = res {
            let _ = on_event.send(AiStreamEvent::Error(err.to_string()));
        }
        let mut map = streams.lock().await;
        if map
            .get(&stream_id)
            .is_some_and(|(tok, _)| *tok == run_token)
        {
            map.remove(&stream_id);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn ai_chat_cancel(
    state: tauri::State<'_, AppState>,
    stream_id: String,
) -> Result<(), CmdError> {
    if let Some((_, tx)) = state.ai_streams.lock().await.remove(&stream_id) {
        let _ = tx.send(true);
    }
    Ok(())
}
