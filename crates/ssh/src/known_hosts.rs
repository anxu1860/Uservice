use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::SshError;

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

    pub fn verify_or_trust(&self, host_port: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| SshError::KnownHosts("known_hosts mutex poisoned".into()))?;

        if let Some(expected) = guard.get(host_port) {
            if expected == fingerprint {
                return Ok(());
            }
            return Err(SshError::HostKeyMismatch {
                host: host_port.to_string(),
                expected: expected.clone(),
                got: fingerprint.to_string(),
            });
        }

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
    fn tofu_new_match_and_mismatch() {
        let path = temp_known_hosts_path();
        let store = KnownHostsStore::load_or_create(&path).expect("load_or_create");

        // First time: trust on first use
        store
            .verify_or_trust("10.0.0.1:22", "SHA256:abc123")
            .expect("should trust unknown host");

        // Reload from disk and verify match
        let reloaded = KnownHostsStore::load_or_create(&path).expect("reload");
        reloaded
            .verify_or_trust("10.0.0.1:22", "SHA256:abc123")
            .expect("should match trusted fingerprint");

        // Verify mismatch is rejected
        let err = reloaded
            .verify_or_trust("10.0.0.1:22", "SHA256:evil999")
            .expect_err("should reject mismatched fingerprint");
        match err {
            SshError::HostKeyMismatch {
                host,
                expected,
                got,
            } => {
                assert_eq!(host, "10.0.0.1:22");
                assert_eq!(expected, "SHA256:abc123");
                assert_eq!(got, "SHA256:evil999");
            }
            other => panic!("unexpected error: {other:?}"),
        }

        let _ = fs::remove_file(path);
    }
}
