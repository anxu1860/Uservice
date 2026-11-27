use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AiError;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProtocol {
    #[default]
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub protocol: AiProtocol,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub has_api_key: bool,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiConfigData {
    #[serde(default)]
    pub default_profile_id: Option<String>,
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
}

/// Persists AI provider profiles (excluding secret API keys, which live in the encrypted local vault).
pub struct AiProfileStore {
    path: PathBuf,
}

impl AiProfileStore {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, AiError> {
        let dir = dir.as_ref();
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        Ok(Self {
            path: dir.join("ai_profiles.json"),
        })
    }

    pub fn load(&self) -> Result<AiConfigData, AiError> {
        if !self.path.exists() {
            return Ok(AiConfigData::default());
        }
        let raw = fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            return Ok(AiConfigData::default());
        }
        let data: AiConfigData = serde_json::from_str(&raw)?;
        Ok(data)
    }

    pub fn save(&self, data: &AiConfigData) -> Result<(), AiError> {
        let serialized = serde_json::to_string_pretty(data)?;
        let file_name = self
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("ai_profiles.json");
        let tmp = self
            .path
            .with_file_name(format!(".{file_name}.tmp.{}", Uuid::new_v4()));

        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        if let Err(err) = file
            .write_all(serialized.as_bytes())
            .and_then(|_| file.sync_all())
        {
            drop(file);
            let _ = fs::remove_file(&tmp);
            return Err(err.into());
        }
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }

        match fs::rename(&tmp, &self.path) {
            Ok(()) => Ok(()),
            #[cfg(windows)]
            Err(_) => {
                let bak = self
                    .path
                    .with_file_name(format!(".{file_name}.bak.{}", Uuid::new_v4()));
                let had_dst = self.path.exists();
                if had_dst {
                    if let Err(err) = fs::rename(&self.path, &bak) {
                        let _ = fs::remove_file(&tmp);
                        return Err(err.into());
                    }
                }
                match fs::rename(&tmp, &self.path) {
                    Ok(()) => {
                        if had_dst {
                            let _ = fs::remove_file(&bak);
                        }
                        Ok(())
                    }
                    Err(err) => {
                        if had_dst {
                            let _ = fs::rename(&bak, &self.path);
                        }
                        let _ = fs::remove_file(&tmp);
                        Err(err.into())
                    }
                }
            }
            #[cfg(not(windows))]
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                Err(err.into())
            }
        }
    }

    pub fn upsert(
        &self,
        mut profile: AiProfile,
        set_default: bool,
    ) -> Result<AiConfigData, AiError> {
        let mut data = self.load()?;
        profile.id = profile.id.trim().to_string();
        if profile.id.is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        if let Some(existing) = data.profiles.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            data.profiles.push(profile.clone());
        }
        if set_default || data.default_profile_id.is_none() {
            data.default_profile_id = Some(profile.id);
        }
        self.save(&data)?;
        Ok(data)
    }

    pub fn delete(&self, profile_id: &str) -> Result<AiConfigData, AiError> {
        let mut data = self.load()?;
        data.profiles.retain(|p| p.id != profile_id);
        if data.default_profile_id.as_deref() == Some(profile_id) {
            data.default_profile_id = data.profiles.first().map(|p| p.id.clone());
        }
        self.save(&data)?;
        Ok(data)
    }

    pub fn set_default(&self, profile_id: &str) -> Result<AiConfigData, AiError> {
        let mut data = self.load()?;
        if data.profiles.iter().any(|p| p.id == profile_id) {
            data.default_profile_id = Some(profile_id.to_string());
            self.save(&data)?;
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_store() {
        let dir = std::env::temp_dir().join(format!("serverhub-ai-test-{}", Uuid::new_v4()));
        let store = AiProfileStore::open(&dir).unwrap();
        let profile = AiProfile {
            id: String::new(),
            name: "DeepSeek".to_string(),
            protocol: AiProtocol::OpenAiCompatible,
            base_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-chat".to_string(),
            custom_headers: HashMap::new(),
            temperature: Some(0.2),
            max_tokens: Some(2048),
            system_prompt: None,
            has_api_key: true,
            updated_at: 1,
        };
        let data = store.upsert(profile, true).unwrap();
        assert_eq!(data.profiles.len(), 1);
        let id = data.profiles[0].id.clone();
        assert_eq!(data.default_profile_id.as_deref(), Some(id.as_str()));

        let after_del = store.delete(&id).unwrap();
        assert!(after_del.profiles.is_empty());
        assert!(after_del.default_profile_id.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
