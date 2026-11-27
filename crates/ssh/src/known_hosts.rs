use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use uuid::Uuid;

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
    inner: Arc<RwLock<BTreeMap<String, String>>>,
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
            inner: Arc::new(RwLock::new(map)),
        })
    }

    pub fn check(&self, host_port: &str, fingerprint: &str) -> Result<HostKeyStatus, SshError> {
        let guard = self
            .inner
            .read()
            .map_err(|_| SshError::KnownHosts("known_hosts rwlock poisoned".into()))?;

        match guard.get(host_port) {
            Some(expected) if expected == fingerprint => Ok(HostKeyStatus::Known),
            Some(expected) => Ok(HostKeyStatus::Mismatch {
                expected: expected.clone(),
            }),
            None => Ok(HostKeyStatus::Unknown),
        }
    }

    fn save_map(&self, map: &BTreeMap<String, String>) -> Result<(), SshError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                SshError::KnownHosts(format!("failed to create known_hosts dir: {e}"))
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let json = serde_json::to_string_pretty(map)
            .map_err(|e| SshError::KnownHosts(format!("failed to serialize known_hosts: {e}")))?;
        let file_name = self
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("known_hosts.json");
        let tmp_path = self
            .path
            .with_file_name(format!(".{file_name}.tmp.{}", Uuid::new_v4()));

        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&tmp_path)
            .map_err(|e| SshError::KnownHosts(format!("failed to create temp known_hosts: {e}")))?;
        if let Err(e) = file
            .write_all(json.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&tmp_path);
            return Err(SshError::KnownHosts(format!(
                "failed to write known_hosts: {e}"
            )));
        }
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
        }

        match fs::rename(&tmp_path, &self.path) {
            Ok(()) => Ok(()),
            #[cfg(windows)]
            Err(_) => {
                let bak_path = self
                    .path
                    .with_file_name(format!(".{file_name}.bak.{}", Uuid::new_v4()));
                let had_dst = self.path.exists();
                if had_dst {
                    if let Err(e) = fs::rename(&self.path, &bak_path) {
                        let _ = fs::remove_file(&tmp_path);
                        return Err(SshError::KnownHosts(format!(
                            "failed to save known_hosts: {e}"
                        )));
                    }
                }
                match fs::rename(&tmp_path, &self.path) {
                    Ok(()) => {
                        if had_dst {
                            let _ = fs::remove_file(&bak_path);
                        }
                        Ok(())
                    }
                    Err(e) => {
                        if had_dst {
                            let _ = fs::rename(&bak_path, &self.path);
                        }
                        let _ = fs::remove_file(&tmp_path);
                        Err(SshError::KnownHosts(format!(
                            "failed to save known_hosts: {e}"
                        )))
                    }
                }
            }
            #[cfg(not(windows))]
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                Err(SshError::KnownHosts(format!(
                    "failed to save known_hosts: {e}"
                )))
            }
        }
    }

    /// Atomically checks and trusts `fingerprint` ONLY if `host_port` is currently unknown.
    /// Prevents concurrent TOCTOU races from overwriting an already-trusted key.
    pub fn trust_if_unknown(
        &self,
        host_port: &str,
        fingerprint: &str,
    ) -> Result<HostKeyStatus, SshError> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| SshError::KnownHosts("known_hosts rwlock poisoned".into()))?;

        if let Some(expected) = guard.get(host_port) {
            if expected == fingerprint {
                return Ok(HostKeyStatus::Known);
            }
            return Ok(HostKeyStatus::Mismatch {
                expected: expected.clone(),
            });
        }

        // Persist a candidate clone BEFORE mutating in-memory state so disk failures don't diverge.
        let mut next = guard.clone();
        next.insert(host_port.to_string(), fingerprint.to_string());
        self.save_map(&next)?;
        *guard = next;
        Ok(HostKeyStatus::Known)
    }

    pub fn trust(&self, host_port: &str, fingerprint: &str) -> Result<(), SshError> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| SshError::KnownHosts("known_hosts rwlock poisoned".into()))?;

        let mut next = guard.clone();
        next.insert(host_port.to_string(), fingerprint.to_string());
        self.save_map(&next)?;
        *guard = next;
        Ok(())
    }

    pub fn remove(&self, host_port: &str) -> Result<bool, SshError> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| SshError::KnownHosts("known_hosts rwlock poisoned".into()))?;

        if !guard.contains_key(host_port) {
            return Ok(false);
        }
        let mut next = guard.clone();
        next.remove(host_port);
        self.save_map(&next)?;
        *guard = next;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert_eq!(
            store
                .trust_if_unknown("10.0.0.1:22", "SHA256:abc123")
                .expect("trust_if_unknown"),
            HostKeyStatus::Known
        );

        // Concurrent/second trust_if_unknown with a different key must NOT overwrite!
        assert_eq!(
            store
                .trust_if_unknown("10.0.0.1:22", "SHA256:evil999")
                .expect("trust_if_unknown mismatch"),
            HostKeyStatus::Mismatch {
                expected: "SHA256:abc123".to_string(),
            }
        );

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
