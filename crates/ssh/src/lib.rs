pub mod known_hosts;

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{PrivateKeyWithHashAlg, load_secret_key, ssh_key};
use russh::{ChannelMsg, Disconnect, client};
use thiserror::Error;
use tokio::sync::mpsc;

pub use known_hosts::KnownHostsStore;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("authentication failed: {0}")]
    Auth(String),
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

#[derive(Clone)]
pub enum Auth {
    Password(String),
    Key {
        path: String,
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
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
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
    key_error: Arc<Mutex<Option<SshError>>>,
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
        match self
            .known_hosts
            .verify_or_trust(&self.host_port, &fingerprint)
        {
            Ok(()) => Ok(true),
            Err(err) => {
                if let Ok(mut guard) = self.key_error.lock() {
                    *guard = Some(err);
                }
                Ok(false)
            }
        }
    }
}

pub struct SshSession {
    session: client::Handle<ClientHandler>,
}

impl SshSession {
    pub async fn connect(
        cfg: ConnectConfig,
        known_hosts: KnownHostsStore,
    ) -> Result<Self, SshError> {
        let host_port = format!("{}:{}", cfg.host, cfg.port);
        let key_error = Arc::new(Mutex::new(None));

        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let handler = ClientHandler {
            host_port: host_port.clone(),
            known_hosts,
            key_error: Arc::clone(&key_error),
        };

        let mut session =
            match client::connect(config, (cfg.host.as_str(), cfg.port), handler).await {
                Ok(s) => s,
                Err(e) => {
                    if let Ok(mut guard) = key_error.lock()
                        && let Some(err) = guard.take()
                    {
                        return Err(err);
                    }
                    return Err(SshError::Connect(e.to_string()));
                }
            };

        match cfg.auth {
            Auth::Password(password) => {
                let auth_res = session
                    .authenticate_password(cfg.username, password)
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?;
                if !auth_res.success() {
                    return Err(SshError::Auth("password authentication rejected".into()));
                }
            }
            Auth::Key { path, passphrase } => {
                let expanded = expand_tilde(&path);
                let key_pair = load_secret_key(&expanded, passphrase.as_deref())
                    .map_err(|e| SshError::KeyLoad(e.to_string()))?;
                let hash_alg = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?
                    .flatten();
                let auth_res = session
                    .authenticate_publickey(
                        cfg.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash_alg),
                    )
                    .await
                    .map_err(|e| SshError::Auth(e.to_string()))?;
                if !auth_res.success() {
                    return Err(SshError::Auth("public key authentication rejected".into()));
                }
            }
        }

        Ok(Self { session })
    }

    pub async fn open_shell(
        &self,
        cols: u32,
        rows: u32,
    ) -> Result<(ShellHandle, mpsc::Receiver<ShellEvent>), SshError> {
        let mut channel = self
            .session
            .channel_open_session()
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;

        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| SshError::Channel(e.to_string()))?;

        let (cmd_tx, mut cmd_rx) = mpsc::channel::<ShellCommand>(64);
        let (evt_tx, evt_rx) = mpsc::channel::<ShellEvent>(256);

        tokio::spawn(async move {
            loop {
                tokio::select! {
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
                                let _ = channel.eof().await;
                                let _ = channel.close().await;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                if evt_tx.send(ShellEvent::Data(data.to_vec())).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                if evt_tx.send(ShellEvent::Data(data.to_vec())).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                let _ = evt_tx.send(ShellEvent::Exit(Some(exit_status))).await;
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }
            let _ = evt_tx.send(ShellEvent::Closed).await;
        });

        Ok((ShellHandle { tx: cmd_tx }, evt_rx))
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.session
            .disconnect(Disconnect::ByApplication, "", "English")
            .await
            .map_err(|e| SshError::Channel(e.to_string()))
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(path)
}
