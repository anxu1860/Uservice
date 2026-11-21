use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Authentication method metadata stored for a server entry.
/// Secrets (passwords, key passphrases) are never persisted here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    Key { path: String },
}

/// Non-sensitive server configuration record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub updated_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_serde_roundtrip() {
        let server = Server {
            id: Uuid::new_v4(),
            name: "prod-web-01".to_string(),
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth: AuthMethod::Key {
                path: "~/.ssh/id_ed25519".to_string(),
            },
            group: Some("Production".to_string()),
            tags: vec!["linux".to_string(), "nginx".to_string()],
            updated_at: 1_700_000_000,
        };

        let json = serde_json::to_string(&server).expect("serialize server");
        let decoded: Server = serde_json::from_str(&json).expect("deserialize server");
        assert_eq!(server, decoded);

        let pwd_server = Server {
            id: Uuid::new_v4(),
            name: "dev-box".to_string(),
            host: "10.0.0.5".to_string(),
            port: 2222,
            username: "root".to_string(),
            auth: AuthMethod::Password,
            group: None,
            tags: vec![],
            updated_at: 1_700_000_001,
        };

        let json = serde_json::to_string(&pwd_server).expect("serialize password server");
        let decoded: Server = serde_json::from_str(&json).expect("deserialize password server");
        assert_eq!(pwd_server, decoded);
    }
}
