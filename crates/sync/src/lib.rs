use async_trait::async_trait;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("sync backend error: {0}")]
    Backend(String),
    #[error("item not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone)]
pub struct RemoteItem {
    pub key: String,
    pub etag: Option<String>,
    pub updated_at: i64,
}

/// Pluggable encrypted sync backend (Google Drive appDataFolder, WebDAV, etc.).
#[async_trait]
pub trait SyncBackend: Send + Sync {
    async fn list(&self) -> Result<Vec<RemoteItem>, SyncError>;
    async fn get(&self, key: &str) -> Result<Vec<u8>, SyncError>;
    async fn put(&self, key: &str, data: &[u8]) -> Result<(), SyncError>;
    async fn delete(&self, key: &str) -> Result<(), SyncError>;
}
