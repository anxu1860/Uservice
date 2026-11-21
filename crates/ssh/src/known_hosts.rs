use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::SshError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    Known,
    Unknown,
    Mismatch { expected: String },
}

#[derive(Debug, Clone)]
pub struct KnownHostsStore {
    path: PathBuf,
    inner: Arc<Mutex<BTreeMap<String, String>>>,
}

impl KnownHostsStore {
    pub fn load_or_create(path: impl AsRef<Path>) -> Result<Self, SshError> {
        let path = path.as_ref().to_path_buf();
        let map = if path.exists() {
            let raw = fs::read_to_string(&path)
                .map_err(|e| SshError::KnownHosts(format!("failed to read known_hosts: {e}")))?;
            if raw.trim().is_empty() {
                BTreeMap::new()
            } else {
                serde_json::from_str(&raw).map_err(|e| {
                    SshError::KnownHosts(format!("failed to parse known_hosts: {e}"))
                })?
            }
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(map)),
        })
    }

    pub fn check(&self, host_port: &str, fingerprint: &str) -> Result<HostKeyStatus, SshError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| SshError::KnownHosts("known_hosts mutex poisoned".into()))?;

        match guard.get(host_port) {
            Some(expected) if expected == fingerprint => Ok(HostKeyStatus::Known),
            Some(expected) => Ok(HostKeyStatus::Mismatch {
                expected: expected.clone(),
            }),
            None => Ok(HostKeyStatus::Unknown),
        }
    }

    pub fn trust(&self, host_port: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| SshError::KnownHosts("known_hosts mutex poisoned".into()))?;

        guard.insert(host_port.to_string(), fingerprint.to_string());
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                SshError::KnownHosts(format!("failed to create known_hosts dir: {e}"))
            })?;
        }
        let json = serde_json::to_string_pretty(&*guard)
            .map_err(|e| SshError::KnownHosts(format!("failed to serialize known_hosts: {e}")))?;
        fs::write(&self.path, json)
            .map_err(|e| SshError::KnownHosts(format!("failed to write known_hosts: {e}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_known_hosts_path() -> PathBuf {
        std::env::temp_dir().join(format!("serverhub_known_hosts_{}.json", Uuid::new_v4()))
    }

    #[test]
    fn unknown_trust_known_and_mismatch() {
        let path = temp_known_hosts_path();
        let store = KnownHostsStore::load_or_create(&path).expect("load_or_create");

        assert_eq!(
            store.check("10.0.0.1:22", "SHA256:abc123").expect("check"),
            HostKeyStatus::Unknown
        );

        store.trust("10.0.0.1:22", "SHA256:abc123").expect("trust");

        let reloaded = KnownHostsStore::load_or_create(&path).expect("reload");
        assert_eq!(
            reloaded
                .check("10.0.0.1:22", "SHA256:abc123")
                .expect("check known"),
            HostKeyStatus::Known
        );

        assert_eq!(
            reloaded
                .check("10.0.0.1:22", "SHA256:evil999")
                .expect("check mismatch"),
            HostKeyStatus::Mismatch {
                expected: "SHA256:abc123".to_string(),
            }
        );

        let _ = fs::remove_file(path);
    }
}
