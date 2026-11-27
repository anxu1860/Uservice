use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use rand::RngCore;
use rand::rngs::OsRng;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serverhub_ai::{AiConfigData, AiProfileStore};
use serverhub_core::{Credential, CredentialStore, Server, ServerStore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::{AppState, now_unix_secs, vault};

const CONFIG_FILENAME: &str = "sync_config.json";
const TOMBSTONES_FILENAME: &str = "sync_tombstones.json";
const CRED_TOMBSTONES_FILENAME: &str = "sync_cred_tombstones.json";
const AI_TOMBSTONES_FILENAME: &str = "sync_ai_tombstones.json";
const BUNDLE_FILENAME: &str = "serverhub-sync.enc.json";
const ENVELOPE_AAD: &[u8] = b"serverhub-sync-envelope-v1";
const PBKDF2_ITERATIONS: u32 = 600_000;
const LEGACY_PBKDF2_ITERATIONS: u32 = 100_000;
const MAX_SYNC_BUNDLE_BYTES: usize = 32 * 1024 * 1024; // 32 MiB max remote sync bundle

const SECRET_PASSPHRASE: &str = "sync:passphrase";
const SECRET_WEBDAV_PASS: &str = "sync:webdav_password";
const SECRET_GITHUB_TOKEN: &str = "sync:github_token";
const SECRET_S3_SECRET: &str = "sync:s3_secret_key";
const SECRET_GOOGLE_ACCESS: &str = "sync:google_access_token";
const SECRET_GOOGLE_REFRESH: &str = "sync:google_refresh_token";
const SECRET_GOOGLE_CLIENT_SECRET: &str = "sync:google_client_secret";
const SECRET_ONEDRIVE_ACCESS: &str = "sync:onedrive_access_token";
const SECRET_ONEDRIVE_REFRESH: &str = "sync:onedrive_refresh_token";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncProvider {
    GoogleDrive,
    #[default]
    Icloud,
    Onedrive,
    Webdav,
    GithubGist,
    S3,
    LocalFolder,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudDriveMode {
    #[default]
    DesktopFolder,
    Api,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStrategy {
    #[default]
    Latest,
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncConfig {
    pub enabled: bool,
    pub provider: SyncProvider,
    pub device_name: String,

    // Sync scopes
    pub sync_servers: bool,
    pub sync_secrets: bool,
    pub sync_ai_profiles: bool,
    pub sync_app_settings: bool,

    // Automation & conflict
    pub auto_sync: bool,
    pub auto_sync_interval_min: u32,
    pub sync_on_startup: bool,
    pub conflict_strategy: ConflictStrategy,

    // Google Drive
    pub google_mode: CloudDriveMode,
    pub google_folder_path: String,
    pub google_client_id: String,
    pub google_account_email: String,

    // iCloud Drive
    pub icloud_subfolder: String,
    pub icloud_custom_path: String,

    // Microsoft OneDrive
    pub onedrive_mode: CloudDriveMode,
    pub onedrive_folder_path: String,
    pub onedrive_client_id: String,
    pub onedrive_account_email: String,

    // WebDAV
    pub webdav_url: String,
    pub webdav_username: String,
    pub webdav_remote_path: String,
    pub webdav_allow_insecure_tls: bool,

    // GitHub Gist
    pub github_gist_id: String,
    pub github_filename: String,

    // S3 Compatible
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_object_key: String,
    pub s3_access_key_id: String,
    pub s3_path_style: bool,

    // Local Folder / Third-party Cloud Folder
    pub local_folder_path: String,

    // Status metadata
    pub last_sync_at: Option<i64>,
    pub last_sync_status: Option<String>,
    pub last_sync_message: Option<String>,
}

impl Default for SyncConfig {
    fn default() -> Self {
        let host_name = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .or_else(|_| std::env::var("USER"))
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "My Desktop".to_string());
        Self {
            enabled: false,
            provider: SyncProvider::Icloud,
            device_name: host_name,
            sync_servers: true,
            sync_secrets: true,
            sync_ai_profiles: true,
            sync_app_settings: true,
            auto_sync: false,
            auto_sync_interval_min: 15,
            sync_on_startup: false,
            conflict_strategy: ConflictStrategy::Latest,
            google_mode: CloudDriveMode::DesktopFolder,
            google_folder_path: String::new(),
            google_client_id: String::new(),
            google_account_email: String::new(),
            icloud_subfolder: "ServerHub".to_string(),
            icloud_custom_path: String::new(),
            onedrive_mode: CloudDriveMode::DesktopFolder,
            onedrive_folder_path: String::new(),
            onedrive_client_id: String::new(),
            onedrive_account_email: String::new(),
            webdav_url: String::new(),
            webdav_username: String::new(),
            webdav_remote_path: format!("ServerHub/{BUNDLE_FILENAME}"),
            webdav_allow_insecure_tls: false,
            github_gist_id: String::new(),
            github_filename: BUNDLE_FILENAME.to_string(),
            s3_endpoint: String::new(),
            s3_region: "auto".to_string(),
            s3_bucket: String::new(),
            s3_object_key: format!("serverhub/{BUNDLE_FILENAME}"),
            s3_access_key_id: String::new(),
            s3_path_style: true,
            local_folder_path: String::new(),
            last_sync_at: None,
            last_sync_status: None,
            last_sync_message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncSecretFlags {
    pub has_passphrase: bool,
    pub has_webdav_password: bool,
    pub has_github_token: bool,
    pub has_s3_secret_key: bool,
    pub has_google_token: bool,
    pub has_google_client_secret: bool,
    pub has_onedrive_token: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncConfigResponse {
    pub config: SyncConfig,
    pub secrets: SyncSecretFlags,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SyncSecretPatch {
    pub passphrase: Option<String>,
    pub clear_passphrase: Option<bool>,
    pub webdav_password: Option<String>,
    pub clear_webdav_password: Option<bool>,
    pub github_token: Option<String>,
    pub clear_github_token: Option<bool>,
    pub s3_secret_key: Option<String>,
    pub clear_s3_secret_key: Option<bool>,
    pub google_access_token: Option<String>,
    pub clear_google_token: Option<bool>,
    pub google_client_secret: Option<String>,
    pub clear_google_client_secret: Option<bool>,
    pub onedrive_access_token: Option<String>,
    pub clear_onedrive_token: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedLocalClouds {
    pub icloud_path: Option<String>,
    pub google_drive_path: Option<String>,
    pub onedrive_path: Option<String>,
    pub dropbox_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncActionResult {
    pub ok: bool,
    pub action: String,
    pub message: String,
    pub synced_at: i64,
    pub servers_count: usize,
    pub secrets_count: usize,
    pub ai_profiles_count: usize,
    pub pulled_app_settings: Option<serde_json::Value>,
    pub config: SyncConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncPayload {
    schema_version: u32,
    device_name: String,
    updated_at: i64,
    #[serde(default)]
    servers: Option<Vec<Server>>,
    #[serde(default)]
    credentials: Option<Vec<Credential>>,
    #[serde(default)]
    deleted_server_ids: HashMap<String, i64>,
    #[serde(default)]
    deleted_credential_ids: HashMap<String, i64>,
    #[serde(default)]
    deleted_ai_profile_ids: HashMap<String, i64>,
    #[serde(default)]
    secrets: Option<HashMap<String, String>>,
    #[serde(default)]
    secret_timestamps: HashMap<String, i64>,
    #[serde(default)]
    ai_config: Option<AiConfigData>,
    #[serde(default)]
    app_settings: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncEnvelope {
    version: u32,
    encrypted: bool,
    updated_at: i64,
    device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kdf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    iterations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<SyncPayload>,
}

// ============================================================================
// Crypto Helpers (HMAC-SHA256, PBKDF2-HMAC-SHA256, AES-256-GCM)
// ============================================================================

fn hmac_sha256_init(key: &[u8]) -> (Sha256, Sha256) {
    const BLOCK_SIZE: usize = 64;
    let mut k_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hashed = Sha256::digest(key);
        k_block[..32].copy_from_slice(&hashed);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= k_block[i];
        opad[i] ^= k_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    let mut outer = Sha256::new();
    outer.update(opad);

    vault::zeroize_bytes(&mut k_block);
    vault::zeroize_bytes(&mut ipad);
    vault::zeroize_bytes(&mut opad);
    (inner, outer)
}

fn hmac_sha256_with_states(inner_base: &Sha256, outer_base: &Sha256, data: &[u8]) -> [u8; 32] {
    let mut inner = inner_base.clone();
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = outer_base.clone();
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut res = [0u8; 32];
    res.copy_from_slice(&out);
    res
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let (inner, outer) = hmac_sha256_init(key);
    hmac_sha256_with_states(&inner, &outer, data)
}

fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    if iterations == 0 {
        return [0u8; 32];
    }
    let (inner_base, outer_base) = hmac_sha256_init(password);
    let mut salt_block = Vec::with_capacity(salt.len() + 4);
    salt_block.extend_from_slice(salt);
    salt_block.extend_from_slice(&1u32.to_be_bytes());

    let mut u = hmac_sha256_with_states(&inner_base, &outer_base, &salt_block);
    let mut out = u;
    for _ in 1..iterations {
        u = hmac_sha256_with_states(&inner_base, &outer_base, &u);
        for i in 0..32 {
            out[i] ^= u[i];
        }
    }
    vault::zeroize_bytes(&mut u);
    out
}

fn encode_envelope(payload: &SyncPayload, passphrase: Option<&str>) -> Result<Vec<u8>, String> {
    encode_envelope_with_iterations(payload, passphrase, PBKDF2_ITERATIONS)
}

fn encode_envelope_with_iterations(
    payload: &SyncPayload,
    passphrase: Option<&str>,
    iterations: u32,
) -> Result<Vec<u8>, String> {
    let iterations = iterations.clamp(10_000, 1_000_000);
    let env = if let Some(pass) = passphrase.filter(|p| !p.is_empty()) {
        let mut plaintext =
            serde_json::to_vec(payload).map_err(|e| format!("序列化同步数据失败: {e}"))?;
        let mut salt = [0u8; 16];
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce_bytes);

        let mut key = pbkdf2_hmac_sha256(pass.as_bytes(), &salt, iterations);
        let cipher_res = Aes256Gcm::new_from_slice(&key);
        vault::zeroize_bytes(&mut key);
        let cipher = cipher_res.map_err(|e| format!("初始化 AES-256-GCM 失败: {e}"))?;
        let ct_res = cipher.encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: ENVELOPE_AAD,
            },
        );
        vault::zeroize_bytes(&mut plaintext);
        let ciphertext = ct_res.map_err(|e| format!("加密同步数据失败: {e}"))?;

        SyncEnvelope {
            version: 1,
            encrypted: true,
            updated_at: payload.updated_at,
            device_name: payload.device_name.clone(),
            kdf: Some("pbkdf2-hmac-sha256".to_string()),
            iterations: Some(iterations),
            salt: Some(B64.encode(salt)),
            nonce: Some(B64.encode(nonce_bytes)),
            ciphertext: Some(B64.encode(ciphertext)),
            payload: None,
        }
    } else {
        if payload.secrets.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err("安全策略限制：禁止以明文信封编码包含密钥与密码的同步数据".to_string());
        }
        SyncEnvelope {
            version: 1,
            encrypted: false,
            updated_at: payload.updated_at,
            device_name: payload.device_name.clone(),
            kdf: None,
            iterations: None,
            salt: None,
            nonce: None,
            ciphertext: None,
            payload: Some(payload.clone()),
        }
    };

    serde_json::to_vec_pretty(&env).map_err(|e| format!("编码同步信封失败: {e}"))
}

fn decode_envelope(
    raw: &[u8],
    passphrase: Option<&str>,
    require_encrypted: bool,
) -> Result<SyncPayload, String> {
    if raw.len() > MAX_SYNC_BUNDLE_BYTES {
        return Err(format!(
            "云端同步文件过大 ({} bytes)，超过安全上限",
            raw.len()
        ));
    }
    let env: SyncEnvelope =
        serde_json::from_slice(raw).map_err(|e| format!("云端同步文件格式无效: {e}"))?;
    if env.version != 1 {
        return Err(format!("不支持的云端同步文件版本: v{}", env.version));
    }
    if !env.encrypted {
        if require_encrypted {
            return Err(
                "安全策略限制：已设置加密主密码或开启同步密钥，拒绝接受未加密的云端明文同步文件"
                    .to_string(),
            );
        }
        let payload = env
            .payload
            .ok_or_else(|| "云端同步文件缺少数据载荷".to_string())?;
        if payload.secrets.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err("安全策略限制：拒绝从未加密的云端同步文件导入任何密钥或密码".to_string());
        }
        return Ok(payload);
    }
    if let Some(kdf) = env.kdf.as_deref()
        && kdf != "pbkdf2-hmac-sha256"
    {
        return Err(format!("不支持的云端密钥派生算法: {kdf}"));
    }

    let pass = passphrase
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "云端数据已端到端加密，请先填写同步加密主密码".to_string())?;
    let salt_b64 = env.salt.as_deref().ok_or("同步文件缺少 salt")?;
    let nonce_b64 = env.nonce.as_deref().ok_or("同步文件缺少 nonce")?;
    let ct_b64 = env.ciphertext.as_deref().ok_or("同步文件缺少密文")?;
    let iterations = match env.iterations {
        Some(n) if (10_000..=1_000_000).contains(&n) => n,
        Some(n) => {
            return Err(format!(
                "同步文件 PBKDF2 迭代次数超出安全范围 (10000-1000000): {n}"
            ));
        }
        None => LEGACY_PBKDF2_ITERATIONS,
    };

    let salt = B64.decode(salt_b64).map_err(|_| "同步文件 salt 无效")?;
    if salt.len() < 16 {
        return Err("同步文件 salt 长度不足 16 字节".to_string());
    }
    let nonce_bytes = B64.decode(nonce_b64).map_err(|_| "同步文件 nonce 无效")?;
    let ciphertext = B64.decode(ct_b64).map_err(|_| "同步文件密文编码无效")?;
    if nonce_bytes.len() != 12 {
        return Err("同步文件 nonce 长度无效".to_string());
    }

    let mut key = pbkdf2_hmac_sha256(pass.as_bytes(), &salt, iterations);
    let cipher_res = Aes256Gcm::new_from_slice(&key);
    vault::zeroize_bytes(&mut key);
    let cipher = cipher_res.map_err(|e| format!("初始化解密器失败: {e}"))?;
    let mut plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &ciphertext,
                aad: ENVELOPE_AAD,
            },
        )
        .map_err(|_| "解密失败：同步主密码不正确或云端文件已损坏".to_string())?;

    let decoded =
        serde_json::from_slice(&plaintext).map_err(|e| format!("解析解密后的同步数据失败: {e}"));
    vault::zeroize_bytes(&mut plaintext);
    decoded
}

// ============================================================================
// Local Config & Cloud Folder Detection
// ============================================================================

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(dir.join(CONFIG_FILENAME))
}

fn load_config(app: &tauri::AppHandle) -> Result<SyncConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(SyncConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取同步配置失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(SyncConfig::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("解析同步配置失败: {e}"))
}

pub(crate) fn atomic_replace_file_safe(tmp: &Path, dst: &Path) -> std::io::Result<()> {
    match std::fs::rename(tmp, dst) {
        Ok(()) => Ok(()),
        Err(first_err) => {
            if !dst.exists() {
                return Err(first_err);
            }
            // Safe backup-swap (for Windows where rename doesn't overwrite existing dst):
            // never delete dst before tmp is safely moved into place.
            let backup = dst.with_extension(format!("bak.{}", uuid::Uuid::new_v4()));
            std::fs::rename(dst, &backup)?;
            match std::fs::rename(tmp, dst) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                    Ok(())
                }
                Err(rename_err) => {
                    let _ = std::fs::rename(&backup, dst);
                    Err(rename_err)
                }
            }
        }
    }
}

fn write_atomic_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let tmp = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_res = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = atomic_replace_file_safe(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn save_config(app: &tauri::AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化同步配置失败: {e}"))?;
    write_atomic_private(&path, json.as_bytes()).map_err(|e| format!("保存同步配置失败: {e}"))
}

fn tombstone_file_path(app: &tauri::AppHandle, filename: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(dir.join(filename))
}

fn load_tombstone_map(app: &tauri::AppHandle, filename: &str) -> HashMap<String, i64> {
    let Ok(path) = tombstone_file_path(app, filename) else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_tombstone_map(app: &tauri::AppHandle, filename: &str, map: &HashMap<String, i64>) {
    let Ok(path) = tombstone_file_path(app, filename) else {
        return;
    };
    let cutoff = now_unix_secs().saturating_sub(90 * 24 * 3600);
    let pruned: HashMap<&String, &i64> = map.iter().filter(|(_, ts)| **ts >= cutoff).collect();
    if let Ok(json) = serde_json::to_string_pretty(&pruned) {
        let _ = write_atomic_private(&path, json.as_bytes());
    }
}

fn merge_tombstone_maps(
    local: &HashMap<String, i64>,
    remote: &HashMap<String, i64>,
) -> HashMap<String, i64> {
    let mut merged = local.clone();
    for (id, ts) in remote {
        merged
            .entry(id.clone())
            .and_modify(|cur| {
                if *ts > *cur {
                    *cur = *ts;
                }
            })
            .or_insert(*ts);
    }
    merged
}

pub(crate) fn record_server_deletion(app: &tauri::AppHandle, server_id: &str) {
    let mut map = load_tombstone_map(app, TOMBSTONES_FILENAME);
    map.insert(server_id.to_string(), now_unix_secs());
    save_tombstone_map(app, TOMBSTONES_FILENAME, &map);
}

pub(crate) fn record_credential_deletion(app: &tauri::AppHandle, credential_id: &str) {
    let mut map = load_tombstone_map(app, CRED_TOMBSTONES_FILENAME);
    map.insert(credential_id.to_string(), now_unix_secs());
    save_tombstone_map(app, CRED_TOMBSTONES_FILENAME, &map);
}

pub(crate) fn record_ai_profile_deletion(app: &tauri::AppHandle, profile_id: &str) {
    let mut map = load_tombstone_map(app, AI_TOMBSTONES_FILENAME);
    map.insert(profile_id.to_string(), now_unix_secs());
    save_tombstone_map(app, AI_TOMBSTONES_FILENAME, &map);
}

fn sanitize_synced_app_settings(
    app_settings: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    app_settings.map(|mut val| {
        if let Some(obj) = val.as_object_mut() {
            obj.remove("backgroundImage");
        }
        val
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~"
        && let Some(home) = home_dir()
    {
        return home;
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        && let Some(home) = home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

fn detect_icloud_dir() -> Option<PathBuf> {
    let home = home_dir()?;
    let mac = home.join("Library/Mobile Documents/com~apple~CloudDocs");
    if mac.exists() {
        return Some(mac);
    }
    let win = home.join("iCloudDrive");
    if win.exists() {
        return Some(win);
    }
    None
}

fn find_cloud_storage_prefix(prefix: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    let cs = home.join("Library/CloudStorage");
    if let Ok(entries) = std::fs::read_dir(&cs) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(s) = name.to_str()
                && s.starts_with(prefix)
                && entry.path().is_dir()
            {
                return Some(entry.path());
            }
        }
    }
    None
}

fn detect_google_drive_dir() -> Option<PathBuf> {
    if let Some(p) = find_cloud_storage_prefix("GoogleDrive") {
        let my_drive = p.join("My Drive");
        if my_drive.is_dir() {
            return Some(my_drive);
        }
        return Some(p);
    }
    let home = home_dir()?;
    for candidate in ["Google Drive/My Drive", "Google Drive", "GoogleDrive"] {
        let p = home.join(candidate);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn detect_onedrive_dir() -> Option<PathBuf> {
    if let Some(p) = find_cloud_storage_prefix("OneDrive") {
        return Some(p);
    }
    let home = home_dir()?;
    for candidate in ["OneDrive", "OneDrive - Personal"] {
        let p = home.join(candidate);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn detect_dropbox_dir() -> Option<PathBuf> {
    if let Some(p) = find_cloud_storage_prefix("Dropbox") {
        return Some(p);
    }
    let home = home_dir()?;
    let p = home.join("Dropbox");
    if p.is_dir() {
        return Some(p);
    }
    None
}

async fn secret_flags(app: &tauri::AppHandle, state: &AppState) -> SyncSecretFlags {
    let flags = vault::has_secrets_batch(
        app,
        state,
        &[
            SECRET_PASSPHRASE,
            SECRET_WEBDAV_PASS,
            SECRET_GITHUB_TOKEN,
            SECRET_S3_SECRET,
            SECRET_GOOGLE_ACCESS,
            SECRET_GOOGLE_REFRESH,
            SECRET_GOOGLE_CLIENT_SECRET,
            SECRET_ONEDRIVE_ACCESS,
            SECRET_ONEDRIVE_REFRESH,
        ],
    )
    .await;
    SyncSecretFlags {
        has_passphrase: flags[0],
        has_webdav_password: flags[1],
        has_github_token: flags[2],
        has_s3_secret_key: flags[3],
        has_google_token: flags[4] || flags[5],
        has_google_client_secret: flags[6],
        has_onedrive_token: flags[7] || flags[8],
    }
}

async fn apply_secret_patch(
    app: &tauri::AppHandle,
    state: &AppState,
    key: &str,
    value: Option<String>,
    clear: Option<bool>,
) -> Result<(), String> {
    if clear.unwrap_or(false) {
        let _ = vault::delete_secret(app, state, key).await;
    } else if let Some(v) = value {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            vault::persist_secret(app, state, key, trimmed).await?;
        }
    }
    Ok(())
}

// ============================================================================
// HTTP & Provider Backends
// ============================================================================

static SYNC_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(8)
        .tcp_nodelay(true)
        .user_agent("ServerHub-Desktop/0.1")
        .build()
        .expect("failed to build shared sync HTTP client")
});

static SYNC_HTTP_CLIENT_INSECURE: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(8)
        .tcp_nodelay(true)
        .danger_accept_invalid_certs(true)
        .user_agent("ServerHub-Desktop/0.1")
        .build()
        .expect("failed to build shared insecure sync HTTP client")
});

fn http_client() -> Result<reqwest::Client, String> {
    Ok(SYNC_HTTP_CLIENT.clone())
}

fn webdav_http_client(cfg: &SyncConfig) -> Result<reqwest::Client, String> {
    if cfg.webdav_allow_insecure_tls {
        Ok(SYNC_HTTP_CLIENT_INSECURE.clone())
    } else {
        Ok(SYNC_HTTP_CLIENT.clone())
    }
}

async fn read_response_bounded(
    mut resp: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length()
        && len > max_bytes as u64
    {
        return Err(format!("{label} 响应过大 ({len} bytes)，超过安全上限"));
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取 {label} 响应失败: {e}"))?
    {
        if out.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("{label} 响应超过最大允许大小 ({max_bytes} bytes)"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn url_origin(raw: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw.trim()).map_err(|e| format!("URL 格式无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("不支持的 URL 协议: {s}（仅支持 http / https）")),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?
        .to_ascii_lowercase();
    let port = parsed.port_or_known_default().unwrap_or(0);
    Ok(format!("{}://{host}:{port}", parsed.scheme()))
}

fn validate_safe_subfolder(sub: &str) -> Result<PathBuf, String> {
    let trimmed = sub.trim();
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    if trimmed.contains('\\') {
        return Err("子目录路径不能包含反斜杠 '\\'".to_string());
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(seg) => clean.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("子目录路径包含非法跳转或绝对路径: '{sub}'"));
            }
        }
    }
    Ok(clean)
}

// --- Filesystem backend (iCloud / Local / Desktop Cloud Folders) ---

fn resolve_folder_file(cfg: &SyncConfig) -> Result<PathBuf, String> {
    match cfg.provider {
        SyncProvider::Icloud => {
            let base = if !cfg.icloud_custom_path.trim().is_empty() {
                expand_tilde(&cfg.icloud_custom_path)
            } else {
                detect_icloud_dir().ok_or_else(|| {
                    "未检测到本机 iCloud Drive 目录，请确认已在系统设置中开启 iCloud 云盘，或手动指定路径".to_string()
                })?
            };
            let sub = validate_safe_subfolder(&cfg.icloud_subfolder)?;
            let dir = if sub.as_os_str().is_empty() {
                base
            } else {
                base.join(sub)
            };
            Ok(dir.join(BUNDLE_FILENAME))
        }
        SyncProvider::GoogleDrive => {
            let base = if !cfg.google_folder_path.trim().is_empty() {
                expand_tilde(&cfg.google_folder_path)
            } else {
                detect_google_drive_dir()
                    .map(|p| p.join("ServerHub"))
                    .ok_or_else(|| {
                        "未检测到 Google Drive 桌面目录，请安装 Google Drive 桌面客户端，或切换为 OAuth API 模式".to_string()
                    })?
            };
            Ok(base.join(BUNDLE_FILENAME))
        }
        SyncProvider::Onedrive => {
            let base = if !cfg.onedrive_folder_path.trim().is_empty() {
                expand_tilde(&cfg.onedrive_folder_path)
            } else {
                detect_onedrive_dir()
                    .map(|p| p.join("ServerHub"))
                    .ok_or_else(|| {
                        "未检测到 OneDrive 桌面目录，请安装 OneDrive 客户端，或切换为 OAuth API 模式".to_string()
                    })?
            };
            Ok(base.join(BUNDLE_FILENAME))
        }
        SyncProvider::LocalFolder => {
            if cfg.local_folder_path.trim().is_empty() {
                return Err("请填写本地或第三方网盘同步目录路径".to_string());
            }
            Ok(expand_tilde(&cfg.local_folder_path).join(BUNDLE_FILENAME))
        }
        _ => Err("当前同步方式不使用本地文件系统".to_string()),
    }
}

fn fs_test(path: &Path) -> Result<String, String> {
    use std::io::Write;
    let dir = path.parent().ok_or("无效的同步目录路径")?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("无法访问或创建目录 {}: {e}", dir.display()))?;
    let probe = dir.join(format!(".serverhub-write-test.{}", uuid::Uuid::new_v4()));
    let write_res = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|mut f| f.write_all(b"ok"));
    let _ = std::fs::remove_file(&probe);
    write_res.map_err(|e| format!("目录无写入权限 {}: {e}", dir.display()))?;
    let exists_hint = if path.exists() {
        "（已发现云端同步文件）"
    } else {
        "（目录可写，尚无同步文件）"
    };
    Ok(format!("目录连接正常：{}{exists_hint}", dir.display()))
}

fn fs_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;
    if !path.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("读取同步文件元数据失败 {}: {e}", path.display()))?;
    if meta.len() > MAX_SYNC_BUNDLE_BYTES as u64 {
        return Err(format!(
            "同步文件过大 ({} bytes)，超过安全上限 ({MAX_SYNC_BUNDLE_BYTES} bytes)",
            meta.len()
        ));
    }
    let f = std::fs::File::open(path)
        .map_err(|e| format!("打开同步文件失败 {}: {e}", path.display()))?;
    let mut buf = Vec::with_capacity((meta.len() as usize).min(MAX_SYNC_BUNDLE_BYTES));
    f.take((MAX_SYNC_BUNDLE_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取同步文件失败 {}: {e}", path.display()))?;
    if buf.len() > MAX_SYNC_BUNDLE_BYTES {
        return Err(format!(
            "同步文件超过安全上限 ({MAX_SYNC_BUNDLE_BYTES} bytes)"
        ));
    }
    Ok(Some(buf))
}

fn fs_write(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建同步目录失败: {e}"))?;
    }
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
        f.write_all(data)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时同步文件失败: {e}"));
    }
    if let Err(e) = atomic_replace_file_safe(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("保存同步文件失败: {e}"));
    }
    Ok(())
}

// --- WebDAV backend ---

fn parse_webdav_base_and_segments(cfg: &SyncConfig) -> Result<(reqwest::Url, Vec<String>), String> {
    let base_raw = cfg.webdav_url.trim();
    if base_raw.is_empty() {
        return Err("请填写 WebDAV 服务器地址".to_string());
    }
    let mut base =
        reqwest::Url::parse(base_raw).map_err(|e| format!("WebDAV 服务器地址格式无效: {e}"))?;
    match base.scheme() {
        "http" | "https" => {}
        s => return Err(format!("WebDAV 仅支持 http/https 协议，不支持 '{s}'")),
    }
    if base.host_str().is_none() {
        return Err("WebDAV 服务器地址缺少主机名".to_string());
    }
    base.set_query(None);
    base.set_fragment(None);

    let rel_raw = cfg.webdav_remote_path.trim().trim_start_matches('/');
    let rel = if rel_raw.is_empty() {
        BUNDLE_FILENAME
    } else {
        rel_raw
    };
    if rel.contains('\\') {
        return Err("WebDAV 远端路径不能包含反斜杠 '\\'".to_string());
    }
    let mut segments = Vec::new();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == "." || seg == ".." {
            return Err(format!("WebDAV 远端路径包含非法段 '{seg}'"));
        }
        segments.push(seg.to_string());
    }
    if segments.is_empty() {
        segments.push(BUNDLE_FILENAME.to_string());
    }
    Ok((base, segments))
}

fn append_url_segments(mut url: reqwest::Url, segments: &[String]) -> Result<String, String> {
    {
        let mut segs = url
            .path_segments_mut()
            .map_err(|_| "WebDAV URL 无法拼接路径段".to_string())?;
        segs.pop_if_empty();
        for seg in segments {
            segs.push(seg);
        }
    }
    Ok(url.into())
}

fn webdav_target_url(cfg: &SyncConfig) -> Result<String, String> {
    let (base, segments) = parse_webdav_base_and_segments(cfg)?;
    append_url_segments(base, &segments)
}

async fn webdav_ensure_parents(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    password: &str,
) -> Result<(), String> {
    let (base, parts) = parse_webdav_base_and_segments(cfg)?;
    if parts.len() <= 1 {
        return Ok(());
    }
    let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
    for idx in 1..parts.len() {
        let cur_url = append_url_segments(base.clone(), &parts[..idx])?;
        let resp = client
            .request(mkcol.clone(), &cur_url)
            .basic_auth(cfg.webdav_username.trim(), Some(password))
            .send()
            .await
            .map_err(|e| format!("WebDAV 创建目录失败: {e}"))?;
        let code = resp.status().as_u16();
        // 201 Created, 405 Method Not Allowed (already exists), 301/409 ok to proceed
        if code >= 400 && code != 405 && code != 409 && code != 301 {
            return Err(format!("WebDAV 创建目录返回状态码 {code}"));
        }
    }
    Ok(())
}

async fn webdav_test(cfg: &SyncConfig, password: &str) -> Result<String, String> {
    let (base, _) = parse_webdav_base_and_segments(cfg)?;
    let client = webdav_http_client(cfg)?;
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
    let resp = client
        .request(propfind, base.as_str())
        .header("Depth", "0")
        .basic_auth(cfg.webdav_username.trim(), Some(password))
        .send()
        .await
        .map_err(|e| format!("WebDAV 连接失败: {e}"))?;
    let code = resp.status().as_u16();
    if (200..300).contains(&code) || code == 207 {
        Ok(format!("WebDAV 连接成功（HTTP {code}）"))
    } else if code == 401 || code == 403 {
        Err(format!(
            "WebDAV 认证失败（HTTP {code}），请检查用户名与应用密码"
        ))
    } else {
        Err(format!("WebDAV 返回异常状态码 HTTP {code}"))
    }
}

async fn webdav_read(cfg: &SyncConfig, password: &str) -> Result<Option<Vec<u8>>, String> {
    let url = webdav_target_url(cfg)?;
    let client = webdav_http_client(cfg)?;
    let resp = client
        .get(&url)
        .basic_auth(cfg.webdav_username.trim(), Some(password))
        .send()
        .await
        .map_err(|e| format!("WebDAV 下载失败: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "WebDAV 下载失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    read_response_bounded(resp, MAX_SYNC_BUNDLE_BYTES, "WebDAV")
        .await
        .map(Some)
}

async fn webdav_write(cfg: &SyncConfig, password: &str, data: &[u8]) -> Result<(), String> {
    let client = webdav_http_client(cfg)?;
    let _ = webdav_ensure_parents(&client, cfg, password).await;
    let url = webdav_target_url(cfg)?;
    let resp = client
        .put(&url)
        .basic_auth(cfg.webdav_username.trim(), Some(password))
        .header("Content-Type", "application/json; charset=utf-8")
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| format!("WebDAV 上传失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "WebDAV 上传失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    Ok(())
}

// --- GitHub Gist backend ---

async fn github_test(cfg: &SyncConfig, token: &str) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("请填写 GitHub Personal Access Token（需包含 gist 权限）".to_string());
    }
    let client = http_client()?;
    let resp = client
        .get("https://api.github.com/user")
        .bearer_auth(token.trim())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("连接 GitHub 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub Token 验证失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let login = val
        .get("login")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let gist_note = if cfg.github_gist_id.trim().is_empty() {
        "（首次上传时将自动创建私有 Gist）"
    } else {
        "（已绑定私有 Gist）"
    };
    Ok(format!("GitHub 已验证：@{login}{gist_note}"))
}

fn validate_gist_id(gist_id: &str) -> Result<(), String> {
    if gist_id.is_empty() {
        return Ok(());
    }
    if gist_id.len() > 64 || !gist_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("GitHub Gist ID 格式无效: '{gist_id}'"));
    }
    Ok(())
}

async fn github_read(cfg: &SyncConfig, token: &str) -> Result<Option<Vec<u8>>, String> {
    let gist_id = cfg.github_gist_id.trim();
    if gist_id.is_empty() {
        return Ok(None);
    }
    validate_gist_id(gist_id)?;
    let client = http_client()?;
    let resp = client
        .get(format!("https://api.github.com/gists/{gist_id}"))
        .bearer_auth(token.trim())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("读取 GitHub Gist 失败: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "读取 GitHub Gist 失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let fname = if cfg.github_filename.trim().is_empty() {
        BUNDLE_FILENAME
    } else {
        cfg.github_filename.trim()
    };
    let file_obj = val.get("files").and_then(|f| f.get(fname));
    let Some(file_obj) = file_obj else {
        return Ok(None);
    };
    if file_obj
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && let Some(raw_url) = file_obj.get("raw_url").and_then(|v| v.as_str())
    {
        if !raw_url.starts_with("https://gist.githubusercontent.com/") {
            return Err("安全策略限制：GitHub Gist raw_url 来源域名无效".to_string());
        }
        let raw_resp = client
            .get(raw_url)
            .bearer_auth(token.trim())
            .send()
            .await
            .map_err(|e| format!("下载 Gist 原始内容失败: {e}"))?;
        if !raw_resp.status().is_success() {
            return Err(format!(
                "下载 Gist 原始内容失败（HTTP {}）",
                raw_resp.status().as_u16()
            ));
        }
        let bytes = read_response_bounded(raw_resp, MAX_SYNC_BUNDLE_BYTES, "GitHub Gist").await?;
        return Ok(Some(bytes));
    }
    if let Some(content) = file_obj.get("content").and_then(|v| v.as_str()) {
        if content.len() > MAX_SYNC_BUNDLE_BYTES {
            return Err("GitHub Gist 内容超过安全大小上限".to_string());
        }
        return Ok(Some(content.as_bytes().to_vec()));
    }
    Ok(None)
}

async fn github_write(cfg: &mut SyncConfig, token: &str, data: &[u8]) -> Result<(), String> {
    let client = http_client()?;
    let fname = if cfg.github_filename.trim().is_empty() {
        BUNDLE_FILENAME.to_string()
    } else {
        cfg.github_filename.trim().to_string()
    };
    let content = String::from_utf8(data.to_vec()).map_err(|e| format!("数据非 UTF-8: {e}"))?;

    let mut files = serde_json::Map::new();
    files.insert(fname, serde_json::json!({ "content": content }));

    let gist_id = cfg.github_gist_id.trim().to_string();
    validate_gist_id(&gist_id)?;
    let resp = if gist_id.is_empty() {
        client
            .post("https://api.github.com/gists")
            .bearer_auth(token.trim())
            .header("Accept", "application/vnd.github+json")
            .json(&serde_json::json!({
                "description": "ServerHub Encrypted Sync Vault",
                "public": false,
                "files": files
            }))
            .send()
            .await
            .map_err(|e| format!("创建私有 Gist 失败: {e}"))?
    } else {
        client
            .patch(format!("https://api.github.com/gists/{gist_id}"))
            .bearer_auth(token.trim())
            .header("Accept", "application/vnd.github+json")
            .json(&serde_json::json!({
                "description": "ServerHub Encrypted Sync Vault",
                "files": files
            }))
            .send()
            .await
            .map_err(|e| format!("更新 GitHub Gist 失败: {e}"))?
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub Gist 写入失败（HTTP {code}）: {body}"));
    }

    if gist_id.is_empty() {
        let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(new_id) = val.get("id").and_then(|v| v.as_str()) {
            cfg.github_gist_id = new_id.to_string();
        }
    }
    Ok(())
}

// --- S3 Compatible backend (AWS SigV4) ---

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

fn utc_amz_timestamps() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Civil date from Unix timestamp (Howard Hinnant algorithm)
    let z = secs.div_euclid(86400) + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    let sod = secs.rem_euclid(86400);
    let hour = sod / 3600;
    let min = (sod % 3600) / 60;
    let sec = sod % 60;

    let date_stamp = format!("{year:04}{m:02}{d:02}");
    let amz_date = format!("{date_stamp}T{hour:02}{min:02}{sec:02}Z");
    (amz_date, date_stamp)
}

fn s3_uri_encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
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

fn validate_s3_bucket(bucket: &str) -> Result<(), String> {
    let b = bucket.trim();
    if b.len() < 3
        || b.len() > 63
        || b.contains("..")
        || !b
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
        || !b
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !b
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(format!(
            "S3 Bucket 名称无效: '{bucket}'（仅支持 3-63 位小写字母、数字、点或连字符）"
        ));
    }
    Ok(())
}

fn s3_build_url_and_host(cfg: &SyncConfig) -> Result<(String, String, String), String> {
    let endpoint = cfg.s3_endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("请填写 S3 Endpoint 地址".to_string());
    }
    let key = cfg.s3_object_key.trim().trim_start_matches('/');
    let key = if key.is_empty() { BUNDLE_FILENAME } else { key };
    if key.contains('\\') || key.split('/').any(|seg| seg == "." || seg == "..") {
        return Err(format!("S3 Object Key 包含非法路径段: '{key}'"));
    }

    let parsed = reqwest::Url::parse(endpoint).map_err(|e| format!("S3 Endpoint 格式无效: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "S3 Endpoint 仅支持 http/https 协议，不支持 '{scheme}'"
        ));
    }
    let host_base = parsed
        .host_str()
        .ok_or_else(|| "S3 Endpoint 缺少主机名".to_string())?
        .to_ascii_lowercase();
    let port_suffix = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();

    let url_path_trimmed = parsed.path().trim_matches('/');
    let explicit_bucket = cfg.s3_bucket.trim().trim_matches('/');
    let (bucket, base_path_prefix) = if !explicit_bucket.is_empty() {
        let prefix = if url_path_trimmed.is_empty() || url_path_trimmed == explicit_bucket {
            ""
        } else {
            url_path_trimmed
        };
        (explicit_bucket, prefix)
    } else if !url_path_trimmed.is_empty() {
        (url_path_trimmed, "")
    } else {
        return Err("请填写 S3 Bucket 名称（或在 Endpoint 链接末尾带上 /bucket 名称）".to_string());
    };
    validate_s3_bucket(bucket)?;

    let (host, canonical_uri, full_url) = if cfg.s3_path_style {
        let raw_path = if base_path_prefix.is_empty() {
            format!("/{bucket}/{key}")
        } else {
            format!("/{base_path_prefix}/{bucket}/{key}")
        };
        let uri = s3_uri_encode_path(&raw_path);
        let h = format!("{host_base}{port_suffix}");
        let url = format!("{scheme}://{h}{uri}");
        (h, uri, url)
    } else {
        let raw_path = if base_path_prefix.is_empty() {
            format!("/{key}")
        } else {
            format!("/{base_path_prefix}/{key}")
        };
        let uri = s3_uri_encode_path(&raw_path);
        let bucket_lower = bucket.to_ascii_lowercase();
        let h = if host_base == bucket_lower || host_base.starts_with(&format!("{bucket_lower}.")) {
            format!("{host_base}{port_suffix}")
        } else {
            format!("{bucket_lower}.{host_base}{port_suffix}")
        };
        let url = format!("{scheme}://{h}{uri}");
        (h, uri, url)
    };
    Ok((full_url, host, canonical_uri))
}

async fn s3_signed_request(
    cfg: &SyncConfig,
    secret_key: &str,
    method: Method,
    body: Vec<u8>,
) -> Result<reqwest::Response, String> {
    let access_key = cfg.s3_access_key_id.trim();
    if access_key.is_empty() || secret_key.trim().is_empty() {
        return Err("请填写 S3 Access Key ID 和 Secret Access Key".to_string());
    }
    let region = if cfg.s3_region.trim().is_empty() {
        "us-east-1"
    } else {
        cfg.s3_region.trim()
    };
    let (url, host, canonical_uri) = s3_build_url_and_host(cfg)?;
    let (amz_date, date_stamp) = utc_amz_timestamps();
    let payload_hash = hex_lower(&Sha256::digest(&body));

    let canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "{}\n{}\n\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri,
        canonical_headers,
        signed_headers,
        payload_hash
    );

    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_lower(&Sha256::digest(canonical_request.as_bytes()))
    );

    let mut aws4_key = format!("AWS4{}", secret_key.trim()).into_bytes();
    let mut k_date = hmac_sha256(&aws4_key, date_stamp.as_bytes());
    vault::zeroize_bytes(&mut aws4_key);
    let mut k_region = hmac_sha256(&k_date, region.as_bytes());
    vault::zeroize_bytes(&mut k_date);
    let mut k_service = hmac_sha256(&k_region, b"s3");
    vault::zeroize_bytes(&mut k_region);
    let mut k_signing = hmac_sha256(&k_service, b"aws4_request");
    vault::zeroize_bytes(&mut k_service);
    let signature = hex_lower(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    vault::zeroize_bytes(&mut k_signing);

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let client = http_client()?;
    let mut req = client
        .request(method, &url)
        .header("Host", &host)
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", &payload_hash)
        .header("Authorization", authorization);
    if !body.is_empty() {
        req = req
            .header("Content-Type", "application/json; charset=utf-8")
            .body(body);
    }
    req.send().await.map_err(|e| format!("S3 请求失败: {e}"))
}

async fn s3_test(cfg: &SyncConfig, secret_key: &str) -> Result<String, String> {
    let resp = s3_signed_request(cfg, secret_key, Method::HEAD, Vec::new()).await?;
    let code = resp.status().as_u16();
    if (200..300).contains(&code) {
        Ok("S3 对象存储连接成功（已检测到云端同步文件）".to_string())
    } else if code == 404 {
        Ok("S3 存储桶认证通过（尚无同步文件，可立即上传）".to_string())
    } else if code == 403 || code == 401 {
        Err(format!(
            "S3 认证或权限失败（HTTP {code}），请检查 Access Key / Secret Key / Region"
        ))
    } else {
        Err(format!("S3 返回异常状态码 HTTP {code}"))
    }
}

async fn s3_read(cfg: &SyncConfig, secret_key: &str) -> Result<Option<Vec<u8>>, String> {
    let resp = s3_signed_request(cfg, secret_key, Method::GET, Vec::new()).await?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("S3 下载失败（HTTP {}）", resp.status().as_u16()));
    }
    read_response_bounded(resp, MAX_SYNC_BUNDLE_BYTES, "S3")
        .await
        .map(Some)
}

async fn s3_write(cfg: &SyncConfig, secret_key: &str, data: &[u8]) -> Result<(), String> {
    let resp = s3_signed_request(cfg, secret_key, Method::PUT, data.to_vec()).await?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("S3 上传失败（HTTP {code}）: {body}"));
    }
    Ok(())
}

// --- Google Drive API v3 (appDataFolder) ---

async fn google_refresh_if_needed(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<String, String> {
    if let Some(refresh) = vault::resolve_secret(app, state, SECRET_GOOGLE_REFRESH).await
        && !cfg.google_client_id.trim().is_empty()
    {
        let client_secret = vault::resolve_secret(app, state, SECRET_GOOGLE_CLIENT_SECRET)
            .await
            .unwrap_or_default();
        let mut form = vec![
            ("client_id", cfg.google_client_id.trim().to_string()),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token".to_string()),
        ];
        if !client_secret.trim().is_empty() {
            form.push(("client_secret", client_secret));
        }
        let client = http_client()?;
        let body = encode_form(
            &form
                .iter()
                .map(|(k, v)| (*k, v.as_str()))
                .collect::<Vec<_>>(),
        );
        if let Ok(resp) = client
            .post("https://oauth2.googleapis.com/token")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            && resp.status().is_success()
            && let Ok(val) = resp.json::<serde_json::Value>().await
            && let Some(new_token) = val.get("access_token").and_then(|v| v.as_str())
        {
            let _ = vault::persist_secret(app, state, SECRET_GOOGLE_ACCESS, new_token).await;
            if let Some(new_refresh) = val.get("refresh_token").and_then(|v| v.as_str()) {
                let _ = vault::persist_secret(app, state, SECRET_GOOGLE_REFRESH, new_refresh).await;
            }
            return Ok(new_token.to_string());
        }
    }

    vault::resolve_secret(app, state, SECRET_GOOGLE_ACCESS)
        .await
        .ok_or_else(|| "尚未授权 Google Drive，请先点击「授权登录」或粘贴 Access Token".to_string())
}

fn validate_google_file_id(file_id: &str) -> Result<(), String> {
    if file_id.is_empty()
        || file_id.len() > 256
        || !file_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("Google Drive 返回了无效的文件 ID".to_string());
    }
    Ok(())
}

async fn google_find_file_id(
    client: &reqwest::Client,
    token: &str,
) -> Result<Option<String>, String> {
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D'{BUNDLE_FILENAME}'+and+trashed%3Dfalse&orderBy=modifiedTime+desc&fields=files(id,name,modifiedTime)"
    );
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("查询 Google Drive 文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Google Drive 查询失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = val
        .get("files")
        .and_then(|f| f.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from);
    if let Some(ref fid) = id {
        validate_google_file_id(fid)?;
    }
    Ok(id)
}

async fn google_api_test(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<String, String> {
    let token = google_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    let existing = google_find_file_id(&client, &token).await?;
    Ok(if existing.is_some() {
        "Google Drive API 连接成功（已找到加密同步文件）".to_string()
    } else {
        "Google Drive API 连接成功（appDataFolder 可用）".to_string()
    })
}

async fn google_api_read(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<Option<Vec<u8>>, String> {
    let token = google_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    let Some(file_id) = google_find_file_id(&client, &token).await? else {
        return Ok(None);
    };
    let resp = client
        .get(format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("下载 Google Drive 文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Google Drive 下载失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    read_response_bounded(resp, MAX_SYNC_BUNDLE_BYTES, "Google Drive")
        .await
        .map(Some)
}

async fn google_api_write(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
    data: &[u8],
) -> Result<(), String> {
    let token = google_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    if let Some(file_id) = google_find_file_id(&client, &token).await? {
        let resp = client
            .patch(format!(
                "https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media"
            ))
            .bearer_auth(&token)
            .header("Content-Type", "application/json; charset=utf-8")
            .body(data.to_vec())
            .send()
            .await
            .map_err(|e| format!("更新 Google Drive 文件失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "Google Drive 更新失败（HTTP {}）",
                resp.status().as_u16()
            ));
        }
        return Ok(());
    }

    let boundary = format!("serverhub_sync_{}", uuid::Uuid::new_v4().simple());
    let meta = serde_json::json!({
        "name": BUNDLE_FILENAME,
        "parents": ["appDataFolder"]
    })
    .to_string();
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());

    let resp = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(&token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传 Google Drive 文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Google Drive 上传失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    Ok(())
}

// --- Microsoft OneDrive Graph API (AppFolder) ---

async fn onedrive_refresh_if_needed(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<String, String> {
    if let Some(refresh) = vault::resolve_secret(app, state, SECRET_ONEDRIVE_REFRESH).await
        && !cfg.onedrive_client_id.trim().is_empty()
    {
        let client = http_client()?;
        let form = [
            ("client_id", cfg.onedrive_client_id.trim()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
            ("scope", "Files.ReadWrite.AppFolder offline_access"),
        ];
        if let Ok(resp) = client
            .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(encode_form(&form))
            .send()
            .await
            && resp.status().is_success()
            && let Ok(val) = resp.json::<serde_json::Value>().await
            && let Some(new_token) = val.get("access_token").and_then(|v| v.as_str())
        {
            let _ = vault::persist_secret(app, state, SECRET_ONEDRIVE_ACCESS, new_token).await;
            if let Some(new_refresh) = val.get("refresh_token").and_then(|v| v.as_str()) {
                let _ =
                    vault::persist_secret(app, state, SECRET_ONEDRIVE_REFRESH, new_refresh).await;
            }
            return Ok(new_token.to_string());
        }
    }

    vault::resolve_secret(app, state, SECRET_ONEDRIVE_ACCESS)
        .await
        .ok_or_else(|| {
            "尚未授权 Microsoft OneDrive，请先点击「授权登录」或粘贴 Access Token".to_string()
        })
}

async fn onedrive_api_test(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<String, String> {
    let token = onedrive_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    let resp = client
        .get("https://graph.microsoft.com/v1.0/me/drive/special/approot")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("连接 Microsoft OneDrive 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "OneDrive API 连接失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    Ok("Microsoft OneDrive API 连接成功（应用专属目录可用）".to_string())
}

async fn onedrive_api_read(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<Option<Vec<u8>>, String> {
    let token = onedrive_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    let resp = client
        .get(format!(
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/{BUNDLE_FILENAME}:/content"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("下载 OneDrive 文件失败: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "OneDrive 下载失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    read_response_bounded(resp, MAX_SYNC_BUNDLE_BYTES, "OneDrive")
        .await
        .map(Some)
}

async fn onedrive_api_write(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
    data: &[u8],
) -> Result<(), String> {
    let token = onedrive_refresh_if_needed(app, state, cfg).await?;
    let client = http_client()?;
    let resp = client
        .put(format!(
            "https://graph.microsoft.com/v1.0/me/drive/special/approot:/{BUNDLE_FILENAME}:/content"
        ))
        .bearer_auth(&token)
        .header("Content-Type", "application/json; charset=utf-8")
        .body(data.to_vec())
        .send()
        .await
        .map_err(|e| format!("上传 OneDrive 文件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "OneDrive 上传失败（HTTP {}）",
            resp.status().as_u16()
        ));
    }
    Ok(())
}

// --- Unified Remote Dispatch ---

async fn remote_read(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
) -> Result<Option<Vec<u8>>, String> {
    match cfg.provider {
        SyncProvider::Icloud | SyncProvider::LocalFolder => {
            let p = resolve_folder_file(cfg)?;
            fs_read(&p)
        }
        SyncProvider::GoogleDrive => match cfg.google_mode {
            CloudDriveMode::DesktopFolder => fs_read(&resolve_folder_file(cfg)?),
            CloudDriveMode::Api => google_api_read(app, state, cfg).await,
        },
        SyncProvider::Onedrive => match cfg.onedrive_mode {
            CloudDriveMode::DesktopFolder => fs_read(&resolve_folder_file(cfg)?),
            CloudDriveMode::Api => onedrive_api_read(app, state, cfg).await,
        },
        SyncProvider::Webdav => {
            let pass = vault::resolve_secret(app, state, SECRET_WEBDAV_PASS)
                .await
                .unwrap_or_default();
            webdav_read(cfg, &pass).await
        }
        SyncProvider::GithubGist => {
            let token = vault::resolve_secret(app, state, SECRET_GITHUB_TOKEN)
                .await
                .ok_or("请先填写 GitHub Personal Access Token")?;
            github_read(cfg, &token).await
        }
        SyncProvider::S3 => {
            let secret = vault::resolve_secret(app, state, SECRET_S3_SECRET)
                .await
                .ok_or("请先填写 S3 Secret Access Key")?;
            s3_read(cfg, &secret).await
        }
    }
}

async fn remote_write(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &mut SyncConfig,
    data: &[u8],
) -> Result<(), String> {
    match cfg.provider {
        SyncProvider::Icloud | SyncProvider::LocalFolder => {
            let p = resolve_folder_file(cfg)?;
            fs_write(&p, data)
        }
        SyncProvider::GoogleDrive => match cfg.google_mode {
            CloudDriveMode::DesktopFolder => fs_write(&resolve_folder_file(cfg)?, data),
            CloudDriveMode::Api => google_api_write(app, state, cfg, data).await,
        },
        SyncProvider::Onedrive => match cfg.onedrive_mode {
            CloudDriveMode::DesktopFolder => fs_write(&resolve_folder_file(cfg)?, data),
            CloudDriveMode::Api => onedrive_api_write(app, state, cfg, data).await,
        },
        SyncProvider::Webdav => {
            let pass = vault::resolve_secret(app, state, SECRET_WEBDAV_PASS)
                .await
                .unwrap_or_default();
            webdav_write(cfg, &pass, data).await
        }
        SyncProvider::GithubGist => {
            let token = vault::resolve_secret(app, state, SECRET_GITHUB_TOKEN)
                .await
                .ok_or("请先填写 GitHub Personal Access Token")?;
            github_write(cfg, &token, data).await
        }
        SyncProvider::S3 => {
            let secret = vault::resolve_secret(app, state, SECRET_S3_SECRET)
                .await
                .ok_or("请先填写 S3 Secret Access Key")?;
            s3_write(cfg, &secret, data).await
        }
    }
}

// ============================================================================
// Payload Collection & Application
// ============================================================================

fn server_store(app: &tauri::AppHandle) -> Result<ServerStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(ServerStore::new(dir.join("servers.json")))
}

fn credential_store(app: &tauri::AppHandle) -> Result<CredentialStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(CredentialStore::new(dir.join("credentials.json")))
}

fn ai_store(app: &tauri::AppHandle) -> Result<AiProfileStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    AiProfileStore::open(dir).map_err(|e| e.to_string())
}

async fn build_local_payload(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
    app_settings: Option<serde_json::Value>,
) -> Result<SyncPayload, String> {
    let (servers, credentials, deleted_server_ids, deleted_credential_ids) = if cfg.sync_servers {
        let _guard = state.store_lock.read().await;
        let srv = server_store(app)?.load().map_err(|e| e.to_string())?;
        let creds = credential_store(app)?.load().map_err(|e| e.to_string())?;
        let srv_tombstones = load_tombstone_map(app, TOMBSTONES_FILENAME);
        let cred_tombstones = load_tombstone_map(app, CRED_TOMBSTONES_FILENAME);
        (Some(srv), Some(creds), srv_tombstones, cred_tombstones)
    } else {
        (None, None, HashMap::new(), HashMap::new())
    };

    let (ai_config, deleted_ai_profile_ids) = if cfg.sync_ai_profiles {
        let _guard = state.store_lock.read().await;
        let ai_cfg = ai_store(app)?.load().map_err(|e| e.to_string())?;
        let ai_tombstones = load_tombstone_map(app, AI_TOMBSTONES_FILENAME);
        (Some(ai_cfg), ai_tombstones)
    } else {
        (None, HashMap::new())
    };

    let (secrets, secret_timestamps) = if cfg.sync_secrets {
        let (map, ts) = vault::export_app_secrets_with_timestamps(app, state).await?;
        (Some(map), ts)
    } else {
        (None, HashMap::new())
    };

    Ok(SyncPayload {
        schema_version: 1,
        device_name: cfg.device_name.clone(),
        updated_at: now_unix_secs(),
        servers,
        credentials,
        deleted_server_ids,
        deleted_credential_ids,
        deleted_ai_profile_ids,
        secrets,
        secret_timestamps,
        ai_config,
        app_settings: if cfg.sync_app_settings {
            sanitize_synced_app_settings(app_settings)
        } else {
            None
        },
    })
}

fn merge_servers(
    local: &[Server],
    remote: &[Server],
    tombstones: &HashMap<String, i64>,
) -> (Vec<Server>, HashSet<String>) {
    let mut map: HashMap<uuid::Uuid, Server> = HashMap::new();
    let mut remote_won = HashSet::new();
    for s in local {
        map.insert(s.id, s.clone());
    }
    for r in remote {
        match map.get(&r.id) {
            Some(l) if l.updated_at >= r.updated_at => {}
            _ => {
                remote_won.insert(r.id.to_string());
                map.insert(r.id, r.clone());
            }
        }
    }
    map.retain(|id, srv| match tombstones.get(&id.to_string()) {
        Some(&deleted_at) if deleted_at >= srv.updated_at => {
            remote_won.remove(&id.to_string());
            false
        }
        _ => true,
    });
    let mut list: Vec<Server> = map.into_values().collect();
    list.sort_by_key(|a| a.name.to_lowercase());
    (list, remote_won)
}

fn merge_credentials(
    local: &[Credential],
    remote: &[Credential],
    tombstones: &HashMap<String, i64>,
) -> (Vec<Credential>, HashSet<String>) {
    let mut map: HashMap<uuid::Uuid, Credential> = HashMap::new();
    let mut remote_won = HashSet::new();
    for c in local {
        map.insert(c.id, c.clone());
    }
    for r in remote {
        match map.get(&r.id) {
            Some(l) if l.updated_at >= r.updated_at => {}
            _ => {
                remote_won.insert(format!("cred:{}", r.id));
                map.insert(r.id, r.clone());
            }
        }
    }
    map.retain(|id, cred| match tombstones.get(&id.to_string()) {
        Some(&deleted_at) if deleted_at >= cred.updated_at => {
            remote_won.remove(&format!("cred:{id}"));
            false
        }
        _ => true,
    });
    let mut list: Vec<Credential> = map.into_values().collect();
    list.sort_by_key(|a| a.name.to_lowercase());
    (list, remote_won)
}

fn merge_ai_config(
    local: &AiConfigData,
    remote: &AiConfigData,
    tombstones: &HashMap<String, i64>,
) -> (AiConfigData, HashSet<String>) {
    let mut by_id: HashMap<String, _> = local
        .profiles
        .iter()
        .map(|p| (p.id.clone(), p.clone()))
        .collect();
    let mut remote_won = HashSet::new();
    for rp in &remote.profiles {
        match by_id.get(&rp.id) {
            Some(lp) if lp.updated_at >= rp.updated_at => {}
            _ => {
                remote_won.insert(format!("ai:{}", rp.id));
                by_id.insert(rp.id.clone(), rp.clone());
            }
        }
    }
    by_id.retain(|id, profile| match tombstones.get(id) {
        Some(&deleted_at) if deleted_at.max(0) as u64 >= profile.updated_at => {
            remote_won.remove(&format!("ai:{id}"));
            false
        }
        _ => true,
    });
    let mut profiles: Vec<_> = by_id.into_values().collect();
    profiles.sort_by_key(|a| a.name.to_lowercase());

    let has_id = |candidate: &Option<String>| -> bool {
        candidate
            .as_deref()
            .is_some_and(|cid| profiles.iter().any(|p| p.id == cid))
    };
    let default_profile_id = if has_id(&local.default_profile_id) {
        local.default_profile_id.clone()
    } else if has_id(&remote.default_profile_id) {
        remote.default_profile_id.clone()
    } else {
        profiles.first().map(|p| p.id.clone())
    };

    (
        AiConfigData {
            default_profile_id,
            profiles,
        },
        remote_won,
    )
}

async fn apply_remote_payload(
    app: &tauri::AppHandle,
    state: &AppState,
    cfg: &SyncConfig,
    payload: &SyncPayload,
    merge: bool,
) -> Result<(usize, usize, usize, Option<serde_json::Value>), String> {
    let mut servers_count = 0usize;
    let mut secrets_count = 0usize;
    let mut ai_count = 0usize;

    let mut remote_won_servers = HashSet::new();
    let mut remote_won_creds = HashSet::new();
    let mut remote_won_ai = HashSet::new();
    let mut dead_secret_keys = HashSet::new();
    let mut servers_changed = false;

    if cfg.sync_servers
        && let Some(remote_servers) = &payload.servers
    {
        let _guard = state.store_lock.write().await;
        let store = server_store(app)?;
        let (final_servers, active_tombstones) = if merge {
            let local = store.load().map_err(|e| e.to_string())?;
            let merged_tombstones = merge_tombstone_maps(
                &load_tombstone_map(app, TOMBSTONES_FILENAME),
                &payload.deleted_server_ids,
            );
            save_tombstone_map(app, TOMBSTONES_FILENAME, &merged_tombstones);
            let (merged, won) = merge_servers(&local, remote_servers, &merged_tombstones);
            remote_won_servers = won;
            (merged, merged_tombstones)
        } else {
            save_tombstone_map(app, TOMBSTONES_FILENAME, &payload.deleted_server_ids);
            (remote_servers.clone(), payload.deleted_server_ids.clone())
        };
        let surviving_ids: HashSet<String> =
            final_servers.iter().map(|s| s.id.to_string()).collect();
        for dead_id in active_tombstones.keys() {
            if !surviving_ids.contains(dead_id) {
                dead_secret_keys.insert(dead_id.clone());
            }
        }
        servers_count = final_servers.len();
        store.save(&final_servers).map_err(|e| e.to_string())?;
        servers_changed = true;
    }

    if cfg.sync_servers
        && let Some(remote_creds) = &payload.credentials
    {
        let _guard = state.store_lock.write().await;
        let store = credential_store(app)?;
        let (final_creds, active_tombstones) = if merge {
            let local = store.load().map_err(|e| e.to_string())?;
            let merged_tombstones = merge_tombstone_maps(
                &load_tombstone_map(app, CRED_TOMBSTONES_FILENAME),
                &payload.deleted_credential_ids,
            );
            save_tombstone_map(app, CRED_TOMBSTONES_FILENAME, &merged_tombstones);
            let (merged, won) = merge_credentials(&local, remote_creds, &merged_tombstones);
            remote_won_creds = won;
            (merged, merged_tombstones)
        } else {
            save_tombstone_map(
                app,
                CRED_TOMBSTONES_FILENAME,
                &payload.deleted_credential_ids,
            );
            (remote_creds.clone(), payload.deleted_credential_ids.clone())
        };
        let surviving_ids: HashSet<String> = final_creds.iter().map(|c| c.id.to_string()).collect();
        for dead_id in active_tombstones.keys() {
            if !surviving_ids.contains(dead_id) {
                dead_secret_keys.insert(format!("cred:{dead_id}"));
            }
        }
        store.save(&final_creds).map_err(|e| e.to_string())?;
        servers_changed = true;
    }

    if cfg.sync_ai_profiles
        && let Some(remote_ai) = &payload.ai_config
    {
        let _guard = state.store_lock.write().await;
        let store = ai_store(app)?;
        let (final_ai, active_tombstones) = if merge {
            let local = store.load().map_err(|e| e.to_string())?;
            let merged_tombstones = merge_tombstone_maps(
                &load_tombstone_map(app, AI_TOMBSTONES_FILENAME),
                &payload.deleted_ai_profile_ids,
            );
            save_tombstone_map(app, AI_TOMBSTONES_FILENAME, &merged_tombstones);
            let (merged, won) = merge_ai_config(&local, remote_ai, &merged_tombstones);
            remote_won_ai = won;
            (merged, merged_tombstones)
        } else {
            save_tombstone_map(app, AI_TOMBSTONES_FILENAME, &payload.deleted_ai_profile_ids);
            (remote_ai.clone(), payload.deleted_ai_profile_ids.clone())
        };
        let surviving_ids: HashSet<String> =
            final_ai.profiles.iter().map(|p| p.id.clone()).collect();
        for dead_id in active_tombstones.keys() {
            if !surviving_ids.contains(dead_id) {
                dead_secret_keys.insert(format!("ai:{dead_id}"));
            }
        }
        ai_count = final_ai.profiles.len();
        store.save(&final_ai).map_err(|e| e.to_string())?;
    }

    if cfg.sync_secrets
        && let Some(remote_secrets) = &payload.secrets
    {
        let (secrets_to_import, ts_to_import): (HashMap<String, String>, HashMap<String, i64>) =
            if merge {
                let (local_secrets, local_ts) =
                    vault::export_app_secrets_with_timestamps(app, state).await?;
                let remote_is_newer = payload.updated_at > cfg.last_sync_at.unwrap_or(0);
                let mut out_map = HashMap::new();
                let mut out_ts = HashMap::new();
                for (k, v) in remote_secrets {
                    if dead_secret_keys.contains(k) {
                        continue;
                    }
                    let take_remote = if !local_secrets.contains_key(k) {
                        true
                    } else if let (Some(&r_ts), Some(&l_ts)) =
                        (payload.secret_timestamps.get(k), local_ts.get(k))
                        && r_ts != l_ts
                    {
                        r_ts > l_ts
                    } else if k.starts_with("cred:") {
                        remote_won_creds.contains(k)
                    } else if k.starts_with("ai:") {
                        remote_won_ai.contains(k)
                    } else if uuid::Uuid::parse_str(k).is_ok() {
                        remote_won_servers.contains(k)
                    } else {
                        remote_is_newer
                    };
                    if take_remote {
                        out_map.insert(k.clone(), v.clone());
                        if let Some(&r_ts) = payload.secret_timestamps.get(k) {
                            out_ts.insert(k.clone(), r_ts);
                        }
                    }
                }
                (out_map, out_ts)
            } else {
                let mut out_map = HashMap::new();
                let mut out_ts = HashMap::new();
                for (k, v) in remote_secrets {
                    if !dead_secret_keys.contains(k) {
                        out_map.insert(k.clone(), v.clone());
                        if let Some(&r_ts) = payload.secret_timestamps.get(k) {
                            out_ts.insert(k.clone(), r_ts);
                        }
                    }
                }
                (out_map, out_ts)
            };
        secrets_count =
            vault::import_app_secrets_with_timestamps(app, state, secrets_to_import, &ts_to_import)
                .await?;
    }

    // Purge local vault secrets for tombstoned servers/credentials/AI profiles in one batch
    // so deleted items don't linger or get re-uploaded on subsequent syncs.
    if !dead_secret_keys.is_empty() {
        let _ = vault::delete_app_secrets_batch(app, state, dead_secret_keys.into_iter().collect())
            .await;
    }

    if servers_changed {
        state.evict_all_server_caches().await;
    }

    let pulled_settings = if cfg.sync_app_settings {
        sanitize_synced_app_settings(payload.app_settings.clone())
    } else {
        None
    };

    Ok((servers_count, secrets_count, ai_count, pulled_settings))
}

// ============================================================================
// Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn sync_config_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SyncConfigResponse, String> {
    let config = load_config(&app)?;
    let secrets = secret_flags(&app, &state).await;
    Ok(SyncConfigResponse { config, secrets })
}

#[tauri::command]
pub async fn sync_config_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut config: SyncConfig,
    secrets: Option<SyncSecretPatch>,
) -> Result<SyncConfigResponse, String> {
    let _sync_guard = state.sync_lock.lock().await;
    // Preserve backend-owned sync status metadata so stale frontend config objects don't clobber it.
    if let Ok(existing) = load_config(&app) {
        config.last_sync_at = existing.last_sync_at;
        config.last_sync_status = existing.last_sync_status;
        config.last_sync_message = existing.last_sync_message;
    }

    if let Some(patch) = secrets {
        let google_access_replaced = patch
            .google_access_token
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
        let onedrive_access_replaced = patch
            .onedrive_access_token
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());

        apply_secret_patch(
            &app,
            &state,
            SECRET_PASSPHRASE,
            patch.passphrase,
            patch.clear_passphrase,
        )
        .await?;
        apply_secret_patch(
            &app,
            &state,
            SECRET_WEBDAV_PASS,
            patch.webdav_password,
            patch.clear_webdav_password,
        )
        .await?;
        apply_secret_patch(
            &app,
            &state,
            SECRET_GITHUB_TOKEN,
            patch.github_token,
            patch.clear_github_token,
        )
        .await?;
        apply_secret_patch(
            &app,
            &state,
            SECRET_S3_SECRET,
            patch.s3_secret_key,
            patch.clear_s3_secret_key,
        )
        .await?;
        apply_secret_patch(
            &app,
            &state,
            SECRET_GOOGLE_ACCESS,
            patch.google_access_token,
            patch.clear_google_token,
        )
        .await?;
        if patch.clear_google_token.unwrap_or(false) || google_access_replaced {
            let _ = vault::delete_secret(&app, &state, SECRET_GOOGLE_REFRESH).await;
        }
        apply_secret_patch(
            &app,
            &state,
            SECRET_GOOGLE_CLIENT_SECRET,
            patch.google_client_secret,
            patch.clear_google_client_secret,
        )
        .await?;
        apply_secret_patch(
            &app,
            &state,
            SECRET_ONEDRIVE_ACCESS,
            patch.onedrive_access_token,
            patch.clear_onedrive_token,
        )
        .await?;
        if patch.clear_onedrive_token.unwrap_or(false) || onedrive_access_replaced {
            let _ = vault::delete_secret(&app, &state, SECRET_ONEDRIVE_REFRESH).await;
        }
    }

    save_config(&app, &config)?;
    let flags = secret_flags(&app, &state).await;
    Ok(SyncConfigResponse {
        config,
        secrets: flags,
    })
}

#[tauri::command]
pub async fn sync_detect_clouds() -> Result<DetectedLocalClouds, String> {
    Ok(DetectedLocalClouds {
        icloud_path: detect_icloud_dir().map(|p| p.display().to_string()),
        google_drive_path: detect_google_drive_dir().map(|p| p.display().to_string()),
        onedrive_path: detect_onedrive_dir().map(|p| p.display().to_string()),
        dropbox_path: detect_dropbox_dir().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub async fn sync_test_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: Option<SyncConfig>,
) -> Result<String, String> {
    let saved_cfg = load_config(&app).ok();
    let is_override = config.is_some();
    let cfg = match config {
        Some(c) => c,
        None => saved_cfg.clone().unwrap_or_default(),
    };
    match cfg.provider {
        SyncProvider::Icloud | SyncProvider::LocalFolder => {
            let p = resolve_folder_file(&cfg)?;
            fs_test(&p)
        }
        SyncProvider::GoogleDrive => match cfg.google_mode {
            CloudDriveMode::DesktopFolder => fs_test(&resolve_folder_file(&cfg)?),
            CloudDriveMode::Api => google_api_test(&app, &state, &cfg).await,
        },
        SyncProvider::Onedrive => match cfg.onedrive_mode {
            CloudDriveMode::DesktopFolder => fs_test(&resolve_folder_file(&cfg)?),
            CloudDriveMode::Api => onedrive_api_test(&app, &state, &cfg).await,
        },
        SyncProvider::Webdav => {
            let target_origin = url_origin(&cfg.webdav_url)?;
            let stored_pass = vault::resolve_secret(&app, &state, SECRET_WEBDAV_PASS).await;
            let pass = if is_override && stored_pass.is_some() {
                let saved_origin = saved_cfg
                    .as_ref()
                    .and_then(|s| url_origin(&s.webdav_url).ok());
                if saved_origin.as_deref() != Some(target_origin.as_str()) {
                    return Err(
                        "出于安全考虑，修改 WebDAV 服务器地址后请先点击「保存配置」，再测试连接"
                            .to_string(),
                    );
                }
                stored_pass.unwrap_or_default()
            } else {
                stored_pass.unwrap_or_default()
            };
            webdav_test(&cfg, &pass).await
        }
        SyncProvider::GithubGist => {
            let token = vault::resolve_secret(&app, &state, SECRET_GITHUB_TOKEN)
                .await
                .unwrap_or_default();
            github_test(&cfg, &token).await
        }
        SyncProvider::S3 => {
            let target_origin = url_origin(&cfg.s3_endpoint)?;
            let stored_secret = vault::resolve_secret(&app, &state, SECRET_S3_SECRET).await;
            let secret = if is_override && stored_secret.is_some() {
                let saved_origin = saved_cfg
                    .as_ref()
                    .and_then(|s| url_origin(&s.s3_endpoint).ok());
                if saved_origin.as_deref() != Some(target_origin.as_str()) {
                    return Err(
                        "出于安全考虑，修改 S3 Endpoint 地址后请先点击「保存配置」，再测试连接"
                            .to_string(),
                    );
                }
                stored_secret.unwrap_or_default()
            } else {
                stored_secret.unwrap_or_default()
            };
            s3_test(&cfg, &secret).await
        }
    }
}

fn format_sync_counts(servers: usize, secrets: usize, ai: usize) -> String {
    let mut parts = Vec::new();
    if servers > 0 || (secrets == 0 && ai == 0) {
        parts.push(format!("{servers} 台服务器"));
    }
    if secrets > 0 {
        parts.push(format!("{secrets} 条密钥"));
    }
    if ai > 0 {
        parts.push(format!("{ai} 个 AI 配置"));
    }
    parts.join(" · ")
}

async fn sync_push_locked(
    app: &tauri::AppHandle,
    state: &AppState,
    app_settings: Option<serde_json::Value>,
) -> Result<SyncActionResult, String> {
    let mut cfg = load_config(app)?;
    let passphrase = vault::resolve_secret(app, state, SECRET_PASSPHRASE).await;
    if cfg.sync_secrets
        && passphrase
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("已开启「同步密钥与密码」，请先设置同步加密主密码以保护端到端安全".to_string());
    }

    let payload = build_local_payload(app, state, &cfg, app_settings).await?;
    let payload_for_enc = payload.clone();
    let pass_for_enc = passphrase.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        encode_envelope(&payload_for_enc, pass_for_enc.as_deref())
    })
    .await
    .map_err(|e| format!("加密同步数据任务失败: {e}"))??;
    remote_write(app, state, &mut cfg, &bytes).await?;

    let now = now_unix_secs();
    let servers_count = payload.servers.as_ref().map_or(0, Vec::len);
    let secrets_count = payload.secrets.as_ref().map_or(0, HashMap::len);
    let ai_count = payload.ai_config.as_ref().map_or(0, |a| a.profiles.len());
    let msg = format!(
        "已上传 · {}",
        format_sync_counts(servers_count, secrets_count, ai_count)
    );

    cfg.last_sync_at = Some(now);
    cfg.last_sync_status = Some("ok".to_string());
    cfg.last_sync_message = Some(msg.clone());
    save_config(app, &cfg)?;

    Ok(SyncActionResult {
        ok: true,
        action: "push".to_string(),
        message: msg,
        synced_at: now,
        servers_count,
        secrets_count,
        ai_profiles_count: ai_count,
        pulled_app_settings: None,
        config: cfg,
    })
}

async fn sync_pull_locked(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<SyncActionResult, String> {
    let mut cfg = load_config(app)?;
    let passphrase = vault::resolve_secret(app, state, SECRET_PASSPHRASE).await;
    let has_passphrase = passphrase
        .as_deref()
        .map(str::trim)
        .is_some_and(|p| !p.is_empty());
    if cfg.sync_secrets && !has_passphrase {
        return Err("已开启「同步密钥与密码」，请先设置同步加密主密码以保护端到端安全".to_string());
    }
    let Some(raw) = remote_read(app, state, &cfg).await? else {
        return Err("云端尚未找到同步文件，请先在源设备上执行一次「上传到云端」".to_string());
    };
    let require_encrypted = cfg.sync_secrets || has_passphrase;
    let pass_for_dec = passphrase.clone();
    let payload = tokio::task::spawn_blocking(move || {
        decode_envelope(&raw, pass_for_dec.as_deref(), require_encrypted)
    })
    .await
    .map_err(|e| format!("解密同步数据任务失败: {e}"))??;
    let (servers_count, secrets_count, ai_count, pulled_settings) =
        apply_remote_payload(app, state, &cfg, &payload, false).await?;

    let now = now_unix_secs();
    let msg = format!(
        "已拉取 · {}",
        format_sync_counts(servers_count, secrets_count, ai_count)
    );
    cfg.last_sync_at = Some(now);
    cfg.last_sync_status = Some("ok".to_string());
    cfg.last_sync_message = Some(msg.clone());
    save_config(app, &cfg)?;

    Ok(SyncActionResult {
        ok: true,
        action: "pull".to_string(),
        message: msg,
        synced_at: now,
        servers_count,
        secrets_count,
        ai_profiles_count: ai_count,
        pulled_app_settings: pulled_settings,
        config: cfg,
    })
}

#[tauri::command]
pub async fn sync_push(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    app_settings: Option<serde_json::Value>,
) -> Result<SyncActionResult, String> {
    let _sync_guard = state.sync_lock.lock().await;
    sync_push_locked(&app, &state, app_settings).await
}

#[tauri::command]
pub async fn sync_pull(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SyncActionResult, String> {
    let _sync_guard = state.sync_lock.lock().await;
    sync_pull_locked(&app, &state).await
}

#[tauri::command]
pub async fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    app_settings: Option<serde_json::Value>,
) -> Result<SyncActionResult, String> {
    let _sync_guard = state.sync_lock.lock().await;
    let mut cfg = load_config(&app)?;
    let passphrase = vault::resolve_secret(&app, &state, SECRET_PASSPHRASE).await;
    if cfg.sync_secrets
        && passphrase
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err("已开启「同步密钥与密码」，请先设置同步加密主密码以保护端到端安全".to_string());
    }

    match cfg.conflict_strategy {
        ConflictStrategy::Local => return sync_push_locked(&app, &state, app_settings).await,
        ConflictStrategy::Remote => return sync_pull_locked(&app, &state).await,
        ConflictStrategy::Latest => {}
    }

    let remote_raw = remote_read(&app, &state, &cfg).await?;
    let mut pulled_settings = None;

    if let Some(raw) = remote_raw {
        let has_passphrase = passphrase
            .as_deref()
            .map(str::trim)
            .is_some_and(|p| !p.is_empty());
        let require_encrypted = cfg.sync_secrets || has_passphrase;
        let pass_for_dec = passphrase.clone();
        let remote_payload = tokio::task::spawn_blocking(move || {
            decode_envelope(&raw, pass_for_dec.as_deref(), require_encrypted)
        })
        .await
        .map_err(|e| format!("解密同步数据任务失败: {e}"))??;
        let (_, _, _, settings_opt) =
            apply_remote_payload(&app, &state, &cfg, &remote_payload, true).await?;
        if remote_payload.updated_at > cfg.last_sync_at.unwrap_or(0) {
            pulled_settings = settings_opt;
        }
    }

    let merged_settings = pulled_settings.clone().or(app_settings);
    let merged_payload = build_local_payload(&app, &state, &cfg, merged_settings).await?;
    let payload_for_enc = merged_payload.clone();
    let pass_for_enc = passphrase.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        encode_envelope(&payload_for_enc, pass_for_enc.as_deref())
    })
    .await
    .map_err(|e| format!("加密同步数据任务失败: {e}"))??;
    remote_write(&app, &state, &mut cfg, &bytes).await?;

    let now = now_unix_secs();
    let servers_count = merged_payload.servers.as_ref().map_or(0, Vec::len);
    let secrets_count = merged_payload.secrets.as_ref().map_or(0, HashMap::len);
    let ai_count = merged_payload
        .ai_config
        .as_ref()
        .map_or(0, |a| a.profiles.len());
    let msg = format!(
        "已同步 · {}",
        format_sync_counts(servers_count, secrets_count, ai_count)
    );
    cfg.last_sync_at = Some(now);
    cfg.last_sync_status = Some("ok".to_string());
    cfg.last_sync_message = Some(msg.clone());
    save_config(&app, &cfg)?;

    Ok(SyncActionResult {
        ok: true,
        action: "sync".to_string(),
        message: msg,
        synced_at: now,
        servers_count,
        secrets_count,
        ai_profiles_count: ai_count,
        pulled_app_settings: pulled_settings,
        config: cfg,
    })
}

// --- OAuth 2.0 PKCE Loopback Flow for Google Drive & OneDrive ---

fn extract_query_param(request_line: &str, key: &str) -> Option<String> {
    let path = request_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k == key {
            return Some(url_decode(v));
        }
    }
    None
}

fn url_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
                && let Ok(val) = u8::from_str_radix(hex, 16)
            {
                out.push(val);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn url_encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
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

fn encode_form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode_component(k), url_encode_component(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[tauri::command]
pub async fn sync_oauth_authorize(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider: SyncProvider,
) -> Result<SyncConfigResponse, String> {
    let cfg = load_config(&app)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("启动本地 OAuth 回调监听失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let mut verifier_bytes = [0u8; 32];
    let mut state_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut verifier_bytes);
    OsRng.fill_bytes(&mut state_bytes);
    let code_verifier = B64URL.encode(verifier_bytes);
    let code_challenge = B64URL.encode(Sha256::digest(code_verifier.as_bytes()));
    let oauth_state = B64URL.encode(state_bytes);

    let auth_url = match provider {
        SyncProvider::GoogleDrive => {
            if cfg.google_client_id.trim().is_empty() {
                return Err("请先填写 Google OAuth Client ID（桌面应用类型）".to_string());
            }
            format!(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
                url_encode_component(cfg.google_client_id.trim()),
                url_encode_component(&redirect_uri),
                url_encode_component("https://www.googleapis.com/auth/drive.appdata email"),
                code_challenge,
                oauth_state
            )
        }
        SyncProvider::Onedrive => {
            if cfg.onedrive_client_id.trim().is_empty() {
                return Err("请先填写 Microsoft Entra / Azure 应用 Client ID".to_string());
            }
            format!(
                "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
                url_encode_component(cfg.onedrive_client_id.trim()),
                url_encode_component(&redirect_uri),
                url_encode_component("Files.ReadWrite.AppFolder offline_access User.Read"),
                code_challenge,
                oauth_state
            )
        }
        _ => return Err("仅 Google Drive 和 Microsoft OneDrive 支持 OAuth 授权".to_string()),
    };

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("无法打开浏览器完成授权: {e}"))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let expected_host_1 = format!("127.0.0.1:{port}");
    let expected_host_2 = format!("localhost:{port}");
    let mut invalid_attempts = 0usize;
    let (code, err_param) = loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("等待浏览器授权超时（180 秒），请重试".to_string());
        }
        let (mut stream, _) = tokio::time::timeout(deadline - now, listener.accept())
            .await
            .map_err(|_| "等待浏览器授权超时（180 秒），请重试".to_string())?
            .map_err(|e| format!("接收回调失败: {e}"))?;

        // Read complete HTTP request headers up to \r\n\r\n (bounded to 16 KiB).
        let mut req_buf = Vec::with_capacity(2048);
        let read_ok = tokio::time::timeout(Duration::from_secs(5), async {
            let mut tmp = [0u8; 2048];
            while req_buf.len() < 16 * 1024 {
                match stream.read(&mut tmp).await {
                    Ok(0) => break,
                    Ok(n) => {
                        req_buf.extend_from_slice(&tmp[..n]);
                        if req_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => return false,
                }
            }
            !req_buf.is_empty()
        })
        .await
        .unwrap_or(false);
        if !read_ok {
            continue;
        }

        let req_str = String::from_utf8_lossy(&req_buf);
        let mut lines = req_str.lines();
        let first_line = lines.next().unwrap_or("");
        let mut parts = first_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("");
        let path_only = target.split('?').next().unwrap_or("");
        let host_hdr = lines.take_while(|l| !l.trim().is_empty()).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("host")
                .then(|| v.trim().to_ascii_lowercase())
        });

        let host_ok = host_hdr
            .as_deref()
            .is_some_and(|h| h == expected_host_1 || h == expected_host_2);
        if method != "GET" || !host_ok || path_only != "/callback" {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }

        let code = extract_query_param(first_line, "code");
        let ret_state = extract_query_param(first_line, "state");
        let err_param = extract_query_param(first_line, "error");
        let state_matches = ret_state.as_deref().is_some_and(|s| {
            s.len() == oauth_state.len() && bool::from(s.as_bytes().ct_eq(oauth_state.as_bytes()))
        });
        // Validate OAuth state in constant time BEFORE acting on code/error; ignore stray probes.
        if !state_matches || (code.is_none() && err_param.is_none()) {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            invalid_attempts += 1;
            if invalid_attempts >= 20 {
                return Err("OAuth 回调收到过多无效请求，已中止授权".to_string());
            }
            continue;
        }

        let html = if code.is_some() && err_param.is_none() {
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body style='font-family:-apple-system,sans-serif;text-align:center;padding:48px'><h2>ServerHub 授权成功</h2><p>可以关闭此页面并返回应用。</p></body></html>"
        } else {
            "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<html><body style='font-family:-apple-system,sans-serif;text-align:center;padding:48px'><h2>授权未完成</h2><p>请返回 ServerHub 重试。</p></body></html>"
        };
        let _ = stream.write_all(html.as_bytes()).await;
        break (code, err_param);
    };

    if let Some(e) = err_param {
        return Err(format!("授权被拒绝或失败: {e}"));
    }
    let code = code.ok_or("回调中缺少授权码 code")?;

    let client = http_client()?;
    let mut fetched_google_email: Option<String> = None;
    let mut fetched_onedrive_email: Option<String> = None;
    match provider {
        SyncProvider::GoogleDrive => {
            let client_secret = vault::resolve_secret(&app, &state, SECRET_GOOGLE_CLIENT_SECRET)
                .await
                .unwrap_or_default();
            let mut form = vec![
                ("client_id", cfg.google_client_id.trim().to_string()),
                ("code", code),
                ("code_verifier", code_verifier),
                ("grant_type", "authorization_code".to_string()),
                ("redirect_uri", redirect_uri),
            ];
            if !client_secret.trim().is_empty() {
                form.push(("client_secret", client_secret));
            }
            let body = encode_form(
                &form
                    .iter()
                    .map(|(k, v)| (*k, v.as_str()))
                    .collect::<Vec<_>>(),
            );
            let resp = client
                .post("https://oauth2.googleapis.com/token")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body)
                .send()
                .await
                .map_err(|e| format!("换取 Google Token 失败: {e}"))?;
            if !resp.status().is_success() {
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!("Google Token 换取失败: {txt}"));
            }
            let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let at = val
                .get("access_token")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Google Token 响应缺少 access_token".to_string())?;
            vault::persist_secret(&app, &state, SECRET_GOOGLE_ACCESS, at).await?;
            if let Some(rt) = val.get("refresh_token").and_then(|v| v.as_str()) {
                vault::persist_secret(&app, &state, SECRET_GOOGLE_REFRESH, rt).await?;
            }
            if let Ok(info_resp) = client
                .get("https://www.googleapis.com/oauth2/v2/userinfo")
                .bearer_auth(at)
                .send()
                .await
                && info_resp.status().is_success()
                && let Ok(info) = info_resp.json::<serde_json::Value>().await
                && let Some(mail) = info.get("email").and_then(|v| v.as_str())
            {
                fetched_google_email = Some(mail.to_string());
            }
        }
        SyncProvider::Onedrive => {
            let form = [
                ("client_id", cfg.onedrive_client_id.trim()),
                ("code", code.as_str()),
                ("code_verifier", code_verifier.as_str()),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect_uri.as_str()),
                (
                    "scope",
                    "Files.ReadWrite.AppFolder offline_access User.Read",
                ),
            ];
            let resp = client
                .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(encode_form(&form))
                .send()
                .await
                .map_err(|e| format!("换取 Microsoft Token 失败: {e}"))?;
            if !resp.status().is_success() {
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!("Microsoft Token 换取失败: {txt}"));
            }
            let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let at = val
                .get("access_token")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Microsoft Token 响应缺少 access_token".to_string())?;
            vault::persist_secret(&app, &state, SECRET_ONEDRIVE_ACCESS, at).await?;
            if let Ok(me_resp) = client
                .get("https://graph.microsoft.com/v1.0/me")
                .bearer_auth(at)
                .send()
                .await
                && me_resp.status().is_success()
                && let Ok(me) = me_resp.json::<serde_json::Value>().await
                && let Some(mail) = me
                    .get("userPrincipalName")
                    .or_else(|| me.get("mail"))
                    .and_then(|v| v.as_str())
            {
                fetched_onedrive_email = Some(mail.to_string());
            }
            if let Some(rt) = val.get("refresh_token").and_then(|v| v.as_str()) {
                vault::persist_secret(&app, &state, SECRET_ONEDRIVE_REFRESH, rt).await?;
            }
        }
        _ => {}
    }

    // Acquire sync_lock and reload latest config so concurrent user edits are not overwritten.
    let _sync_guard = state.sync_lock.lock().await;
    let mut fresh_cfg = load_config(&app)?;
    match provider {
        SyncProvider::GoogleDrive => {
            fresh_cfg.google_mode = CloudDriveMode::Api;
            if let Some(mail) = fetched_google_email {
                fresh_cfg.google_account_email = mail;
            }
        }
        SyncProvider::Onedrive => {
            fresh_cfg.onedrive_mode = CloudDriveMode::Api;
            if let Some(mail) = fetched_onedrive_email {
                fresh_cfg.onedrive_account_email = mail;
            }
        }
        _ => {}
    }
    save_config(&app, &fresh_cfg)?;
    let flags = secret_flags(&app, &state).await;
    Ok(SyncConfigResponse {
        config: fresh_cfg,
        secrets: flags,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_envelope_roundtrip_and_kdf_validation() {
        assert_eq!(PBKDF2_ITERATIONS, 600_000);

        let payload = SyncPayload {
            schema_version: 1,
            device_name: "MacBook-Pro".to_string(),
            updated_at: 1_700_000_000,
            servers: Some(Vec::new()),
            credentials: None,
            deleted_server_ids: HashMap::new(),
            deleted_credential_ids: HashMap::new(),
            deleted_ai_profile_ids: HashMap::new(),
            secrets: Some(HashMap::from([(
                "srv-1".to_string(),
                "super-secret".to_string(),
            )])),
            secret_timestamps: HashMap::from([("srv-1".to_string(), 1_700_000_000)]),
            ai_config: None,
            app_settings: Some(serde_json::json!({ "uiScale": 100 })),
        };

        let encoded = encode_envelope_with_iterations(&payload, Some("my-master-pass"), 10_000)
            .expect("encode");
        let raw_str = String::from_utf8_lossy(&encoded);
        assert!(!raw_str.contains("super-secret"));

        let err = decode_envelope(&encoded, Some("wrong-pass"), true);
        assert!(err.is_err());

        let decoded = decode_envelope(&encoded, Some("my-master-pass"), true).expect("decode");
        assert_eq!(decoded.device_name, "MacBook-Pro");
        assert_eq!(
            decoded
                .secrets
                .as_ref()
                .and_then(|m| m.get("srv-1"))
                .map(String::as_str),
            Some("super-secret")
        );

        // Plaintext downgrade must be rejected whenever require_encrypted is true or secrets are present.
        let plain_no_secrets = SyncPayload {
            secrets: None,
            ..payload.clone()
        };
        let plain_encoded = encode_envelope(&plain_no_secrets, None).expect("plain encode");
        assert!(decode_envelope(&plain_encoded, Some("my-master-pass"), true).is_err());
        assert!(decode_envelope(&plain_encoded, None, false).is_ok());
        assert!(encode_envelope(&payload, None).is_err());

        // Out-of-range iterations and short salt must be rejected (no silent clamping).
        let mut bad_iter: SyncEnvelope = serde_json::from_slice(&encoded).expect("parse env");
        bad_iter.iterations = Some(1);
        assert!(
            decode_envelope(
                &serde_json::to_vec(&bad_iter).unwrap(),
                Some("my-master-pass"),
                true
            )
            .is_err()
        );

        let mut bad_salt: SyncEnvelope = serde_json::from_slice(&encoded).expect("parse env");
        bad_salt.salt = Some(B64.encode(b"short"));
        assert!(
            decode_envelope(
                &serde_json::to_vec(&bad_salt).unwrap(),
                Some("my-master-pass"),
                true
            )
            .is_err()
        );

        // Unsupported envelope version and KDF must be rejected cleanly.
        let mut bad_ver: SyncEnvelope = serde_json::from_slice(&encoded).expect("parse env");
        bad_ver.version = 99;
        let bad_ver_bytes = serde_json::to_vec(&bad_ver).unwrap();
        assert!(decode_envelope(&bad_ver_bytes, Some("my-master-pass"), true).is_err());

        let mut bad_kdf: SyncEnvelope = serde_json::from_slice(&encoded).expect("parse env");
        bad_kdf.kdf = Some("md5".to_string());
        let bad_kdf_bytes = serde_json::to_vec(&bad_kdf).unwrap();
        assert!(decode_envelope(&bad_kdf_bytes, Some("my-master-pass"), true).is_err());
    }

    #[test]
    fn folder_sync_write_read_and_test() {
        let dir = std::env::temp_dir().join(format!("serverhub-sync-fs-{}", uuid::Uuid::new_v4()));
        let file = dir.join(BUNDLE_FILENAME);

        let status = fs_test(&file).expect("fs_test writable");
        assert!(status.contains("目录连接正常"));
        assert!(fs_read(&file).expect("read missing").is_none());

        let payload = SyncPayload {
            schema_version: 1,
            device_name: "Test-Mac".to_string(),
            updated_at: 1_700_000_123,
            servers: Some(Vec::new()),
            credentials: None,
            deleted_server_ids: HashMap::new(),
            deleted_credential_ids: HashMap::new(),
            deleted_ai_profile_ids: HashMap::new(),
            secrets: Some(HashMap::from([(
                "srv-a".to_string(),
                "p@ssw0rd".to_string(),
            )])),
            secret_timestamps: HashMap::new(),
            ai_config: None,
            app_settings: None,
        };
        let encoded =
            encode_envelope_with_iterations(&payload, Some("vault-key"), 10_000).expect("encode");
        fs_write(&file, &encoded).expect("fs_write");

        let read_back = fs_read(&file).expect("fs_read").expect("file exists");
        assert!(!String::from_utf8_lossy(&read_back).contains("p@ssw0rd"));
        let decoded = decode_envelope(&read_back, Some("vault-key"), true).expect("decode");
        assert_eq!(decoded.updated_at, 1_700_000_123);
        assert_eq!(
            decoded
                .secrets
                .as_ref()
                .and_then(|m| m.get("srv-a"))
                .map(String::as_str),
            Some("p@ssw0rd")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_credentials_and_ai_profiles_respect_tombstones() {
        use serverhub_ai::{AiProfile, AiProtocol};
        use serverhub_core::CredentialKind;

        let kept_cred = uuid::Uuid::new_v4();
        let deleted_cred = uuid::Uuid::new_v4();
        let mk_cred = |id, name: &str, updated_at| Credential {
            id,
            name: name.to_string(),
            username: Some("root".to_string()),
            kind: CredentialKind::Password,
            key_path: None,
            updated_at,
        };
        let cred_tombstones = HashMap::from([(deleted_cred.to_string(), 500)]);
        let (merged_creds, cred_won) = merge_credentials(
            &[mk_cred(kept_cred, "Kept", 100)],
            &[
                mk_cred(kept_cred, "Kept Remote", 200),
                mk_cred(deleted_cred, "Deleted Remote", 400),
            ],
            &cred_tombstones,
        );
        assert_eq!(merged_creds.len(), 1);
        assert_eq!(merged_creds[0].name, "Kept Remote");
        assert!(cred_won.contains(&format!("cred:{kept_cred}")));
        assert!(!cred_won.contains(&format!("cred:{deleted_cred}")));

        let mk_ai = |id: &str, name: &str, updated_at: u64| AiProfile {
            id: id.to_string(),
            name: name.to_string(),
            protocol: AiProtocol::OpenAiCompatible,
            base_url: "https://api.example.com/v1".to_string(),
            model: "gpt-4o".to_string(),
            custom_headers: HashMap::new(),
            temperature: None,
            max_tokens: None,
            system_prompt: None,
            has_api_key: true,
            updated_at,
        };
        let local_ai = AiConfigData {
            default_profile_id: Some("p-del".to_string()),
            profiles: vec![mk_ai("p-del", "Old Default", 100)],
        };
        let remote_ai = AiConfigData {
            default_profile_id: Some("p-keep".to_string()),
            profiles: vec![
                mk_ai("p-del", "Resurrect Attempt", 150),
                mk_ai("p-keep", "Active Profile", 200),
            ],
        };
        let ai_tombstones = HashMap::from([("p-del".to_string(), 300)]);
        let (merged_ai, ai_won) = merge_ai_config(&local_ai, &remote_ai, &ai_tombstones);
        assert_eq!(merged_ai.profiles.len(), 1);
        assert_eq!(merged_ai.profiles[0].id, "p-keep");
        assert_eq!(merged_ai.default_profile_id.as_deref(), Some("p-keep"));
        assert!(ai_won.contains("ai:p-keep"));
        assert!(!ai_won.contains("ai:p-del"));
    }

    #[test]
    fn sanitize_app_settings_strips_background_image() {
        let raw = serde_json::json!({
            "uiScale": 110,
            "backgroundImage": "data:image/png;base64,AAAA"
        });
        let cleaned = sanitize_synced_app_settings(Some(raw)).expect("cleaned");
        assert!(cleaned.get("backgroundImage").is_none());
        assert_eq!(cleaned.get("uiScale").and_then(|v| v.as_i64()), Some(110));
    }

    #[test]
    fn merge_servers_prefers_latest_updated_at() {
        use serverhub_core::{AuthMethod, Protocol};
        let shared_id = uuid::Uuid::new_v4();
        let local_only_id = uuid::Uuid::new_v4();
        let remote_only_id = uuid::Uuid::new_v4();

        let mk = |id, name: &str, updated_at| Server {
            id,
            name: name.to_string(),
            protocol: Protocol::Ssh,
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            domain: None,
            auth: AuthMethod::Password,
            auth_priority: vec![],
            timeout_secs: None,
            keepalive_secs: None,
            jump_hosts: vec![],
            term_type: None,
            group: None,
            provider: None,
            region: None,
            os: None,
            tags: vec![],
            cost: None,
            expires_at: None,
            updated_at,
        };

        let local = vec![
            mk(shared_id, "Old Local", 100),
            mk(local_only_id, "Local Only", 150),
        ];
        let remote = vec![
            mk(shared_id, "New Remote", 200),
            mk(remote_only_id, "Remote Only", 180),
        ];

        let (merged, remote_won) = merge_servers(&local, &remote, &HashMap::new());
        assert_eq!(merged.len(), 3);
        let shared = merged.iter().find(|s| s.id == shared_id).expect("shared");
        assert_eq!(shared.name, "New Remote");
        assert!(merged.iter().any(|s| s.id == local_only_id));
        assert!(merged.iter().any(|s| s.id == remote_only_id));
        assert!(remote_won.contains(&shared_id.to_string()));
        assert!(remote_won.contains(&remote_only_id.to_string()));
        assert!(!remote_won.contains(&local_only_id.to_string()));
    }

    #[test]
    fn s3_url_and_oauth_helpers() {
        let mut cfg = SyncConfig {
            s3_endpoint: "https://abc.r2.cloudflarestorage.com".to_string(),
            s3_bucket: "my-bucket".to_string(),
            s3_object_key: "serverhub/sync.json".to_string(),
            s3_path_style: true,
            ..Default::default()
        };

        let (url, host, uri) = s3_build_url_and_host(&cfg).expect("path style");
        assert_eq!(
            url,
            "https://abc.r2.cloudflarestorage.com/my-bucket/serverhub/sync.json"
        );
        assert_eq!(host, "abc.r2.cloudflarestorage.com");
        assert_eq!(uri, "/my-bucket/serverhub/sync.json");

        cfg.s3_path_style = false;
        let (url2, host2, uri2) = s3_build_url_and_host(&cfg).expect("virtual hosted");
        assert_eq!(
            url2,
            "https://my-bucket.abc.r2.cloudflarestorage.com/serverhub/sync.json"
        );
        assert_eq!(host2, "my-bucket.abc.r2.cloudflarestorage.com");
        assert_eq!(uri2, "/serverhub/sync.json");

        // Reject path traversal in S3 key and iCloud subfolder
        assert!(validate_safe_subfolder("../escape").is_err());
        assert!(validate_safe_subfolder("ServerHub/sub").is_ok());
        cfg.s3_object_key = "../etc/passwd".to_string();
        assert!(s3_build_url_and_host(&cfg).is_err());

        let req = "GET /callback?code=abc%2F123&state=xyz HTTP/1.1";
        assert_eq!(extract_query_param(req, "code").as_deref(), Some("abc/123"));
        assert_eq!(extract_query_param(req, "state").as_deref(), Some("xyz"));

        let form = encode_form(&[("grant_type", "authorization_code"), ("scope", "a b")]);
        assert_eq!(form, "grant_type=authorization_code&scope=a%20b");
    }
}
