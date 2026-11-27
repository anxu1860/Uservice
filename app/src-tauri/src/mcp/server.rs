use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Semaphore, mpsc, watch};
use uuid::Uuid;

use crate::AppState;
use crate::mcp::tools;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024; // 16 MiB JSON-RPC body cap
const MAX_HEADER_LINE_BYTES: usize = 16 * 1024; // 16 KiB per header/request line
const MAX_HEADERS: usize = 100;
const MAX_BATCH_SIZE: usize = 32;
const MAX_CONCURRENT_CONNECTIONS: usize = 64;
const MAX_SSE_SESSIONS: usize = 64;
const SSE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PROTOCOL_VERSION: &str = "2025-03-26";

type SseSessions = Arc<Mutex<HashMap<String, mpsc::Sender<String>>>>;

struct ActiveClientGuard {
    app: tauri::AppHandle,
}

impl ActiveClientGuard {
    fn new(app: &tauri::AppHandle) -> Self {
        let state = app.state::<AppState>();
        state.mcp.active_clients.fetch_add(1, Ordering::Relaxed);
        Self { app: app.clone() }
    }
}

impl Drop for ActiveClientGuard {
    fn drop(&mut self) {
        let state = self.app.state::<AppState>();
        state.mcp.dec_active_clients();
    }
}

fn is_allowed_origin(origin: &str) -> bool {
    if origin.is_empty() || origin.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = origin.to_ascii_lowercase();
    if lower == "tauri://localhost"
        || lower == "https://tauri.localhost"
        || lower == "http://tauri.localhost"
    {
        return true;
    }
    let rest = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"));
    let Some(host_port) = rest else {
        return false;
    };
    let (host, port_opt) = if let Some(after_bracket) = host_port.strip_prefix("[::1]") {
        if after_bracket.is_empty() {
            ("[::1]", None)
        } else if let Some(p) = after_bracket.strip_prefix(':') {
            ("[::1]", Some(p))
        } else {
            return false;
        }
    } else if let Some((h, p)) = host_port.split_once(':') {
        (h, Some(p))
    } else {
        (host_port, None)
    };
    if host != "localhost" && host != "127.0.0.1" && host != "[::1]" {
        return false;
    }
    match port_opt {
        None => true,
        Some(p) => {
            !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u16>().is_ok()
        }
    }
}

fn percent_encode_query_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(&mut out, "%{b:02X}");
            }
        }
    }
    out
}

fn extract_host_without_port(host_header: &str) -> Option<&str> {
    let h = host_header.trim();
    if h.is_empty() || h.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    if let Some(rest) = h.strip_prefix('[') {
        let end = rest.find(']')?;
        let trailing = &rest[end + 1..];
        if !trailing.is_empty() {
            let port_str = trailing.strip_prefix(':')?;
            if port_str.is_empty() || !port_str.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
        }
        return Some(&h[..end + 2]);
    }
    if let Some((host, port)) = h.rsplit_once(':') {
        if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        return Some(host);
    }
    Some(h)
}

fn is_loopback_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    lower == "localhost"
        || lower == "127.0.0.1"
        || lower == "::1"
        || lower == "[::1]"
        || lower.ends_with(".localhost")
}

/// Validates HTTP `Host` header against DNS rebinding attacks when bound to loopback.
fn is_allowed_host(host_header: Option<&str>, bound_host: &str) -> bool {
    let bound = bound_host.trim().to_ascii_lowercase();
    // Wildcard bind explicitly exposes the server to non-loopback interfaces.
    if bound == "0.0.0.0" || bound == "::" || bound == "[::]" {
        return match host_header {
            None => true,
            Some(h) => extract_host_without_port(h).is_some(),
        };
    }
    let Some(raw) = host_header else {
        // HTTP/1.0 clients without a Host header on loopback
        return true;
    };
    let Some(host) = extract_host_without_port(raw) else {
        return false;
    };
    let host_lower = host.to_ascii_lowercase();
    if is_loopback_host(&host_lower) {
        return true;
    }
    !bound.is_empty() && (host_lower == bound || host_lower == format!("[{bound}]"))
}

fn sanitize_header_value(val: &str) -> Option<String> {
    if val.is_empty()
        || val
            .chars()
            .any(|c| c == '\r' || c == '\n' || c.is_control())
    {
        None
    } else {
        Some(val.to_string())
    }
}

struct HttpRequestHead {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

enum HttpParseError {
    BadRequest(&'static str),
    PayloadTooLarge,
    Io,
}

async fn write_sse_chunk(writer: &mut tokio::net::tcp::OwnedWriteHalf, data: &[u8]) -> bool {
    matches!(
        tokio::time::timeout(SSE_WRITE_TIMEOUT, async {
            writer.write_all(data).await?;
            writer.flush().await
        })
        .await,
        Ok(Ok(()))
    )
}

pub async fn run_http_server(
    app: tauri::AppHandle,
    listener: TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let sse_sessions: SseSessions = Arc::new(Mutex::new(HashMap::new()));
    let conn_semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));

    loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let Ok(permit) = Arc::clone(&conn_semaphore).try_acquire_owned() else {
                            drop(stream);
                            continue;
                        };
                        let app_clone = app.clone();
                        let sessions_clone = Arc::clone(&sse_sessions);
                        let rx_clone = shutdown_rx.clone();
                        tokio::spawn(async move {
                            let _permit = permit;
                            handle_connection(app_clone, stream, sessions_clone, rx_clone).await;
                        });
                    }
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

async fn handle_connection(
    app: tauri::AppHandle,
    stream: TcpStream,
    sse_sessions: SseSessions,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let _ = stream.set_nodelay(true);
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let req = match tokio::time::timeout(Duration::from_secs(30), read_http_head(&mut reader)).await
    {
        Ok(Ok(Some(req))) => req,
        Ok(Err(HttpParseError::BadRequest(msg))) => {
            let body = serde_json::to_vec(&json!({ "error": msg })).unwrap_or_default();
            let _ = write_response(
                &mut write_half,
                400,
                "Bad Request",
                None,
                &[("Content-Type", "application/json")],
                &body,
            )
            .await;
            return;
        }
        Ok(Err(HttpParseError::PayloadTooLarge)) => {
            let body = br#"{"error":"Payload Too Large"}"#;
            let _ = write_response(
                &mut write_half,
                413,
                "Payload Too Large",
                None,
                &[("Content-Type", "application/json")],
                body,
            )
            .await;
            return;
        }
        _ => return,
    };

    // Strict Host header validation to prevent DNS rebinding against localhost MCP endpoints.
    let bound_host = {
        let state = app.state::<AppState>();
        state.mcp.config.read().await.host.clone()
    };
    if !is_allowed_host(req.headers.get("host").map(String::as_str), &bound_host) {
        let body = br#"{"error":"Forbidden: invalid Host header"}"#;
        let _ = write_response(
            &mut write_half,
            403,
            "Forbidden",
            None,
            &[("Content-Type", "application/json")],
            body,
        )
        .await;
        return;
    }

    // Strict CORS / Origin validation: allow requests without Origin (CLI/desktop clients)
    // or from localhost / tauri origins only; reject cross-origin browser requests from arbitrary sites.
    let allowed_origin: Option<String> = match req.headers.get("origin") {
        None => None,
        Some(origin) if is_allowed_origin(origin) => Some(origin.clone()),
        Some(_) => {
            let body = br#"{"error":"Forbidden: cross-origin request blocked"}"#;
            let _ = write_response(
                &mut write_half,
                403,
                "Forbidden",
                None,
                &[("Content-Type", "application/json")],
                body,
            )
            .await;
            return;
        }
    };
    let origin_ref = allowed_origin.as_deref();

    // CORS preflight
    if req.method == "OPTIONS" {
        let _ = write_response(&mut write_half, 204, "No Content", origin_ref, &[], b"").await;
        return;
    }

    // Health check (no auth required)
    if req.method == "GET" && req.path == "/health" {
        let body = serde_json::to_vec(&json!({
            "ok": true,
            "server": "serverhub-mcp",
            "protocolVersion": PROTOCOL_VERSION,
        }))
        .unwrap_or_default();
        let _ = write_response(
            &mut write_half,
            200,
            "OK",
            origin_ref,
            &[("Content-Type", "application/json")],
            &body,
        )
        .await;
        return;
    }

    // Auth check BEFORE reading any HTTP request body (prevents unauthenticated memory/bandwidth abuse).
    let state = app.state::<AppState>();
    let require_auth = state.mcp.config.read().await.require_auth;
    if require_auth {
        let expected = state.mcp.token.read().await.clone();
        if expected.is_empty() || !is_authorized(&req, &expected) {
            let body = serde_json::to_vec(&json!({
                "error": "Unauthorized: missing or invalid Bearer token"
            }))
            .unwrap_or_default();
            let _ = write_response(
                &mut write_half,
                401,
                "Unauthorized",
                origin_ref,
                &[
                    ("Content-Type", "application/json"),
                    ("WWW-Authenticate", "Bearer"),
                ],
                &body,
            )
            .await;
            return;
        }
    }

    match (req.method.as_str(), req.path.as_str()) {
        // Streamable HTTP: POST /mcp
        ("POST", "/mcp") => {
            let req_body = match tokio::time::timeout(
                Duration::from_secs(30),
                read_http_body(&mut reader, &req.headers),
            )
            .await
            {
                Ok(Ok(b)) => b,
                Ok(Err(HttpParseError::PayloadTooLarge)) => {
                    let body = br#"{"error":"Payload Too Large"}"#;
                    let _ = write_response(
                        &mut write_half,
                        413,
                        "Payload Too Large",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        body,
                    )
                    .await;
                    return;
                }
                Ok(Err(HttpParseError::BadRequest(msg))) => {
                    let body = serde_json::to_vec(&json!({ "error": msg })).unwrap_or_default();
                    let _ = write_response(
                        &mut write_half,
                        400,
                        "Bad Request",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        &body,
                    )
                    .await;
                    return;
                }
                _ => return,
            };

            state.mcp.total_requests.fetch_add(1, Ordering::Relaxed);
            let session_id = req
                .headers
                .get("mcp-session-id")
                .and_then(|v| sanitize_header_value(v))
                .unwrap_or_else(|| Uuid::new_v4().to_string());

            let parsed: Value = match serde_json::from_slice(&req_body) {
                Ok(v) => v,
                Err(e) => {
                    let err_resp = json_rpc_error(Value::Null, -32700, format!("Parse error: {e}"));
                    let body = serde_json::to_vec(&err_resp).unwrap_or_default();
                    let _ = write_response(
                        &mut write_half,
                        400,
                        "Bad Request",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        &body,
                    )
                    .await;
                    return;
                }
            };

            let resp_opt = handle_jsonrpc_payload(&app, parsed).await;
            match resp_opt {
                Some(resp) => {
                    let body = serde_json::to_vec(&resp).unwrap_or_default();
                    let _ = write_response(
                        &mut write_half,
                        200,
                        "OK",
                        origin_ref,
                        &[
                            ("Content-Type", "application/json"),
                            ("Mcp-Session-Id", session_id.as_str()),
                        ],
                        &body,
                    )
                    .await;
                }
                None => {
                    let _ = write_response(
                        &mut write_half,
                        202,
                        "Accepted",
                        origin_ref,
                        &[("Mcp-Session-Id", session_id.as_str())],
                        b"",
                    )
                    .await;
                }
            }
        }

        // Streamable HTTP: GET /mcp (SSE keepalive channel)
        ("GET", "/mcp") => {
            let session_id = req
                .headers
                .get("mcp-session-id")
                .and_then(|v| sanitize_header_value(v))
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let mut header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/event-stream\r\n\
                 Cache-Control: no-cache\r\n\
                 Connection: keep-alive\r\n\
                 Mcp-Session-Id: {session_id}\r\n"
            );
            if let Some(orig) = origin_ref {
                header.push_str(&format!(
                    "Access-Control-Allow-Origin: {orig}\r\n\
                     Access-Control-Expose-Headers: Mcp-Session-Id\r\n\
                     Vary: Origin\r\n"
                ));
            }
            header.push_str("\r\n");
            if !write_sse_chunk(&mut write_half, header.as_bytes()).await {
                return;
            }
            let _client_guard = ActiveClientGuard::new(&app);
            let mut interval = tokio::time::interval(Duration::from_secs(25));
            let mut eof_buf = [0u8; 64];
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    read_res = reader.read(&mut eof_buf) => {
                        match read_res {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                    _ = interval.tick() => {
                        if !write_sse_chunk(&mut write_half, b": keepalive\n\n").await {
                            break;
                        }
                    }
                }
            }
        }

        // Streamable HTTP: DELETE /mcp
        ("DELETE", "/mcp") => {
            if let Some(sid) = req.headers.get("mcp-session-id") {
                sse_sessions.lock().await.remove(sid);
            }
            let _ = write_response(&mut write_half, 200, "OK", origin_ref, &[], b"").await;
        }

        // Legacy HTTP+SSE: GET /sse
        ("GET", "/sse") => {
            // Reject CR/LF/control/whitespace in query token and percent-encode before embedding in endpoint URL.
            let encoded_tok = match req.query.get("token") {
                Some(tok) => match sanitize_header_value(tok) {
                    Some(clean) if !clean.chars().any(char::is_whitespace) => {
                        Some(percent_encode_query_component(&clean))
                    }
                    _ => {
                        let body = br#"{"error":"Invalid token parameter"}"#;
                        let _ = write_response(
                            &mut write_half,
                            400,
                            "Bad Request",
                            origin_ref,
                            &[("Content-Type", "application/json")],
                            body,
                        )
                        .await;
                        return;
                    }
                },
                None => None,
            };

            let session_id = Uuid::new_v4().to_string();
            let (tx, mut rx) = mpsc::channel::<String>(64);
            {
                let mut sessions = sse_sessions.lock().await;
                if sessions.len() >= MAX_SSE_SESSIONS {
                    let body = br#"{"error":"Too many active SSE sessions"}"#;
                    let _ = write_response(
                        &mut write_half,
                        503,
                        "Service Unavailable",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        body,
                    )
                    .await;
                    return;
                }
                sessions.insert(session_id.clone(), tx);
            }

            let mut header = String::from(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/event-stream\r\n\
                 Cache-Control: no-cache\r\n\
                 Connection: keep-alive\r\n",
            );
            if let Some(orig) = origin_ref {
                header.push_str(&format!(
                    "Access-Control-Allow-Origin: {orig}\r\n\
                     Vary: Origin\r\n"
                ));
            }
            header.push_str("\r\n");
            if !write_sse_chunk(&mut write_half, header.as_bytes()).await {
                sse_sessions.lock().await.remove(&session_id);
                return;
            }

            let endpoint_url = if let Some(tok) = encoded_tok {
                format!("/messages?sessionId={session_id}&token={tok}")
            } else {
                format!("/messages?sessionId={session_id}")
            };
            let init_evt = format!("event: endpoint\ndata: {endpoint_url}\n\n");
            if !write_sse_chunk(&mut write_half, init_evt.as_bytes()).await {
                sse_sessions.lock().await.remove(&session_id);
                return;
            }

            let _client_guard = ActiveClientGuard::new(&app);
            let mut interval = tokio::time::interval(Duration::from_secs(25));
            let mut eof_buf = [0u8; 64];
            loop {
                tokio::select! {
                    changed = shutdown_rx.changed() => {
                        if changed.is_err() || *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    read_res = reader.read(&mut eof_buf) => {
                        match read_res {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                    msg = rx.recv() => {
                        match msg {
                            Some(json_str) => {
                                let evt = format!("event: message\ndata: {json_str}\n\n");
                                if !write_sse_chunk(&mut write_half, evt.as_bytes()).await {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    _ = interval.tick() => {
                        if !write_sse_chunk(&mut write_half, b": keepalive\n\n").await {
                            break;
                        }
                    }
                }
            }
            sse_sessions.lock().await.remove(&session_id);
        }

        // Legacy HTTP+SSE: POST /messages?sessionId=...
        ("POST", "/messages") => {
            let req_body = match tokio::time::timeout(
                Duration::from_secs(30),
                read_http_body(&mut reader, &req.headers),
            )
            .await
            {
                Ok(Ok(b)) => b,
                Ok(Err(HttpParseError::PayloadTooLarge)) => {
                    let body = br#"{"error":"Payload Too Large"}"#;
                    let _ = write_response(
                        &mut write_half,
                        413,
                        "Payload Too Large",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        body,
                    )
                    .await;
                    return;
                }
                Ok(Err(HttpParseError::BadRequest(msg))) => {
                    let body = serde_json::to_vec(&json!({ "error": msg })).unwrap_or_default();
                    let _ = write_response(
                        &mut write_half,
                        400,
                        "Bad Request",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        &body,
                    )
                    .await;
                    return;
                }
                _ => return,
            };

            state.mcp.total_requests.fetch_add(1, Ordering::Relaxed);
            let Some(session_id) = req.query.get("sessionId").cloned() else {
                let body = br#"{"error":"Missing sessionId query parameter"}"#;
                let _ = write_response(
                    &mut write_half,
                    400,
                    "Bad Request",
                    origin_ref,
                    &[("Content-Type", "application/json")],
                    body,
                )
                .await;
                return;
            };
            let tx_opt = sse_sessions.lock().await.get(&session_id).cloned();
            let Some(tx) = tx_opt else {
                let body = br#"{"error":"Unknown or expired SSE sessionId"}"#;
                let _ = write_response(
                    &mut write_half,
                    404,
                    "Not Found",
                    origin_ref,
                    &[("Content-Type", "application/json")],
                    body,
                )
                .await;
                return;
            };

            let parsed: Value = match serde_json::from_slice(&req_body) {
                Ok(v) => v,
                Err(e) => {
                    let err_resp = json_rpc_error(Value::Null, -32700, format!("Parse error: {e}"));
                    let body = serde_json::to_vec(&err_resp).unwrap_or_default();
                    let _ = write_response(
                        &mut write_half,
                        400,
                        "Bad Request",
                        origin_ref,
                        &[("Content-Type", "application/json")],
                        &body,
                    )
                    .await;
                    return;
                }
            };

            let _ = write_response(
                &mut write_half,
                202,
                "Accepted",
                origin_ref,
                &[],
                b"Accepted",
            )
            .await;

            let app_clone = app.clone();
            tokio::spawn(async move {
                if let Some(resp) = handle_jsonrpc_payload(&app_clone, parsed).await
                    && let Ok(text) = serde_json::to_string(&resp)
                {
                    let _ = tx.send(text).await;
                }
            });
        }

        _ => {
            let body = br#"{"error":"Not Found"}"#;
            let _ = write_response(
                &mut write_half,
                404,
                "Not Found",
                origin_ref,
                &[("Content-Type", "application/json")],
                body,
            )
            .await;
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

fn is_authorized(req: &HttpRequestHead, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    if let Some(auth) = req.headers.get("authorization")
        && let Some(token) = auth
            .strip_prefix("Bearer ")
            .or_else(|| auth.strip_prefix("bearer "))
        && constant_time_eq(token.trim().as_bytes(), expected.as_bytes())
    {
        return true;
    }
    if let Some(q_tok) = req.query.get("token")
        && constant_time_eq(q_tok.trim().as_bytes(), expected.as_bytes())
    {
        return true;
    }
    false
}

async fn handle_jsonrpc_payload(app: &tauri::AppHandle, payload: Value) -> Option<Value> {
    match payload {
        Value::Array(items) => {
            if items.is_empty() {
                return Some(json_rpc_error(
                    Value::Null,
                    -32600,
                    "Invalid Request: empty batch",
                ));
            }
            if items.len() > MAX_BATCH_SIZE {
                return Some(json_rpc_error(
                    Value::Null,
                    -32600,
                    format!("Batch size exceeds limit of {MAX_BATCH_SIZE} requests"),
                ));
            }
            let len = items.len();
            let mut set = tokio::task::JoinSet::new();
            for (idx, item) in items.into_iter().enumerate() {
                let app_clone = app.clone();
                set.spawn(async move { (idx, handle_jsonrpc_single(&app_clone, item).await) });
            }
            let mut ordered: Vec<Option<Value>> = vec![None; len];
            let mut failed_count = 0usize;
            while let Some(res) = set.join_next().await {
                match res {
                    Ok((idx, val)) => ordered[idx] = val,
                    Err(_) => failed_count += 1,
                }
            }
            let mut results: Vec<Value> = ordered.into_iter().flatten().collect();
            for _ in 0..failed_count {
                results.push(json_rpc_error(Value::Null, -32603, "Internal error"));
            }
            if results.is_empty() {
                None
            } else {
                Some(Value::Array(results))
            }
        }
        single => handle_jsonrpc_single(app, single).await,
    }
}

async fn handle_jsonrpc_single(app: &tauri::AppHandle, req: Value) -> Option<Value> {
    if !req.is_object() {
        return Some(json_rpc_error(
            Value::Null,
            -32600,
            "Invalid Request: expected JSON object",
        ));
    }
    let id = req.get("id").cloned();
    let method = match req.get("method").and_then(|v| v.as_str()) {
        Some(m) => m,
        None => {
            return Some(json_rpc_error(
                id.unwrap_or(Value::Null),
                -32600,
                "Invalid Request: missing method",
            ));
        }
    };
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // Notifications (no id) do not return a JSON-RPC response.
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap();

    match method {
        "initialize" => {
            let client_ver = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or(PROTOCOL_VERSION);
            let negotiated = match client_ver {
                "2024-11-05" | "2025-03-26" | "2025-06-18" => client_ver,
                _ => PROTOCOL_VERSION,
            };
            Some(json_rpc_ok(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": { "listChanged": false },
                        "resources": { "subscribe": false, "listChanged": false }
                    },
                    "serverInfo": {
                        "name": "serverhub-mcp",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            ))
        }
        "ping" => Some(json_rpc_ok(id, json!({}))),
        "tools/list" => Some(json_rpc_ok(id, tools::list_tools())),
        "tools/call" => {
            let Some(tool_name) = params.get("name").and_then(|v| v.as_str()) else {
                return Some(json_rpc_error(id, -32602, "Missing tool name"));
            };
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let res = tools::call_tool(app, tool_name, args).await;
            Some(json_rpc_ok(id, res))
        }
        "resources/list" => Some(json_rpc_ok(id, tools::list_resources())),
        "resources/read" => {
            let Some(uri) = params.get("uri").and_then(|v| v.as_str()) else {
                return Some(json_rpc_error(id, -32602, "Missing resource uri"));
            };
            match tools::read_resource(app, uri).await {
                Ok(val) => Some(json_rpc_ok(id, val)),
                Err(e) => Some(json_rpc_error(id, -32602, e)),
            }
        }
        "prompts/list" => Some(json_rpc_ok(id, json!({ "prompts": [] }))),
        _ => Some(json_rpc_error(
            id,
            -32601,
            format!("Method not found: {method}"),
        )),
    }
}

fn json_rpc_ok(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn json_rpc_error(id: Value, code: i32, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

async fn write_response(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    status: u16,
    reason: &str,
    allowed_origin: Option<&str>,
    extra_headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n",
        body.len()
    );
    if let Some(origin) = allowed_origin {
        head.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\n\
             Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, Accept\r\n\
             Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n\
             Access-Control-Expose-Headers: Mcp-Session-Id\r\n\
             Vary: Origin\r\n"
        ));
    }
    for (k, v) in extra_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    writer.write_all(head.as_bytes()).await?;
    if !body.is_empty() {
        writer.write_all(body).await?;
    }
    writer.flush().await
}

async fn read_line_limited<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    max_len: usize,
) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if buf.is_empty() {
                return Ok(None);
            }
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            let take = pos + 1;
            if buf.len().saturating_add(take) > max_len {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "HTTP header line too long",
                ));
            }
            buf.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
        let avail_len = available.len();
        if buf.len().saturating_add(avail_len) > max_len {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "HTTP header line too long",
            ));
        }
        buf.extend_from_slice(available);
        reader.consume(avail_len);
    }
}

async fn read_http_head<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
) -> Result<Option<HttpRequestHead>, HttpParseError> {
    let Some(request_line) = read_line_limited(reader, MAX_HEADER_LINE_BYTES)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::InvalidData {
                HttpParseError::BadRequest("HTTP request line too long")
            } else {
                HttpParseError::Io
            }
        })?
    else {
        return Ok(None);
    };
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/") {
        return Err(HttpParseError::BadRequest("Malformed HTTP request line"));
    }
    let method = parts[0].to_uppercase();
    let raw_target = parts[1];
    let (path, query_str) = match raw_target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q)),
        None => (raw_target.to_string(), None),
    };

    let mut query = HashMap::new();
    if let Some(qs) = query_str {
        for pair in qs.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                query.insert(percent_decode(k), percent_decode(v));
            } else if !pair.is_empty() {
                query.insert(percent_decode(pair), String::new());
            }
        }
    }

    const UNIQUE_HEADERS: &[&str] = &[
        "host",
        "origin",
        "authorization",
        "content-length",
        "transfer-encoding",
    ];
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut header_count = 0usize;
    loop {
        let Some(line) = read_line_limited(reader, MAX_HEADER_LINE_BYTES)
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::InvalidData {
                    HttpParseError::BadRequest("HTTP header line too long")
                } else {
                    HttpParseError::Io
                }
            })?
        else {
            break;
        };
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            break;
        }
        header_count += 1;
        if header_count > MAX_HEADERS {
            return Err(HttpParseError::BadRequest("Too many HTTP headers"));
        }
        let Some((raw_k, raw_v)) = trimmed.split_once(':') else {
            return Err(HttpParseError::BadRequest("Malformed HTTP header"));
        };
        // RFC 9112 §5.1: reject whitespace in header field name (including before ':').
        if raw_k.is_empty() || raw_k.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(HttpParseError::BadRequest("Invalid HTTP header name"));
        }
        let key = raw_k.to_ascii_lowercase();
        if UNIQUE_HEADERS.contains(&key.as_str()) && headers.contains_key(&key) {
            return Err(HttpParseError::BadRequest(
                "Duplicate framing or security header",
            ));
        }
        headers.insert(key, raw_v.trim().to_string());
    }

    if headers.contains_key("transfer-encoding") && headers.contains_key("content-length") {
        return Err(HttpParseError::BadRequest(
            "Both Transfer-Encoding and Content-Length present",
        ));
    }

    Ok(Some(HttpRequestHead {
        method,
        path,
        query,
        headers,
    }))
}

async fn read_exact_incremental<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    out: &mut Vec<u8>,
    mut remaining: usize,
) -> Result<(), HttpParseError> {
    let mut chunk_buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let to_read = remaining.min(chunk_buf.len());
        let n = reader
            .read(&mut chunk_buf[..to_read])
            .await
            .map_err(|_| HttpParseError::Io)?;
        if n == 0 {
            return Err(HttpParseError::BadRequest("Unexpected EOF in request body"));
        }
        out.extend_from_slice(&chunk_buf[..n]);
        remaining -= n;
    }
    Ok(())
}

async fn read_http_body<R: AsyncBufReadExt + AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
) -> Result<Vec<u8>, HttpParseError> {
    let mut body = Vec::new();
    let is_chunked = headers
        .get("transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false);

    if is_chunked {
        loop {
            let Some(size_line) = read_line_limited(reader, MAX_HEADER_LINE_BYTES)
                .await
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::InvalidData {
                        HttpParseError::BadRequest("Chunk header line too long")
                    } else {
                        HttpParseError::Io
                    }
                })?
            else {
                return Err(HttpParseError::BadRequest("Unexpected EOF in chunked body"));
            };
            let size_hex = size_line.trim().split(';').next().unwrap_or("").trim();
            if size_hex.is_empty() {
                return Err(HttpParseError::BadRequest("Empty chunk size"));
            }
            let chunk_size = usize::from_str_radix(size_hex, 16)
                .map_err(|_| HttpParseError::BadRequest("Invalid chunk size"))?;
            if chunk_size == 0 {
                // Consume bounded trailing headers/CRLF until empty line.
                let mut trailer_lines = 0usize;
                loop {
                    let Some(trail) = read_line_limited(reader, MAX_HEADER_LINE_BYTES)
                        .await
                        .map_err(|e| {
                            if e.kind() == std::io::ErrorKind::InvalidData {
                                HttpParseError::BadRequest("Chunk trailer line too long")
                            } else {
                                HttpParseError::Io
                            }
                        })?
                    else {
                        break;
                    };
                    if trail.trim_end_matches(&['\r', '\n'][..]).is_empty() {
                        break;
                    }
                    trailer_lines += 1;
                    if trailer_lines > MAX_HEADERS {
                        return Err(HttpParseError::BadRequest("Too many chunk trailer headers"));
                    }
                }
                break;
            }
            let new_len = body
                .len()
                .checked_add(chunk_size)
                .ok_or(HttpParseError::PayloadTooLarge)?;
            if new_len > MAX_BODY_BYTES {
                return Err(HttpParseError::PayloadTooLarge);
            }
            read_exact_incremental(reader, &mut body, chunk_size).await?;
            let mut crlf = [0u8; 2];
            reader
                .read_exact(&mut crlf)
                .await
                .map_err(|_| HttpParseError::BadRequest("Unexpected EOF after chunk"))?;
            if crlf != *b"\r\n" {
                return Err(HttpParseError::BadRequest("Invalid chunk terminator"));
            }
        }
    } else if let Some(len_str) = headers.get("content-length") {
        let len = len_str
            .trim()
            .parse::<usize>()
            .map_err(|_| HttpParseError::BadRequest("Invalid Content-Length"))?;
        if len > MAX_BODY_BYTES {
            return Err(HttpParseError::PayloadTooLarge);
        }
        if len > 0 {
            read_exact_incremental(reader, &mut body, len).await?;
        }
    }

    Ok(body)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((h << 4) | l);
            i += 3;
            continue;
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_header_blocks_dns_rebinding_on_loopback() {
        assert!(is_allowed_host(Some("127.0.0.1:17890"), "127.0.0.1"));
        assert!(is_allowed_host(Some("localhost:17890"), "127.0.0.1"));
        assert!(is_allowed_host(Some("[::1]:17890"), "127.0.0.1"));
        assert!(!is_allowed_host(
            Some("evil.example.com:17890"),
            "127.0.0.1"
        ));
        assert!(!is_allowed_host(Some("127.0.0.1.evil.com"), "127.0.0.1"));
        assert!(!is_allowed_host(Some("localhost:abc"), "127.0.0.1"));
        assert!(is_allowed_host(Some("192.168.1.50:17890"), "192.168.1.50"));
        assert!(is_allowed_host(Some("nas.lan:17890"), "0.0.0.0"));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"sh_mcp_abc", b"sh_mcp_abc"));
        assert!(!constant_time_eq(b"sh_mcp_abc", b"sh_mcp_abd"));
        assert!(!constant_time_eq(b"sh_mcp_abc", b"sh_mcp_ab"));
    }

    #[test]
    fn origin_validation_blocks_spoofed_localhost_origins() {
        assert!(is_allowed_origin("http://localhost:5173"));
        assert!(is_allowed_origin("https://127.0.0.1:8443"));
        assert!(is_allowed_origin("http://[::1]:17890"));
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(!is_allowed_origin("http://localhost:80@evil.com"));
        assert!(!is_allowed_origin("http://localhost:99999"));
        assert!(!is_allowed_origin("http://localhost:5173/evil"));
        assert!(!is_allowed_origin("https://evil.com"));
        assert!(!is_allowed_origin("http://127.0.0.1:abc"));
    }
}
