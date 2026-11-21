use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::Server;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
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
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(servers)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, &self.path)?;
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
            host: "10.0.0.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth: AuthMethod::Password,
            group: Some("Prod".to_string()),
            tags: vec!["web".to_string()],
            updated_at: 1_700_000_000,
        }];

        store.save(&servers).expect("save");
        let loaded = store.load().expect("load");
        assert_eq!(servers, loaded);

        let _ = fs::remove_file(path);
    }
}
