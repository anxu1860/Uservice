pub mod known_hosts;

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{PrivateKeyWithHashAlg, load_secret_key, ssh_key};
use russh::{ChannelMsg, Disconnect, client};
use thiserror::Error;
use tokio::sync::mpsc;

pub use known_hosts::{HostKeyStatus, KnownHostsStore};

#[derive(Debug, Error)]
pub enum SshError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("unknown host key for {host}: {fingerprint}")]
    HostKeyUnknown { host: String, fingerprint: String },
    #[error("host key mismatch for {host}: expected {expected}, got {got}")]
    HostKeyMismatch {
        host: String,
        expected: String,
        got: String,
    },
    #[error("known_hosts error: {0}")]
    KnownHosts(String),
    #[error("key load error: {0}")]
    KeyLoad(String),
    #[error("channel error: {0}")]
    Channel(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SshAuthStage {
    Key,
    Credential,
    Password,
    KeyboardInteractive,
}

#[derive(Clone, Default)]
pub struct CredentialAuth {
    pub username: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
}

impl fmt::Debug for CredentialAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialAuth")
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("key_path", &self.key_path)
            .field(
                "passphrase",
                &self.passphrase.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone)]
pub enum Auth {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
    Credential(CredentialAuth),
    KeyboardInteractive {
        password: Option<String>,
    },
    Ask {
        password: Option<String>,
        key_path: Option<String>,
        passphrase: Option<String>,
    },
}

impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::Password(_) => f.write_str("Auth::Password([REDACTED])"),
            Auth::Key { path, passphrase } => f
                .debug_struct("Auth::Key")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "[REDACTED]"))
                .finish(),
            Auth::Credential(c) => f.debug_tuple("Auth::Credential").field(c).finish(),
            Auth::KeyboardInteractive { password } => f
                .debug_struct("Auth::KeyboardInteractive")
                .field("password", &password.as_ref().map(|_| "[REDACTED]"))
                .finish(),
            Auth::Ask {
                password,
                key_path,
                passphrase,
            } => f
                .debug_struct("Auth::Ask")
                .field("password", &password.as_ref().map(|_| "[REDACTED]"))
                .field("key_path", key_path)
                .field("passphrase", &passphrase.as_ref().map(|_| "[REDACTED]"))
                .finish(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    pub auth_priority: Vec<SshAuthStage>,
    pub timeout_secs: Option<u64>,
    pub keepalive_secs: Option<u64>,
    pub jump_hosts: Vec<ConnectConfig>,
    pub term_type: Option<String>,
    pub accept_host_key: Option<String>,
    /// Internal opt-in (e.g. MCP setting) to trust unknown host keys on first connect.
    /// Mismatched host keys are ALWAYS rejected.
    pub auto_trust_unknown_host_key: bool,
}

#[derive(Debug, Clone)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<u32>,
}

impl ExecOutput {
    pub fn stdout_string(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_string(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

#[derive(Debug, Clone)]
pub enum ShellEvent {
    Data(Vec<u8>),
    Exit(Option<u32>),
    Closed,
}

enum ShellCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone)]
pub struct ShellHandle {
    tx: mpsc::Sender<ShellCommand>,
}

impl ShellHandle {
    pub async fn write(&self, data: Vec<u8>) -> Result<(), SshError> {
        self.tx
            .send(ShellCommand::Write(data))
            .await
            .map_err(|_| SshError::Channel("shell channel closed".into()))
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), SshError> {
        self.tx
            .send(ShellCommand::Resize { cols, rows })
            .await
            .map_err(|_| SshError::Channel("shell channel closed".into()))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        let _ = self.tx.send(ShellCommand::Close).await;
        Ok(())
    }
}

struct ClientHandler {
    host_port: String,
    known_hosts: KnownHostsStore,
    accept_host_key: Option<String>,
    auto_trust_unknown_host_key: bool,
    key_error: Arc<Mutex<Option<SshError>>>,
}

pub fn normalize_host_port(host: &str, port: u16) -> String {
    let trimmed = host.trim().to_ascii_lowercase();
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        match self.known_hosts.check(&self.host_port, &fingerprint) {
            Ok(HostKeyStatus::Known) => Ok(true),
            Ok(HostKeyStatus::Unknown) => {
                let explicitly_accepted = self
                    .accept_host_key
                    .as_deref()
                    .is_some_and(|fp| fp != "*" && fp == fingerprint.as_str());
                if explicitly_accepted || self.auto_trust_unknown_host_key {
                    let store = self.known_hosts.clone();
                    let host_port = self.host_port.clone();
                    let fp = fingerprint.clone();
                    let res = tokio::task::spawn_blocking(move || {
                        store.trust_if_unknown(&host_port, &fp)
                    })
                    .await
                    .map_err(|e| SshError::KnownHosts(format!("known_hosts task failed: {e}")));
                    match res {
                        Ok(Ok(HostKeyStatus::Known)) => Ok(true),
                        Ok(Ok(HostKeyStatus::Mismatch { expected })) => {
                            if let Ok(mut guard) = self.key_error.lock() {
                                *guard = Some(SshError::HostKeyMismatch {
                                    host: self.host_port.clone(),
                                    expected,
                                    got: fingerprint,
                                });
                            }
                            Ok(false)
                        }
                        Ok(Ok(HostKeyStatus::Unknown)) => Ok(false),
                        Ok(Err(err)) | Err(err) => {
                            if let Ok(mut guard) = self.key_error.lock() {
                                *guard = Some(err);
                            }
                            Ok(false)
                        }
                    }
                } else {
                    if let Ok(mut guard) = self.key_error.lock() {
                        *guard = Some(SshError::HostKeyUnknown {
                            host: self.host_port.clone(),
                            fingerprint,
                        });
                    }
                    Ok(false)
                }
            }
            Ok(HostKeyStatus::Mismatch { expected }) => {
                if let Ok(mut guard) = self.key_error.lock() {
                    *guard = Some(SshError::HostKeyMismatch {
                        host: self.host_port.clone(),
                        expected,
                        got: fingerprint,
                    });
                }
                Ok(false)
            }
            Err(err) => {
                if let Ok(mut guard) = self.key_error.lock() {
                    *guard = Some(err);
                }
                Ok(false)
            }
        }
    }
}

async fn try_authenticate_publickey(
    session: &mut client::Handle<ClientHandler>,
    username: &str,
    path: &str,
    passphrase: Option<&str>,
) -> Result<(), SshError> {
    let expanded = expand_tilde(path);
    let pass_owned = passphrase.map(|s| s.to_string());
    let key_pair =
        tokio::task::spawn_blocking(move || load_secret_key(&expanded, pass_owned.as_deref()))
            .await
            .map_err(|e| SshError::KeyLoad(e.to_string()))?
            .map_err(|e| SshError::KeyLoad(e.to_string()))?;
    let hash_alg = session
        .best_supported_rsa_hash()
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?
        .flatten();
    let auth_res = session
        .authenticate_publickey(
            username,
            PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
        )
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    if !auth_res.success() {
        return Err(SshError::Auth("public key authentication rejected".into()));
    }
    Ok(())
}

async fn try_authenticate_password(
    session: &mut client::Handle<ClientHandler>,
    username: &str,
    password: &str,
) -> Result<(), SshError> {
    let auth_res = session
        .authenticate_password(username, password)
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    if auth_res.success() {
        return Ok(());
    }
    Err(SshError::Auth("password authentication rejected".into()))
}

async fn try_authenticate_keyboard_interactive(
    session: &mut client::Handle<ClientHandler>,
    username: &str,
    secret: Option<&str>,
) -> Result<(), SshError> {
    let mut kbd = session
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| SshError::Auth(e.to_string()))?;
    for _ in 0..6 {
        match kbd {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::Auth(
                    "keyboard-interactive authentication rejected".into(),
                ));
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                if prompts.is_empty() {
                    match session
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                    {
                        Ok(next) => kbd = next,
                        Err(e) => return Err(SshError::Auth(e.to_string())),
                    }
                } else {
                    // Never send a password to echoed prompts (e.g. username/challenge) or multi-prompt challenges.
                    if prompts.len() > 1 || prompts.iter().any(|p| p.echo) {
                        return Err(SshError::Auth(
                            "交互认证包含回显或多步验证提示，已拒绝自动回填密码".into(),
                        ));
                    }
                    let Some(pw) = secret.filter(|s| !s.is_empty()) else {
                        return Err(SshError::Auth("交互认证需要输入密码或动态口令".into()));
                    };
                    let responses = vec![pw.to_string()];
                    match session
                        .authenticate_keyboard_interactive_respond(responses)
                        .await
                    {
                        Ok(next) => kbd = next,
                        Err(e) => return Err(SshError::Auth(e.to_string())),
                    }
                }
            }
        }
    }
    Err(SshError::Auth(
        "keyboard-interactive authentication exceeded max rounds".into(),
    ))
}

fn build_effective_priority(cfg: &ConnectConfig) -> Vec<SshAuthStage> {
    let primary = match &cfg.auth {
        Auth::Password(_) => SshAuthStage::Password,
        Auth::Key { .. } => SshAuthStage::Key,
        Auth::Credential(_) => SshAuthStage::Credential,
        Auth::KeyboardInteractive { .. } => SshAuthStage::KeyboardInteractive,
        Auth::Ask { key_path, .. } => {
            if key_path.as_deref().is_some_and(|p| !p.trim().is_empty()) {
                SshAuthStage::Key
            } else {
                SshAuthStage::Password
            }
        }
    };

    let mut order = Vec::with_capacity(4);
    if cfg.auth_priority.is_empty() {
        order.push(primary);
    } else {
        for &stage in &cfg.auth_priority {
            if !order.contains(&stage) {
                order.push(stage);
            }
        }
        if !order.contains(&primary) {
            order.insert(0, primary);
        }
    }
    for fallback in [
        SshAuthStage::Key,
        SshAuthStage::Credential,
        SshAuthStage::Password,
        SshAuthStage::KeyboardInteractive,
    ] {
        if !order.contains(&fallback) {
            order.push(fallback);
        }
    }
    order
}

async fn authenticate_session(
    session: &mut client::Handle<ClientHandler>,
    cfg: &ConnectConfig,
) -> Result<(), SshError> {
    let effective_user = match &cfg.auth {
        Auth::Credential(c) => c
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&cfg.username),
        _ => &cfg.username,
    };

    let key_material: Option<(&str, Option<&str>)> = match &cfg.auth {
        Auth::Key { path, passphrase } if !path.trim().is_empty() => {
            Some((path.as_str(), passphrase.as_deref()))
        }
        Auth::Ask {
            key_path: Some(path),
            passphrase,
            password,
        } if !path.trim().is_empty() => {
            Some((path.as_str(), passphrase.as_deref().or(password.as_deref())))
        }
        _ => None,
    };

    let password_material: Option<&str> = match &cfg.auth {
        Auth::Password(pw) if !pw.is_empty() => Some(pw.as_str()),
        Auth::KeyboardInteractive { password: Some(pw) } if !pw.is_empty() => Some(pw.as_str()),
        Auth::Ask {
            password: Some(pw), ..
        } if !pw.is_empty() => Some(pw.as_str()),
        _ => None,
    };

    let stages = build_effective_priority(cfg);
    let kbd_before_pwd = stages
        .iter()
        .position(|s| *s == SshAuthStage::KeyboardInteractive)
        < stages.iter().position(|s| *s == SshAuthStage::Password);
    let mut last_err: Option<SshError> = None;
    let mut attempted = false;

    for (idx, stage) in stages.iter().copied().enumerate() {
        match stage {
            SshAuthStage::Credential => {
                if let Auth::Credential(cred) = &cfg.auth {
                    if let Some(path) = cred.key_path.as_deref().filter(|p| !p.trim().is_empty()) {
                        attempted = true;
                        match try_authenticate_publickey(
                            session,
                            effective_user,
                            path,
                            cred.passphrase.as_deref().or(cred.password.as_deref()),
                        )
                        .await
                        {
                            Ok(()) => return Ok(()),
                            Err(e) => last_err = Some(e),
                        }
                    }
                    if let Some(pw) = cred.password.as_deref().filter(|p| !p.is_empty()) {
                        attempted = true;
                        if kbd_before_pwd {
                            if try_authenticate_keyboard_interactive(
                                session,
                                effective_user,
                                Some(pw),
                            )
                            .await
                            .is_ok()
                            {
                                return Ok(());
                            }
                            match try_authenticate_password(session, effective_user, pw).await {
                                Ok(()) => return Ok(()),
                                Err(e) => last_err = Some(e),
                            }
                        } else {
                            if try_authenticate_password(session, effective_user, pw)
                                .await
                                .is_ok()
                            {
                                return Ok(());
                            }
                            match try_authenticate_keyboard_interactive(
                                session,
                                effective_user,
                                Some(pw),
                            )
                            .await
                            {
                                Ok(()) => return Ok(()),
                                Err(e) => last_err = Some(e),
                            }
                        }
                    }
                }
            }
            SshAuthStage::Key => {
                if let Some((path, passphrase)) = key_material {
                    attempted = true;
                    match try_authenticate_publickey(session, effective_user, path, passphrase)
                        .await
                    {
                        Ok(()) => return Ok(()),
                        Err(e) => last_err = Some(e),
                    }
                } else if idx == 0 && matches!(cfg.auth, Auth::Key { .. }) {
                    // Only probe default ~/.ssh/id_ed25519 when auth mode is explicitly Key (not Password/Credential).
                    let default_key = expand_tilde("~/.ssh/id_ed25519");
                    if default_key.is_file()
                        && try_authenticate_publickey(
                            session,
                            effective_user,
                            "~/.ssh/id_ed25519",
                            None,
                        )
                        .await
                        .is_ok()
                    {
                        return Ok(());
                    }
                }
            }
            SshAuthStage::Password => {
                if let Some(pw) = password_material {
                    attempted = true;
                    match try_authenticate_password(session, effective_user, pw).await {
                        Ok(()) => return Ok(()),
                        Err(e) => last_err = Some(e),
                    }
                }
            }
            SshAuthStage::KeyboardInteractive => {
                let try_kbd = matches!(cfg.auth, Auth::KeyboardInteractive { .. })
                    || password_material.is_some();
                if try_kbd {
                    attempted = true;
                    match try_authenticate_keyboard_interactive(
                        session,
                        effective_user,
                        password_material,
                    )
                    .await
                    {
                        Ok(()) => return Ok(()),
                        Err(e) => last_err = Some(e),
                    }
                }
            }
        }
    }

    if let Some(err) = last_err {
        return Err(err);
    }
    if !attempted {
        return Err(SshError::Auth("需要输入登录凭证或密码".into()));
    }
    Err(SshError::Auth("SSH 认证被服务器拒绝".into()))
}

pub struct SshSession {
    session: client::Handle<ClientHandler>,
    jump_sessions: Vec<client::Handle<ClientHandler>>,
    term_type: String,
}

impl SshSession {
    async fn connect_hop_over_tcp(
        cfg: &ConnectConfig,
        known_hosts: KnownHostsStore,
    ) -> Result<client::Handle<ClientHandler>, SshError> {
        let host_port = normalize_host_port(&cfg.host, cfg.port);
        let key_error = Arc::new(Mutex::new(None));
        let timeout_secs = cfg.timeout_secs.unwrap_or(10).clamp(1, 300);
        let keepalive_secs = cfg.keepalive_secs.unwrap_or(20);
        let keepalive_interval = if keepalive_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(keepalive_secs.clamp(1, 3600)))
        };
        let inactivity_timeout =
            keepalive_interval.map(|d| d.saturating_mul(6).max(Duration::from_secs(120)));

        let config = Arc::new(client::Config {
            inactivity_timeout,
            keepalive_interval,
            keepalive_max: 3,
            ..Default::default()
        });

        let handler = ClientHandler {
            host_port,
            known_hosts,
            accept_host_key: cfg.accept_host_key.clone(),
            auto_trust_unknown_host_key: cfg.auto_trust_unknown_host_key,
            key_error: Arc::clone(&key_error),
        };

        let mut session = match tokio::time::timeout(Duration::from_secs(timeout_secs), async {
            let tcp = tokio::net::TcpStream::connect((cfg.host.as_str(), cfg.port))
                .await
                .map_err(russh::Error::from)?;
            let _ = tcp.set_nodelay(true);
            client::connect_stream(config, tcp, handler).await
        })
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                if let Ok(mut guard) = key_error.lock()
                    && let Some(err) = guard.take()
                {
                    return Err(err);
                }
                return Err(SshError::Connect(e.to_string()));
            }
            Err(_) => {
                return Err(SshError::Connect(format!(
                    "TCP 连接 {} 超时 ({}s)",
                    cfg.host, timeout_secs
                )));
            }
        };

        let auth_res = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            authenticate_session(&mut session, cfg),
        )
        .await;
        match auth_res {
            Ok(Ok(())) => Ok(session),
            Ok(Err(e)) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    session.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await;
                Err(e)
            }
            Err(_) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    session.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await;
                Err(SshError::Connect(format!(
                    "SSH 认证 {} 超时 ({}s)",
                    cfg.host, timeout_secs
                )))
            }
        }
    }

    async fn connect_hop_over_tunnel(
        prev_session: &client::Handle<ClientHandler>,
        cfg: &ConnectConfig,
        known_hosts: KnownHostsStore,
    ) -> Result<client::Handle<ClientHandler>, SshError> {
        let host_port = normalize_host_port(&cfg.host, cfg.port);
        let key_error = Arc::new(Mutex::new(None));
        let timeout_secs = cfg.timeout_secs.unwrap_or(10).clamp(1, 300);
        let keepalive_secs = cfg.keepalive_secs.unwrap_or(20);
        let keepalive_interval = if keepalive_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(keepalive_secs.clamp(1, 3600)))
        };
        let inactivity_timeout =
            keepalive_interval.map(|d| d.saturating_mul(6).max(Duration::from_secs(120)));

        let config = Arc::new(client::Config {
            inactivity_timeout,
            keepalive_interval,
            keepalive_max: 3,
            ..Default::default()
        });

        let handler = ClientHandler {
            host_port,
            known_hosts,
            accept_host_key: cfg.accept_host_key.clone(),
            auto_trust_unknown_host_key: cfg.auto_trust_unknown_host_key,
            key_error: Arc::clone(&key_error),
        };

        let mut session = match tokio::time::timeout(Duration::from_secs(timeout_secs), async {
            let channel = prev_session
                .channel_open_direct_tcpip(&cfg.host, u32::from(cfg.port), "127.0.0.1", 0)
                .await?;
            let stream = channel.into_stream();
            client::connect_stream(config, stream, handler).await
        })
        .await
        {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                if let Ok(mut guard) = key_error.lock()
                    && let Some(err) = guard.take()
                {
                    return Err(err);
                }
                return Err(SshError::Connect(format!(
                    "通过跳板机连接 {}:{} 失败: {e}",
                    cfg.host, cfg.port
                )));
            }
            Err(_) => {
                return Err(SshError::Connect(format!(
                    "跳板机隧道连接 {} 超时 ({}s)",
                    cfg.host, timeout_secs
                )));
            }
        };

        let auth_res = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            authenticate_session(&mut session, cfg),
        )
        .await;
        match auth_res {
            Ok(Ok(())) => Ok(session),
            Ok(Err(e)) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    session.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await;
                Err(e)
            }
            Err(_) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    session.disconnect(Disconnect::ByApplication, "", "English"),
                )
                .await;
                Err(SshError::Connect(format!(
                    "SSH 认证 {} 超时 ({}s)",
                    cfg.host, timeout_secs
                )))
            }
        }
    }

    pub async fn connect(
        cfg: ConnectConfig,
        known_hosts: KnownHostsStore,
    ) -> Result<Self, SshError> {
        let term_type = cfg
            .term_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("xterm-256color")
            .to_string();

        if cfg.jump_hosts.is_empty() {
            let session = Self::connect_hop_over_tcp(&cfg, known_hosts).await?;
            return Ok(Self {
                session,
                jump_sessions: Vec::new(),
                term_type,
            });
        }

        let mut jump_sessions: Vec<client::Handle<ClientHandler>> =
            Vec::with_capacity(cfg.jump_hosts.len());

        for (idx, hop_cfg) in cfg.jump_hosts.iter().enumerate() {
            let hop_session = if idx == 0 {
                Self::connect_hop_over_tcp(hop_cfg, known_hosts.clone()).await
            } else {
                let prev = jump_sessions.last().expect("previous jump session exists");
                Self::connect_hop_over_tunnel(prev, hop_cfg, known_hosts.clone()).await
            };
            match hop_session {
                Ok(s) => jump_sessions.push(s),
                Err(err) => {
                    for s in jump_sessions.into_iter().rev() {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(1),
                            s.disconnect(Disconnect::ByApplication, "", "English"),
                        )
                        .await;
                    }
                    return Err(err);
                }
            }
        }

        let last_jump = jump_sessions.last().expect("at least one jump session");
        let session = match Self::connect_hop_over_tunnel(last_jump, &cfg, known_hosts).await {
            Ok(s) => s,
            Err(err) => {
                for s in jump_sessions.into_iter().rev() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(1),
                        s.disconnect(Disconnect::ByApplication, "", "English"),
                    )
                    .await;
                }
                return Err(err);
            }
        };

        Ok(Self {
            session,
            jump_sessions,
            term_type,
        })
    }

    pub async fn open_shell(
        &self,
        cols: u32,
        rows: u32,
    ) -> Result<(ShellHandle, mpsc::Receiver<ShellEvent>), SshError> {
        let mut channel = tokio::time::timeout(Duration::from_secs(15), async {
            let channel = self
                .session
                .channel_open_session()
                .await
                .map_err(|e| SshError::Channel(e.to_string()))?;

            channel
                .request_pty(false, &self.term_type, cols, rows, 0, 0, &[])
                .await
                .map_err(|e| SshError::Channel(e.to_string()))?;

            channel
                .request_shell(true)
                .await
                .map_err(|e| SshError::Channel(e.to_string()))?;
            Ok::<_, SshError>(channel)
        })
        .await
        .map_err(|_| SshError::Channel("opening interactive shell timed out".into()))??;

        let (cmd_tx, mut cmd_rx) = mpsc::channel::<ShellCommand>(256);
        let (evt_tx, evt_rx) = mpsc::channel::<ShellEvent>(512);

        tokio::spawn(async move {
            'outer: loop {
                tokio::select! {
                    biased;
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(ShellCommand::Write(bytes)) => {
                                if channel.data(bytes.as_slice()).await.is_err() {
                                    break;
                                }
                            }
                            Some(ShellCommand::Resize { cols, rows }) => {
                                if channel.window_change(cols, rows, 0, 0).await.is_err() {
                                    break;
                                }
                            }
                            Some(ShellCommand::Close) | None => {
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        let evt = match msg {
                            Some(ChannelMsg::Data { data }) => ShellEvent::Data(data.to_vec()),
                            Some(ChannelMsg::ExtendedData { data, .. }) => ShellEvent::Data(data.to_vec()),
                            Some(ChannelMsg::ExitStatus { exit_status }) => ShellEvent::Exit(Some(exit_status)),
                            Some(ChannelMsg::Close) | None => break,
                            _ => continue,
                        };
                        // Allow commands (such as Close or Ctrl-C) to preempt if evt_tx is full.
                        loop {
                            tokio::select! {
                                biased;
                                cmd = cmd_rx.recv() => {
                                    match cmd {
                                        Some(ShellCommand::Write(bytes)) => {
                                            if channel.data(bytes.as_slice()).await.is_err() {
                                                break 'outer;
                                            }
                                        }
                                        Some(ShellCommand::Resize { cols, rows }) => {
                                            if channel.window_change(cols, rows, 0, 0).await.is_err() {
                                                break 'outer;
                                            }
                                        }
                                        Some(ShellCommand::Close) | None => break 'outer,
                                    }
                                }
                                permit = evt_tx.reserve() => {
                                    match permit {
                                        Ok(p) => {
                                            p.send(evt);
                                            break;
                                        }
                                        Err(_) => break 'outer,
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let _ = tokio::time::timeout(Duration::from_millis(500), channel.eof()).await;
            let _ = tokio::time::timeout(Duration::from_millis(500), channel.close()).await;
            let _ = evt_tx.try_send(ShellEvent::Closed);
        });

        Ok((ShellHandle { tx: cmd_tx }, evt_rx))
    }

    pub async fn exec_raw(
        &self,
        cmd: &str,
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, SshError> {
        const DEFAULT_MAX_OUTPUT_BYTES: usize = 128 * 1024 * 1024;
        self.exec_raw_with_limit(cmd, stdin, timeout, DEFAULT_MAX_OUTPUT_BYTES)
            .await
    }

    pub async fn exec_raw_with_limit(
        &self,
        cmd: &str,
        stdin: Option<&[u8]>,
        timeout: Duration,
        max_output_bytes: usize,
    ) -> Result<ExecOutput, SshError> {
        let open_res = tokio::time::timeout(timeout, async {
            let channel = self
                .session
                .channel_open_session()
                .await
                .map_err(|e| SshError::Channel(e.to_string()))?;

            channel
                .exec(true, cmd)
                .await
                .map_err(|e| SshError::Channel(e.to_string()))?;
            Ok::<_, SshError>(channel)
        })
        .await
        .map_err(|_| {
            SshError::Connect(format!("command timed out after {}s", timeout.as_secs()))
        })??;

        let (mut read_half, write_half) = open_res.split();
        let has_stdin = stdin.is_some();

        let io_fut = async {
            let write_fut = async {
                if let Some(input) = stdin {
                    const CHUNK_SIZE: usize = 32 * 1024;
                    for chunk in input.chunks(CHUNK_SIZE) {
                        write_half
                            .data(chunk)
                            .await
                            .map_err(|e| SshError::Channel(e.to_string()))?;
                    }
                }
                // Always signal EOF on stdin so remote commands reading stdin do not hang.
                write_half
                    .eof()
                    .await
                    .map_err(|e| SshError::Channel(e.to_string()))?;
                Ok::<_, SshError>(())
            };

            let read_fut = async {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                let mut exit_code = None;
                let mut overflowed = false;
                while let Some(msg) = read_half.wait().await {
                    match msg {
                        ChannelMsg::Data { data } => {
                            if stdout.len().saturating_add(data.len()) > max_output_bytes {
                                overflowed = true;
                                break;
                            }
                            stdout.extend_from_slice(&data);
                        }
                        ChannelMsg::ExtendedData { data, .. } => {
                            if stderr.len().saturating_add(data.len()) > max_output_bytes {
                                overflowed = true;
                                break;
                            }
                            stderr.extend_from_slice(&data);
                        }
                        ChannelMsg::ExitStatus { exit_status } => {
                            exit_code = Some(exit_status);
                        }
                        ChannelMsg::ExitSignal { .. } => {
                            if exit_code.is_none() {
                                exit_code = Some(128);
                            }
                        }
                        ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                (stdout, stderr, exit_code, overflowed)
            };

            tokio::join!(write_fut, read_fut)
        };

        let res = tokio::time::timeout(timeout, io_fut).await;
        // Always close the channel, including after timeout, so multiplexed SSH sessions don't leak channels.
        let _ = tokio::time::timeout(Duration::from_millis(300), write_half.close()).await;

        let (write_res, (stdout, stderr, exit_code, overflowed)) = res.map_err(|_| {
            SshError::Connect(format!("command timed out after {}s", timeout.as_secs()))
        })?;

        if overflowed {
            return Err(SshError::Channel(format!(
                "command output exceeded maximum limit ({max_output_bytes} bytes)"
            )));
        }
        if let Err(err) = write_res
            && (has_stdin || (exit_code.is_none() && stdout.is_empty() && stderr.is_empty()))
        {
            return Err(err);
        }

        Ok(ExecOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    pub async fn exec(
        &self,
        cmd: &str,
        timeout: Duration,
    ) -> Result<(String, Option<u32>), SshError> {
        let out = self.exec_raw(cmd, None, timeout).await?;
        Ok((out.stdout_string(), out.exit_code))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        let res = match tokio::time::timeout(
            Duration::from_secs(2),
            self.session
                .disconnect(Disconnect::ByApplication, "", "English"),
        )
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(SshError::Channel(e.to_string())),
            Err(_) => Ok(()),
        };
        for hop in self.jump_sessions.iter().rev() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                hop.disconnect(Disconnect::ByApplication, "", "English"),
            )
            .await;
        }
        res
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~"
        && let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
    {
        return PathBuf::from(home);
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
        && let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(trimmed)
}
