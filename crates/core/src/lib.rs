pub mod ssh_config;
pub mod store;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use store::{CredentialStore, ServerStore, StoreError};

/// Connection protocol for a server entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    #[default]
    Ssh,
    Vnc,
    Rdp,
}

/// Authentication stage for SSH connection priority ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStage {
    Key,
    Credential,
    Password,
    KeyboardInteractive,
}

pub fn default_auth_priority() -> Vec<AuthStage> {
    vec![
        AuthStage::Key,
        AuthStage::Credential,
        AuthStage::Password,
        AuthStage::KeyboardInteractive,
    ]
}

/// Reusable credential type stored in the credential library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    #[default]
    Password,
    Key,
}

/// Reusable login credential record (non-sensitive metadata).
/// Associated secrets (password or key passphrase) are stored in the encrypted vault under `cred:<id>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub kind: CredentialKind,
    #[serde(default)]
    pub key_path: Option<String>,
    pub updated_at: i64,
}

/// Authentication method metadata stored for a server entry.
/// Secrets (passwords, key passphrases) are never persisted here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    Key {
        path: String,
    },
    Credential {
        #[serde(default)]
        credential_id: String,
    },
    KeyboardInteractive,
    Ask {
        #[serde(default)]
        key_path: Option<String>,
    },
}

/// Billing cycle for server cost calculation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BillingCycle {
    #[default]
    Monthly,
    Quarterly,
    Semiannual,
    Annual,
}

fn default_currency() -> String {
    "CNY".to_string()
}

/// Recurring cost configuration for a server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerCost {
    pub amount: f64,
    #[serde(default)]
    pub cycle: BillingCycle,
    #[serde(default = "default_currency")]
    pub currency: String,
}

/// Non-sensitive server configuration record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub domain: Option<String>,
    pub auth: AuthMethod,
    #[serde(default)]
    pub auth_priority: Vec<AuthStage>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub keepalive_secs: Option<u64>,
    #[serde(default)]
    pub jump_hosts: Vec<Uuid>,
    #[serde(default)]
    pub term_type: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub cost: Option<ServerCost>,
    #[serde(default)]
    pub expires_at: Option<String>,
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
            protocol: Protocol::Ssh,
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "deploy".to_string(),
            domain: None,
            auth: AuthMethod::Key {
                path: "~/.ssh/id_ed25519".to_string(),
            },
            auth_priority: default_auth_priority(),
            timeout_secs: Some(10),
            keepalive_secs: Some(20),
            jump_hosts: vec![],
            term_type: Some("xterm-256color".to_string()),
            group: Some("Production".to_string()),
            provider: Some("tencent".to_string()),
            region: Some("中国台湾".to_string()),
            os: Some("Ubuntu 24.04.1 LTS".to_string()),
            tags: vec!["linux".to_string(), "nginx".to_string()],
            cost: Some(ServerCost {
                amount: 60.0,
                cycle: BillingCycle::Monthly,
                currency: "CNY".to_string(),
            }),
            expires_at: Some("2027-01-15".to_string()),
            updated_at: 1_700_000_000,
        };

        let json = serde_json::to_string(&server).expect("serialize server");
        let decoded: Server = serde_json::from_str(&json).expect("deserialize server");
        assert_eq!(server, decoded);

        let pwd_server = Server {
            id: Uuid::new_v4(),
            name: "dev-box".to_string(),
            protocol: Protocol::Rdp,
            host: "10.0.0.5".to_string(),
            port: 3389,
            username: "Administrator".to_string(),
            domain: Some("CORP".to_string()),
            auth: AuthMethod::Password,
            auth_priority: vec![],
            timeout_secs: None,
            keepalive_secs: None,
            jump_hosts: vec![],
            term_type: None,
            group: None,
            provider: None,
            region: None,
            os: None,
            tags: vec![],
            cost: None,
            expires_at: None,
            updated_at: 1_700_000_001,
        };

        let json = serde_json::to_string(&pwd_server).expect("serialize password server");
        let decoded: Server = serde_json::from_str(&json).expect("deserialize password server");
        assert_eq!(pwd_server, decoded);

        let jump_id = Uuid::new_v4();
        for auth in [
            AuthMethod::Credential {
                credential_id: "cred-1".to_string(),
            },
            AuthMethod::KeyboardInteractive,
            AuthMethod::Ask {
                key_path: Some("~/.ssh/id_rsa".to_string()),
            },
        ] {
            let s = Server {
                id: Uuid::new_v4(),
                name: "bastion-target".to_string(),
                protocol: Protocol::Ssh,
                host: "10.10.0.9".to_string(),
                port: 2222,
                username: "ops".to_string(),
                domain: None,
                auth,
                auth_priority: vec![
                    AuthStage::KeyboardInteractive,
                    AuthStage::Credential,
                    AuthStage::Key,
                    AuthStage::Password,
                ],
                timeout_secs: Some(15),
                keepalive_secs: Some(30),
                jump_hosts: vec![jump_id],
                term_type: Some("tmux-256color".to_string()),
                group: None,
                provider: None,
                region: None,
                os: None,
                tags: vec![],
                cost: None,
                expires_at: None,
                updated_at: 1_700_000_002,
            };
            let raw = serde_json::to_string(&s).expect("serialize");
            let back: Server = serde_json::from_str(&raw).expect("deserialize");
            assert_eq!(s, back);
        }
    }
}
