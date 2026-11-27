pub mod client;
pub mod store;

pub use client::{
    AiStreamEvent, ChatMessage, ServerContext, TestConnectionResult, base_url_origin,
    build_system_prompt, list_models, redact_sensitive_output, stream_chat, test_connection,
    validate_base_url,
};
pub use store::{AiConfigData, AiProfile, AiProfileStore, AiProtocol};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AiError {
    #[error("AI 配置错误: {0}")]
    Config(String),
    #[error("AI 网络请求失败: {0}")]
    Http(String),
    #[error("AI 接口返回错误: {0}")]
    Api(String),
    #[error("读写 AI 配置失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("解析 AI 配置失败: {0}")]
    Json(#[from] serde_json::Error),
}
