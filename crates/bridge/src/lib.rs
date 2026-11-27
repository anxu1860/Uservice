use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ironrdp_rdcleanpath::RDCleanPathPdu;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::accept_hdr_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_FAILED_ACCEPTS: usize = 16;
const READ_BUF_SIZE: usize = 65_536;

/// Callback to validate/pin an RDP server's leaf certificate SHA-256 fingerprint (`SHA256:<hex>`).
/// Returns `Ok(())` to accept or `Err(reason)` to reject (e.g. on fingerprint mismatch).
pub type CertPinChecker = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("failed to bind local bridge listener: {0}")]
    Bind(String),
    #[error("tcp connect failed: {0}")]
    Connect(String),
    #[error("websocket error: {0}")]
    WebSocket(String),
    #[error("rdcleanpath error: {0}")]
    RdCleanPath(String),
    #[error("tls handshake failed: {0}")]
    Tls(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeMode {
    /// Raw TCP pass-through over WebSocket (used by VNC / noVNC).
    Tcp,
    /// RDCleanPath handshake + TLS termination + pass-through (used by IronRDP WASM).
    RdCleanPath,
}

pub struct BridgeHandle {
    pub id: Uuid,
    pub ws_url: String,
    shutdown_tx: Option<oneshot::Sender<()>>,
    done_rx: Option<oneshot::Receiver<()>>,
}

impl BridgeHandle {
    pub fn close(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }

    pub fn take_done_rx(&mut self) -> Option<oneshot::Receiver<()>> {
        self.done_rx.take()
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.close();
    }
}

fn is_allowed_ws_origin(origin: &str) -> bool {
    let lower = origin.trim().to_ascii_lowercase();
    if lower == "tauri://localhost"
        || lower == "https://tauri.localhost"
        || lower == "http://tauri.localhost"
    {
        return true;
    }
    #[cfg(debug_assertions)]
    {
        if lower == "http://localhost:1420" || lower == "http://127.0.0.1:1420" {
            return true;
        }
    }
    false
}

fn token_matches(query: &str, expected: &str) -> bool {
    let expected_bytes = expected.as_bytes();
    for pair in query.split('&') {
        if let Some(val) = pair.strip_prefix("token=") {
            let val_bytes = val.as_bytes();
            if val_bytes.len() == expected_bytes.len()
                && bool::from(val_bytes.ct_eq(expected_bytes))
            {
                return true;
            }
        }
    }
    false
}

fn bridge_ws_config() -> WebSocketConfig {
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(16 * 1024 * 1024);
    cfg.max_frame_size = Some(4 * 1024 * 1024);
    cfg.max_write_buffer_size = 16 * 1024 * 1024;
    cfg
}

fn build_rdp_tls_config(
    host_key: String,
    cert_pin_checker: Option<CertPinChecker>,
) -> Arc<ClientConfig> {
    let provider = rustls::crypto::ring::default_provider();
    let algs = provider.signature_verification_algorithms;
    Arc::new(
        ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .expect("valid TLS protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(RdpTofuCertVerifier {
                algs,
                host_key,
                cert_pin_checker,
            }))
            .with_no_client_auth(),
    )
}

/// Start a single-session local WebSocket-to-TCP (or RDCleanPath) bridge bound to `127.0.0.1:0`.
pub async fn start_bridge(
    host: String,
    port: u16,
    mode: BridgeMode,
    cert_pin_checker: Option<CertPinChecker>,
) -> Result<BridgeHandle, BridgeError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| BridgeError::Bind(e.to_string()))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| BridgeError::Bind(e.to_string()))?;

    let id = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    let ws_url = format!("ws://127.0.0.1:{}/?token={token}", local_addr.port());
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        struct DoneGuard(Option<oneshot::Sender<()>>);
        impl Drop for DoneGuard {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        let _done_guard = DoneGuard(Some(done_tx));

        let deadline = tokio::time::Instant::now() + ACCEPT_TIMEOUT;
        let mut failed_attempts = 0usize;
        let ws_stream = loop {
            let now = tokio::time::Instant::now();
            if now >= deadline || failed_attempts >= MAX_FAILED_ACCEPTS {
                return;
            }
            let remaining = deadline - now;
            let accepted = tokio::select! {
                res = tokio::time::timeout(remaining, listener.accept()) => match res {
                    Ok(Ok((stream, _))) => stream,
                    _ => return,
                },
                _ = &mut shutdown_rx => return,
            };
            let _ = accepted.set_nodelay(true);

            let expected_token = token.clone();
            #[allow(clippy::result_large_err)]
            let upgrade_fut = accept_hdr_async_with_config(
                accepted,
                move |req: &Request, resp: Response| {
                    if let Some(origin_hdr) = req.headers().get("origin") {
                        let origin_ok = origin_hdr.to_str().is_ok_and(is_allowed_ws_origin);
                        if !origin_ok {
                            let mut err = ErrorResponse::new(Some("forbidden origin".into()));
                            *err.status_mut() = StatusCode::FORBIDDEN;
                            return Err(err);
                        }
                    }
                    let query = req.uri().query().unwrap_or("");
                    if token_matches(query, &expected_token) {
                        Ok(resp)
                    } else {
                        let mut err = ErrorResponse::new(Some("unauthorized".into()));
                        *err.status_mut() = StatusCode::UNAUTHORIZED;
                        Err(err)
                    }
                },
                Some(bridge_ws_config()),
            );

            match tokio::time::timeout(HANDSHAKE_TIMEOUT, upgrade_fut).await {
                Ok(Ok(ws)) => break ws,
                _ => {
                    failed_attempts += 1;
                    continue;
                }
            }
        };

        // Stop accepting further connections only AFTER a valid authenticated client upgraded.
        drop(listener);

        tokio::select! {
            _ = run_session(ws_stream, host, port, mode, cert_pin_checker) => {}
            _ = &mut shutdown_rx => {}
        }
    });

    Ok(BridgeHandle {
        id,
        ws_url,
        shutdown_tx: Some(shutdown_tx),
        done_rx: Some(done_rx),
    })
}

async fn send_ws_error_close(
    ws_stream: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    reason: &str,
) {
    let short: String = reason.chars().take(100).collect();
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        ws_stream.close(Some(CloseFrame {
            code: CloseCode::Error,
            reason: short.into(),
        })),
    )
    .await;
}

async fn run_session(
    mut ws_stream: tokio_tungstenite::WebSocketStream<TcpStream>,
    host: String,
    port: u16,
    mode: BridgeMode,
    cert_pin_checker: Option<CertPinChecker>,
) {
    match mode {
        BridgeMode::Tcp => {
            let tcp = match tokio::time::timeout(
                CONNECT_TIMEOUT,
                TcpStream::connect((host.as_str(), port)),
            )
            .await
            {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    send_ws_error_close(&mut ws_stream, &format!("TCP connect failed: {e}")).await;
                    return;
                }
                Err(_) => {
                    send_ws_error_close(&mut ws_stream, "TCP connect timed out").await;
                    return;
                }
            };
            let _ = tcp.set_nodelay(true);
            pump_ws_and_stream(ws_stream, tcp).await;
        }
        BridgeMode::RdCleanPath => {
            if let Err(err) =
                run_rdcleanpath_session(&mut ws_stream, host, port, cert_pin_checker).await
            {
                send_ws_error_close(&mut ws_stream, &err.to_string()).await;
            }
        }
    }
}

async fn run_rdcleanpath_session(
    ws_stream: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    host: String,
    port: u16,
    cert_pin_checker: Option<CertPinChecker>,
) -> Result<(), BridgeError> {
    // 1. Read the initial RDCleanPathRequest from IronRDP WASM (bounded timeout & frame count).
    let req_bytes = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut non_binary_frames = 0usize;
        loop {
            match ws_stream.next().await {
                Some(Ok(Message::Binary(data))) => return Ok(data),
                Some(Ok(Message::Ping(p))) => {
                    non_binary_frames += 1;
                    if non_binary_frames > 8 {
                        return Err(BridgeError::WebSocket(
                            "too many control frames before RDCleanPath request".into(),
                        ));
                    }
                    let _ = ws_stream.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(BridgeError::WebSocket(
                        "closed before RDCleanPath request".into(),
                    ));
                }
                Some(Ok(_)) => {
                    non_binary_frames += 1;
                    if non_binary_frames > 8 {
                        return Err(BridgeError::WebSocket(
                            "unexpected frames before RDCleanPath request".into(),
                        ));
                    }
                }
                Some(Err(e)) => return Err(BridgeError::WebSocket(e.to_string())),
            }
        }
    })
    .await
    .map_err(|_| BridgeError::WebSocket("timed out waiting for RDCleanPath request".into()))??;

    let pdu = RDCleanPathPdu::from_der(&req_bytes)
        .map_err(|e| BridgeError::RdCleanPath(e.to_string()))?;

    let x224_pdu = pdu
        .x224_connection_pdu
        .as_ref()
        .ok_or_else(|| BridgeError::RdCleanPath("missing x224_connection_pdu in request".into()))?;

    // 2. Connect to the configured RDP server (ignoring client-supplied destination for safety).
    let mut tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| BridgeError::Connect("connection timed out".into()))?
        .map_err(|e| BridgeError::Connect(e.to_string()))?;
    let _ = tcp.set_nodelay(true);
    let server_addr: SocketAddr = tcp
        .peer_addr()
        .map_err(|e| BridgeError::Connect(e.to_string()))?;

    // 3. Exchange X.224 Connection Request / Confirm over plain TCP.
    tokio::time::timeout(CONNECT_TIMEOUT, tcp.write_all(x224_pdu.as_bytes()))
        .await
        .map_err(|_| BridgeError::Connect("X.224 write timed out".into()))?
        .map_err(|e| BridgeError::Connect(e.to_string()))?;

    let x224_resp = tokio::time::timeout(CONNECT_TIMEOUT, read_tpkt_pdu(&mut tcp))
        .await
        .map_err(|_| BridgeError::Connect("X.224 response timed out".into()))??;

    // 4. Perform TLS handshake with RDP server using TOFU leaf certificate pinning.
    let host_norm = host.trim().to_ascii_lowercase();
    let host_key = if host_norm.contains(':') && !host_norm.starts_with('[') {
        format!("rdp:[{host_norm}]:{port}")
    } else {
        format!("rdp:{host_norm}:{port}")
    };
    let tls_cfg = build_rdp_tls_config(host_key, cert_pin_checker);
    let connector = TlsConnector::from(tls_cfg);
    let server_name = ServerName::try_from(host.clone())
        .unwrap_or_else(|_| ServerName::try_from("rdp.local".to_string()).expect("valid dns"));

    let tls_stream = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| BridgeError::Tls("TLS handshake timed out".into()))?
        .map_err(|e| BridgeError::Tls(e.to_string()))?;

    let cert_chain: Vec<Vec<u8>> = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .map(|certs| certs.iter().map(|c| c.as_ref().to_vec()).collect())
        .unwrap_or_default();

    // 5. Send RDCleanPathResponse back to IronRDP WASM.
    let resp_pdu = RDCleanPathPdu::new_response(server_addr.to_string(), x224_resp, cert_chain)
        .map_err(|e| BridgeError::RdCleanPath(e.to_string()))?;
    let resp_der = resp_pdu
        .to_der()
        .map_err(|e| BridgeError::RdCleanPath(e.to_string()))?;

    ws_stream
        .send(Message::Binary(resp_der.into()))
        .await
        .map_err(|e| BridgeError::WebSocket(e.to_string()))?;

    // 6. Pump encrypted RDP traffic between WebSocket and TLS stream.
    pump_ws_and_stream_ref(ws_stream, tls_stream).await;
    Ok(())
}

async fn read_tpkt_pdu(tcp: &mut TcpStream) -> Result<Vec<u8>, BridgeError> {
    let mut header = [0u8; 4];
    tcp.read_exact(&mut header)
        .await
        .map_err(|e| BridgeError::Connect(format!("failed to read TPKT header: {e}")))?;

    if header[0] != 3 {
        return Err(BridgeError::RdCleanPath(format!(
            "invalid TPKT version byte: {}",
            header[0]
        )));
    }
    let total_len = u16::from_be_bytes([header[2], header[3]]) as usize;
    if total_len < 4 {
        return Err(BridgeError::RdCleanPath(format!(
            "invalid TPKT length: {total_len}"
        )));
    }

    let mut pdu = Vec::with_capacity(total_len);
    pdu.extend_from_slice(&header);
    pdu.resize(total_len, 0);
    tcp.read_exact(&mut pdu[4..])
        .await
        .map_err(|e| BridgeError::Connect(format!("failed to read TPKT body: {e}")))?;
    Ok(pdu)
}

async fn pump_ws_and_stream<S>(
    mut ws_stream: tokio_tungstenite::WebSocketStream<TcpStream>,
    stream: S,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    pump_ws_and_stream_ref(&mut ws_stream, stream).await;
}

async fn pump_ws_and_stream_ref<S>(
    ws_stream: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    stream: S,
) where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut io_rx, mut io_tx) = tokio::io::split(stream);
    let mut buf = vec![0u8; READ_BUF_SIZE];

    loop {
        tokio::select! {
            ws_msg = ws_stream.next() => {
                match ws_msg {
                    Some(Ok(Message::Binary(data))) => {
                        if io_tx.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        if ws_stream.send(Message::Pong(p)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
            read_res = io_rx.read(&mut buf) => {
                match read_res {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ws_stream
                            .send(Message::Binary(buf[..n].to_vec().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        }
    }

    let _ = tokio::time::timeout(Duration::from_secs(1), io_tx.shutdown()).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), ws_stream.close(None)).await;
}

struct RdpTofuCertVerifier {
    algs: WebPkiSupportedAlgorithms,
    host_key: String,
    cert_pin_checker: Option<CertPinChecker>,
}

impl std::fmt::Debug for RdpTofuCertVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RdpTofuCertVerifier")
            .field("host_key", &self.host_key)
            .finish()
    }
}

fn cert_sha256_fingerprint(cert: &CertificateDer<'_>) -> String {
    let digest = Sha256::digest(cert.as_ref());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("SHA256:");
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

impl ServerCertVerifier for RdpTofuCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        if let Some(checker) = &self.cert_pin_checker {
            let fp = cert_sha256_fingerprint(end_entity);
            checker(&self.host_key, &fp).map_err(RustlsError::General)?;
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}
