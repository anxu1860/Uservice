use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use thiserror::Error;
use uuid::Uuid;

use crate::{Credential, Server};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("store.json");
    let tmp_path = path.with_file_name(format!(".{file_name}.tmp.{}", Uuid::new_v4()));

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp_path)?;
    if let Err(err) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
    }

    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_) => {
            // Windows rename fails if destination exists; use backup-then-swap to avoid data loss.
            let bak_path = path.with_file_name(format!(".{file_name}.bak.{}", Uuid::new_v4()));
            let had_dst = path.exists();
            if had_dst {
                if let Err(err) = fs::rename(path, &bak_path) {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(err);
                }
            }
            match fs::rename(&tmp_path, path) {
                Ok(()) => {
                    if had_dst {
                        let _ = fs::remove_file(&bak_path);
                    }
                    Ok(())
                }
                Err(err) => {
                    if had_dst {
                        let _ = fs::rename(&bak_path, path);
                    }
                    let _ = fs::remove_file(&tmp_path);
                    Err(err)
                }
            }
        }
        #[cfg(not(windows))]
        Err(err) => {
            let _ = fs::remove_file(&tmp_path);
            Err(err)
        }
    }
}

#[derive(Debug, Clone)]
pub struct ServerStore {
    path: PathBuf,
}

impl ServerStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn load(&self) -> Result<Vec<Server>, StoreError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let servers = serde_json::from_str(&raw)?;
        Ok(servers)
    }

    pub fn save(&self, servers: &[Server]) -> Result<(), StoreError> {
        let json = serde_json::to_string_pretty(servers)?;
        write_private_atomic(&self.path, json.as_bytes())?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn load(&self) -> Result<Vec<Credential>, StoreError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let list = serde_json::from_str(&raw)?;
        Ok(list)
    }

    pub fn save(&self, credentials: &[Credential]) -> Result<(), StoreError> {
        let json = serde_json::to_string_pretty(credentials)?;
        write_private_atomic(&self.path, json.as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AuthMethod;
    use uuid::Uuid;

    #[test]
    fn store_roundtrip() {
        let path = std::env::temp_dir().join(format!("serverhub_store_{}.json", Uuid::new_v4()));
        let store = ServerStore::new(&path);

        assert!(store.load().expect("load empty").is_empty());

        let servers = vec![Server {
            id: Uuid::new_v4(),
            name: "box-1".to_string(),
            protocol: crate::Protocol::Ssh,
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
            group: Some("Prod".to_string()),
            provider: None,
            region: None,
            os: None,
            tags: vec!["web".to_string()],
            cost: None,
            expires_at: None,
            updated_at: 1_700_000_000,
        }];

        store.save(&servers).expect("save");
        let loaded = store.load().expect("load");
        assert_eq!(servers, loaded);

        let _ = fs::remove_file(path);
    }
}
