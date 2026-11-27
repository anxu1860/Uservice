use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use rand::rngs::OsRng;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::Sha256;
use tauri::Manager;
use zeroize::Zeroize;

use crate::AppState;

const DB_FILENAME: &str = "secrets.db";
const KEY_FILENAME: &str = "vault.key";
const META_SEED_KEY: &str = "master_seed";
const HKDF_SALT: &[u8] = b"dev.serverhub.desktop.vault.v1";
const HKDF_INFO: &[u8] = b"aes-256-gcm-key";

pub(crate) struct SecretDb {
    path: PathBuf,
    key: [u8; 32],
    cache: HashMap<String, String>,
    timestamps: HashMap<String, i64>,
    decrypt_errors: usize,
}

impl Drop for SecretDb {
    fn drop(&mut self) {
        self.key.zeroize();
        for (_, mut v) in self.cache.drain() {
            v.zeroize();
        }
    }
}

#[derive(Default)]
pub(crate) enum VaultState {
    #[default]
    Unopened,
    Opened(SecretDb),
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn derive_key(seed: &[u8]) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), seed);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .map_err(|_| "派生加密密钥失败".to_string())?;
    Ok(okm)
}

fn restrict_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
        }
    }
}

fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn restrict_db_permissions(path: &Path) {
    restrict_permissions(path);
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    restrict_permissions(Path::new(&wal));
    let mut shm = path.as_os_str().to_os_string();
    shm.push("-shm");
    restrict_permissions(Path::new(&shm));
}

fn ensure_private_file_created(path: &Path) -> Result<(), String> {
    if path.exists() {
        restrict_permissions(path);
        return Ok(());
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            restrict_permissions(path);
            Ok(())
        }
        Err(e) => Err(format!("创建密钥库文件失败: {e}")),
    }
}

/// Atomically creates `path` ONLY if it does not already exist, returning `Ok(true)` if created
/// or `Ok(false)` if another instance created it first (preventing key clobbering races).
fn create_private_file_exclusive(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建密钥种子目录失败: {e}"))?;
        restrict_dir_permissions(parent);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = std::fs::remove_file(path);
                return Err(format!("写入密钥种子失败: {e}"));
            }
            drop(file);
            restrict_permissions(path);
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            restrict_permissions(path);
            Ok(false)
        }
        Err(e) => Err(format!("创建密钥种子文件失败: {e}")),
    }
}

fn open_connection(path: &Path, init_schema: bool) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建密钥库目录失败: {e}"))?;
        restrict_dir_permissions(parent);
    }
    ensure_private_file_created(path)?;
    let conn = Connection::open(path).map_err(|e| format!("打开本地密钥库失败: {e}"))?;
    let _ = conn.busy_timeout(Duration::from_secs(5));
    let _ = conn.execute_batch("PRAGMA secure_delete = ON;");
    if init_schema {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS meta (
                 k TEXT PRIMARY KEY,
                 v BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS secrets (
                 id TEXT PRIMARY KEY,
                 nonce BLOB NOT NULL,
                 ciphertext BLOB NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("初始化密钥库表结构失败: {e}"))?;
    }
    restrict_db_permissions(path);
    Ok(conn)
}

fn purge_legacy_seed_from_db(conn: &Connection, db_path: &Path) {
    if let Ok(deleted) = conn.execute("DELETE FROM meta WHERE k = ?1", params![META_SEED_KEY])
        && deleted > 0
    {
        // Wipe freed SQLite pages and truncate WAL so legacy raw seed does not linger on disk.
        let _ = conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
        restrict_db_permissions(db_path);
    }
}

fn load_or_create_seed(db_path: &Path, conn: &Connection) -> Result<Vec<u8>, String> {
    let key_path = db_path
        .parent()
        .map(|p| p.join(KEY_FILENAME))
        .unwrap_or_else(|| PathBuf::from(KEY_FILENAME));

    if key_path.exists() {
        restrict_permissions(&key_path);
        let seed =
            std::fs::read(&key_path).map_err(|e| format!("读取本地密钥种子文件失败: {e}"))?;
        if seed.len() == 32 {
            purge_legacy_seed_from_db(conn, db_path);
            return Ok(seed);
        }
        return Err("本地密钥种子文件长度无效".to_string());
    }

    // Migrate legacy master_seed from secrets.db meta table if present
    let existing: Option<Vec<u8>> = conn
        .query_row(
            "SELECT v FROM meta WHERE k = ?1",
            params![META_SEED_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取密钥种子失败: {e}"))?;

    if let Some(mut seed) = existing {
        if seed.len() == 32 {
            let created = create_private_file_exclusive(&key_path, &seed)?;
            if !created {
                seed.zeroize();
                let disk_seed = std::fs::read(&key_path)
                    .map_err(|e| format!("读取本地密钥种子文件失败: {e}"))?;
                if disk_seed.len() != 32 {
                    return Err("本地密钥种子文件长度无效".to_string());
                }
                purge_legacy_seed_from_db(conn, db_path);
                return Ok(disk_seed);
            }
            purge_legacy_seed_from_db(conn, db_path);
            return Ok(seed);
        }
        seed.zeroize();
        return Err("本地密钥库种子长度无效".to_string());
    }

    let mut seed = vec![0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let created = create_private_file_exclusive(&key_path, &seed)?;
    if !created {
        seed.zeroize();
        let disk_seed =
            std::fs::read(&key_path).map_err(|e| format!("读取本地密钥种子文件失败: {e}"))?;
        if disk_seed.len() != 32 {
            return Err("本地密钥种子文件长度无效".to_string());
        }
        return Ok(disk_seed);
    }
    Ok(seed)
}

fn encrypt_secret(
    key: &[u8; 32],
    id: &str,
    plaintext: &str,
) -> Result<([u8; 12], Vec<u8>), String> {
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化加密器失败: {e}"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|e| format!("加密密钥失败: {e}"))?;
    Ok((nonce_bytes, ciphertext))
}

fn decrypt_secret(
    key: &[u8; 32],
    id: &str,
    nonce_bytes: &[u8],
    ciphertext: &[u8],
) -> Result<String, String> {
    if nonce_bytes.len() != 12 {
        return Err("密文 nonce 长度无效".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密器失败: {e}"))?;
    let mut plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| "解密密钥失败（数据可能已损坏）".to_string())?;
    match String::from_utf8(plaintext.clone()) {
        Ok(s) => {
            plaintext.zeroize();
            Ok(s)
        }
        Err(e) => {
            plaintext.zeroize();
            Err(format!("密钥编码无效: {e}"))
        }
    }
}

impl SecretDb {
    fn open(path: PathBuf) -> Result<Self, String> {
        let conn = open_connection(&path, true)?;
        let mut seed = load_or_create_seed(&path, &conn)?;
        let key_res = derive_key(&seed);
        seed.zeroize();
        let key = key_res?;

        let mut stmt = conn
            .prepare("SELECT id, nonce, ciphertext, updated_at FROM secrets")
            .map_err(|e| format!("查询密钥库失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let nonce: Vec<u8> = row.get(1)?;
                let ciphertext: Vec<u8> = row.get(2)?;
                let updated_at: i64 = row.get(3)?;
                Ok((id, nonce, ciphertext, updated_at))
            })
            .map_err(|e| format!("读取密钥库记录失败: {e}"))?;

        let mut cache = HashMap::new();
        let mut timestamps = HashMap::new();
        let mut decrypt_errors = 0usize;
        for row in rows {
            let (id, nonce, ciphertext, updated_at) =
                row.map_err(|e| format!("解析密钥记录失败: {e}"))?;
            match decrypt_secret(&key, &id, &nonce, &ciphertext) {
                Ok(val) if !val.is_empty() => {
                    cache.insert(id.clone(), val);
                    timestamps.insert(id, updated_at);
                }
                Ok(_) => {}
                Err(err) => {
                    decrypt_errors += 1;
                    eprintln!("[vault] failed to decrypt secret record: {err}");
                }
            }
        }

        Ok(Self {
            path,
            key,
            cache,
            timestamps,
            decrypt_errors,
        })
    }

    #[cfg(test)]
    fn set(&mut self, id: &str, secret: &str) -> Result<(), String> {
        if secret.is_empty() {
            return self.delete(id);
        }
        let now = now_unix_secs();
        let (nonce, ciphertext) = encrypt_secret(&self.key, id, secret)?;
        write_secret_to_sqlite(&self.path, id, &nonce, &ciphertext, now)?;
        self.cache.insert(id.to_string(), secret.to_string());
        self.timestamps.insert(id.to_string(), now);
        Ok(())
    }

    #[cfg(test)]
    fn delete(&mut self, id: &str) -> Result<(), String> {
        delete_secret_from_sqlite(&self.path, id)?;
        self.cache.remove(id);
        self.timestamps.remove(id);
        Ok(())
    }
}

fn write_secret_to_sqlite(
    path: &Path,
    id: &str,
    nonce: &[u8; 12],
    ciphertext: &[u8],
    updated_at: i64,
) -> Result<(), String> {
    let conn = open_connection(path, false)?;
    conn.execute(
        "INSERT INTO secrets (id, nonce, ciphertext, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             updated_at = excluded.updated_at",
        params![id, nonce.as_slice(), ciphertext, updated_at],
    )
    .map_err(|e| format!("写入本地密钥库失败: {e}"))?;
    restrict_db_permissions(path);
    Ok(())
}

fn delete_secret_from_sqlite(path: &Path, id: &str) -> Result<(), String> {
    let conn = open_connection(path, false)?;
    conn.execute("DELETE FROM secrets WHERE id = ?1", params![id])
        .map_err(|e| format!("删除本地密钥失败: {e}"))?;
    restrict_db_permissions(path);
    Ok(())
}

fn delete_secrets_batch_from_sqlite(path: &Path, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut conn = open_connection(path, false)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启本地密钥库删除事务失败: {e}"))?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM secrets WHERE id = ?1")
            .map_err(|e| format!("准备删除语句失败: {e}"))?;
        for id in ids {
            stmt.execute(params![id])
                .map_err(|e| format!("批量删除本地密钥失败: {e}"))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("提交本地密钥库删除事务失败: {e}"))?;
    restrict_db_permissions(path);
    Ok(())
}

fn write_secrets_batch_to_sqlite(
    path: &Path,
    entries: &[(String, [u8; 12], Vec<u8>, i64)],
) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut conn = open_connection(path, false)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启本地密钥库事务失败: {e}"))?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO secrets (id, nonce, ciphertext, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                     nonce = excluded.nonce,
                     ciphertext = excluded.ciphertext,
                     updated_at = excluded.updated_at",
            )
            .map_err(|e| format!("准备写入语句失败: {e}"))?;
        for (id, nonce, ciphertext, ts) in entries {
            stmt.execute(params![id, nonce.as_slice(), ciphertext, ts])
                .map_err(|e| format!("批量写入本地密钥库失败: {e}"))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("提交本地密钥库事务失败: {e}"))?;
    restrict_db_permissions(path);
    Ok(())
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(data_dir.join(DB_FILENAME))
}

async fn ensure_opened_write<'a>(
    app: &tauri::AppHandle,
    guard: &'a mut VaultState,
) -> Result<&'a mut SecretDb, String> {
    if matches!(guard, VaultState::Unopened) {
        let path = db_path(app)?;
        let db = tokio::task::spawn_blocking(move || SecretDb::open(path))
            .await
            .map_err(|e| format!("打开本地密钥库任务失败: {e}"))??;
        *guard = VaultState::Opened(db);
    }

    match guard {
        VaultState::Opened(db) => Ok(db),
        VaultState::Unopened => unreachable!(),
    }
}

async fn ensure_opened_read(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    {
        let guard = state.vault.read().await;
        if matches!(&*guard, VaultState::Opened(_)) {
            return Ok(());
        }
    }
    let mut guard = state.vault.write().await;
    let _ = ensure_opened_write(app, &mut guard).await?;
    Ok(())
}

pub(crate) async fn resolve_secret(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id: &str,
) -> Option<String> {
    {
        let guard = state.vault.read().await;
        if let VaultState::Opened(db) = &*guard {
            return db.cache.get(server_id).filter(|s| !s.is_empty()).cloned();
        }
    }
    ensure_opened_read(app, state).await.ok()?;
    let guard = state.vault.read().await;
    match &*guard {
        VaultState::Opened(db) => db.cache.get(server_id).filter(|s| !s.is_empty()).cloned(),
        VaultState::Unopened => None,
    }
}

pub(crate) async fn has_secrets_batch(
    app: &tauri::AppHandle,
    state: &AppState,
    keys: &[&str],
) -> Vec<bool> {
    if ensure_opened_read(app, state).await.is_err() {
        return vec![false; keys.len()];
    }
    let guard = state.vault.read().await;
    match &*guard {
        VaultState::Opened(db) => keys
            .iter()
            .map(|k| db.cache.get(*k).is_some_and(|v| !v.is_empty()))
            .collect(),
        VaultState::Unopened => vec![false; keys.len()],
    }
}

pub(crate) async fn persist_secret(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        return delete_secret(app, state, server_id).await;
    }
    let mut guard = state.vault.write().await;
    let db = ensure_opened_write(app, &mut guard).await?;
    let now = now_unix_secs();
    let (nonce, ciphertext) = encrypt_secret(&db.key, server_id, secret)?;
    let path = db.path.clone();
    let id_owned = server_id.to_string();
    tokio::task::spawn_blocking(move || {
        write_secret_to_sqlite(&path, &id_owned, &nonce, &ciphertext, now)
    })
    .await
    .map_err(|e| format!("写入本地密钥库任务失败: {e}"))??;
    db.cache.insert(server_id.to_string(), secret.to_string());
    db.timestamps.insert(server_id.to_string(), now);
    Ok(())
}

pub(crate) async fn delete_secret(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id: &str,
) -> Result<(), String> {
    let mut guard = state.vault.write().await;
    let db = ensure_opened_write(app, &mut guard).await?;
    let path = db.path.clone();
    let id_owned = server_id.to_string();
    tokio::task::spawn_blocking(move || delete_secret_from_sqlite(&path, &id_owned))
        .await
        .map_err(|e| format!("删除本地密钥任务失败: {e}"))??;
    db.cache.remove(server_id);
    db.timestamps.remove(server_id);
    Ok(())
}

pub(crate) async fn delete_app_secrets_batch(
    app: &tauri::AppHandle,
    state: &AppState,
    keys: Vec<String>,
) -> Result<usize, String> {
    let filtered: Vec<String> = keys
        .into_iter()
        .filter(|k| !is_device_local_secret_key(k))
        .collect();
    if filtered.is_empty() {
        return Ok(0);
    }
    let mut guard = state.vault.write().await;
    let db = ensure_opened_write(app, &mut guard).await?;
    let existing: Vec<String> = filtered
        .into_iter()
        .filter(|k| db.cache.contains_key(k))
        .collect();
    if existing.is_empty() {
        return Ok(0);
    }
    let path = db.path.clone();
    let to_del = existing.clone();
    tokio::task::spawn_blocking(move || delete_secrets_batch_from_sqlite(&path, &to_del))
        .await
        .map_err(|e| format!("批量删除本地密钥任务失败: {e}"))??;
    let count = existing.len();
    for k in existing {
        db.cache.remove(&k);
        db.timestamps.remove(&k);
    }
    Ok(count)
}

pub(crate) fn zeroize_bytes(buf: &mut [u8]) {
    buf.zeroize();
}

pub(crate) fn is_device_local_secret_key(key: &str) -> bool {
    key.starts_with("sync:") || key.starts_with("mcp:")
}

/// Blocks frontend generic `secret_*` IPC from accessing internal system namespaces
/// (`sync:*`, `mcp:*`, `ai:*`) or arbitrary non-UUID keys.
pub(crate) fn is_frontend_restricted_secret_key(key: &str) -> bool {
    let trimmed = key.trim();
    if trimmed.is_empty() || is_device_local_secret_key(trimmed) || trimmed.starts_with("ai:") {
        return true;
    }
    if let Some(cred_id) = trimmed.strip_prefix("cred:") {
        return uuid::Uuid::parse_str(cred_id).is_err();
    }
    uuid::Uuid::parse_str(trimmed).is_err()
}

pub(crate) async fn export_app_secrets_with_timestamps(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<(HashMap<String, String>, HashMap<String, i64>), String> {
    ensure_opened_read(app, state).await?;
    let guard = state.vault.read().await;
    match &*guard {
        VaultState::Opened(db) => {
            if db.decrypt_errors > 0 {
                return Err(format!(
                    "本地密钥库存在 {} 条无法解密的损坏记录，为避免覆盖云端数据已暂停导出密钥",
                    db.decrypt_errors
                ));
            }
            let mut secrets = HashMap::new();
            let mut timestamps = HashMap::new();
            for (k, v) in &db.cache {
                if !is_device_local_secret_key(k) && !v.is_empty() {
                    secrets.insert(k.clone(), v.clone());
                    if let Some(&ts) = db.timestamps.get(k) {
                        timestamps.insert(k.clone(), ts);
                    }
                }
            }
            Ok((secrets, timestamps))
        }
        VaultState::Unopened => Ok((HashMap::new(), HashMap::new())),
    }
}

pub(crate) async fn import_app_secrets_with_timestamps(
    app: &tauri::AppHandle,
    state: &AppState,
    secrets: HashMap<String, String>,
    remote_timestamps: &HashMap<String, i64>,
) -> Result<usize, String> {
    let mut guard = state.vault.write().await;
    let db = ensure_opened_write(app, &mut guard).await?;
    let fallback_now = now_unix_secs();
    let mut encrypted_entries = Vec::new();
    let mut plain_entries = Vec::new();
    for (k, v) in secrets {
        if is_device_local_secret_key(&k) || v.is_empty() {
            continue;
        }
        let ts = remote_timestamps.get(&k).copied().unwrap_or(fallback_now);
        let (nonce, ciphertext) = encrypt_secret(&db.key, &k, &v)?;
        encrypted_entries.push((k.clone(), nonce, ciphertext, ts));
        plain_entries.push((k, v, ts));
    }
    let count = plain_entries.len();
    if count > 0 {
        let path = db.path.clone();
        tokio::task::spawn_blocking(move || {
            write_secrets_batch_to_sqlite(&path, &encrypted_entries)
        })
        .await
        .map_err(|e| format!("批量导入密钥任务失败: {e}"))??;
        for (k, v, ts) in plain_entries {
            db.cache.insert(k.clone(), v);
            db.timestamps.insert(k, ts);
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_vault_encrypts_reloads_and_deletes() {
        let dir =
            std::env::temp_dir().join(format!("serverhub-sqlite-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join(DB_FILENAME);

        {
            let mut db = SecretDb::open(path.clone()).expect("open db");
            db.set("srv-1", "my-ssh-pass").expect("set srv-1");
            db.set("ai:prof-1", "sk-secret-key").expect("set ai key");
        }

        // Verify raw SQLite ciphertext does not store plaintext
        let conn = Connection::open(&path).expect("open raw sqlite");
        let raw_cipher: Vec<u8> = conn
            .query_row(
                "SELECT ciphertext FROM secrets WHERE id = ?1",
                params!["srv-1"],
                |row| row.get(0),
            )
            .expect("query raw row");
        assert!(!String::from_utf8_lossy(&raw_cipher).contains("my-ssh-pass"));

        // Reopen and verify decrypted values
        let mut reopened = SecretDb::open(path.clone()).expect("reopen db");
        assert_eq!(
            reopened.cache.get("srv-1").map(String::as_str),
            Some("my-ssh-pass")
        );
        assert_eq!(
            reopened.cache.get("ai:prof-1").map(String::as_str),
            Some("sk-secret-key")
        );
        assert!(reopened.timestamps.contains_key("srv-1"));

        // Delete and verify persistence
        reopened.delete("srv-1").expect("delete srv-1");
        let reopened2 = SecretDb::open(path).expect("reopen after delete");
        assert!(!reopened2.cache.contains_key("srv-1"));
        assert_eq!(
            reopened2.cache.get("ai:prof-1").map(String::as_str),
            Some("sk-secret-key")
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
