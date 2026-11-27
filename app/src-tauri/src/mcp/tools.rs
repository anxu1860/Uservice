use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use serverhub_core::{AuthMethod, BillingCycle, Protocol, Server, ServerCost, ServerStore};
use serverhub_monitor::{PROBE_CMD, RawSnapshot, ServerStats};
use serverhub_ssh::{Auth, ConnectConfig, ExecOutput, ShellEvent, SshSession};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::mcp::{McpShellSession, PooledSshEntry, save_config_to_disk};
use crate::{
    AppState, icmp_ping_ms, load_known_hosts, map_auth_priority, now_unix_secs, persist_secret,
    resolve_jump_configs, resolve_secret, resolve_server_auth,
};

const MAX_TRANSFER_BYTES: usize = 100 * 1024 * 1024; // 100 MiB
const MAX_READ_BYTES: usize = 2 * 1024 * 1024; // 2 MiB
const MAX_SHELL_BUFFER_BYTES: usize = 512 * 1024; // 512 KiB

static CACHED_TOOLS_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    let mut tools = Vec::new();
    tools.extend(workspace_tool_schemas());
    tools.extend(ssh_tool_schemas());
    tools.extend(remote_file_tool_schemas());
    tools.extend(file_transfer_tool_schemas());
    json!({ "tools": tools })
});

pub fn list_tools() -> Value {
    CACHED_TOOLS_SCHEMA.clone()
}

fn workspace_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "workspace_get_settings",
            "description": "Get ServerHub workspace settings, MCP capability permissions, server count, and available groups.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workspace_update_settings",
            "description": "Update ServerHub workspace settings such as default local workspace directory, default server, default group, or default remote directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "local_workspace_dir": { "type": "string", "description": "Default local directory for resolving relative local paths in file transfers." },
                    "default_server_id": { "type": ["string", "null"], "description": "Default server ID or name used when server_id is omitted. Pass empty string or null to clear." },
                    "default_group": { "type": ["string", "null"], "description": "Default server group. Pass empty string or null to clear." },
                    "default_remote_dir": { "type": "string", "description": "Default remote working directory (e.g. '~' or '/opt/app')." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "servers_list",
            "description": "List servers configured in ServerHub workspace. Never returns passwords or secrets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "group": { "type": "string", "description": "Filter by exact group name." },
                    "protocol": { "type": "string", "enum": ["ssh", "vnc", "rdp"], "description": "Filter by protocol." },
                    "tag": { "type": "string", "description": "Filter by tag." },
                    "search": { "type": "string", "description": "Case-insensitive substring search across name, host, username, group, and tags." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "server_get",
            "description": "Get non-sensitive details of a single server by server_id or name.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact server name." }
                },
                "required": ["server_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "server_upsert",
            "description": "Create or update a server in ServerHub workspace.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Existing server UUID to update. Omit to create a new server." },
                    "name": { "type": "string", "description": "Display name of the server." },
                    "host": { "type": "string", "description": "Hostname or IP address." },
                    "port": { "type": "integer", "minimum": 1, "maximum": 65535, "description": "Port number (default 22 for SSH)." },
                    "username": { "type": "string", "description": "Login username (default 'root')." },
                    "protocol": { "type": "string", "enum": ["ssh", "vnc", "rdp"], "description": "Connection protocol (default 'ssh')." },
                    "auth_type": { "type": "string", "enum": ["password", "key"], "description": "Authentication method (default 'key' if key_path provided, else 'password')." },
                    "key_path": { "type": "string", "description": "SSH private key path when auth_type is 'key' (e.g. '~/.ssh/id_ed25519')." },
                    "password": { "type": "string", "description": "Optional password or key passphrase to store encrypted in ServerHub vault." },
                    "group": { "type": ["string", "null"], "description": "Server group name." },
                    "provider": { "type": ["string", "null"], "description": "Cloud provider identifier." },
                    "region": { "type": ["string", "null"], "description": "Geographic region label." },
                    "os": { "type": ["string", "null"], "description": "Operating system description." },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Tags list." }
                },
                "required": ["name", "host"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "server_delete",
            "description": "Delete a server from ServerHub workspace by UUID or exact name.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name." }
                },
                "required": ["server_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "server_ping",
            "description": "Measure ICMP ping latency and optionally test SSH TCP/auth connectivity for a server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or name (defaults to workspace default_server_id)." },
                    "test_ssh": { "type": "boolean", "description": "Also test full SSH login handshake (default false)." }
                },
                "additionalProperties": false
            }
        }),
    ]
}

fn ssh_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "ssh_exec",
            "description": "Execute a shell command on a remote SSH server and return stdout, stderr, and exit_code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id if omitted." },
                    "command": { "type": "string", "description": "Shell command to execute on the remote host." },
                    "cwd": { "type": "string", "description": "Optional remote working directory to cd into before running the command." },
                    "timeout_secs": { "type": "integer", "minimum": 1, "maximum": 300, "description": "Command timeout in seconds (default 30, max 300)." }
                },
                "required": ["command"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ssh_session_open",
            "description": "Open a persistent interactive PTY SSH shell session on a server for stateful multi-step terminal work.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "cols": { "type": "integer", "minimum": 20, "maximum": 400, "description": "Terminal columns (default 120)." },
                    "rows": { "type": "integer", "minimum": 10, "maximum": 200, "description": "Terminal rows (default 40)." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ssh_session_write",
            "description": "Write input/command to an open interactive SSH session and return output produced after waiting.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session ID returned by ssh_session_open." },
                    "input": { "type": "string", "description": "Text to send to the shell." },
                    "append_newline": { "type": "boolean", "description": "Append newline '\\n' after input (default true)." },
                    "wait_ms": { "type": "integer", "minimum": 50, "maximum": 10000, "description": "Milliseconds to wait for output before reading buffer (default 600)." }
                },
                "required": ["session_id", "input"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ssh_session_read",
            "description": "Read and drain buffered output from an open interactive SSH session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session ID returned by ssh_session_open." },
                    "wait_ms": { "type": "integer", "minimum": 0, "maximum": 10000, "description": "Optional milliseconds to wait before draining buffer (default 100)." }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ssh_session_close",
            "description": "Close an open interactive SSH session.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session ID to close." }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "ssh_sessions_list",
            "description": "List all currently open MCP interactive SSH sessions.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }),
        json!({
            "name": "server_stats",
            "description": "Collect real-time system health metrics (CPU, memory, disk, load, uptime, OS) from a remote Linux/Unix SSH server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." }
                },
                "additionalProperties": false
            }
        }),
    ]
}

fn remote_file_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "remote_list_dir",
            "description": "List files and directories at a remote path on an SSH server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote directory path (default: workspace default_remote_dir or '~')." },
                    "show_hidden": { "type": "boolean", "description": "Include dotfiles (default true)." }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_read_file",
            "description": "Read text contents of a remote file, with optional line range pagination.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote file path." },
                    "start_line": { "type": "integer", "minimum": 1, "description": "Optional 1-based start line." },
                    "end_line": { "type": "integer", "minimum": 1, "description": "Optional 1-based inclusive end line." },
                    "max_bytes": { "type": "integer", "minimum": 1, "maximum": 2097152, "description": "Maximum bytes to return (default 262144)." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_write_file",
            "description": "Write or append UTF-8 text content to a remote file on an SSH server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote destination file path." },
                    "content": { "type": "string", "description": "Text content to write." },
                    "mode": { "type": "string", "enum": ["overwrite", "append"], "description": "Write mode (default 'overwrite')." },
                    "create_dirs": { "type": "boolean", "description": "Create parent directories if they do not exist (default true)." },
                    "chmod": { "type": "string", "description": "Optional POSIX permission mode, e.g. '644' or '755'." }
                },
                "required": ["path", "content"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_stat",
            "description": "Inspect metadata (existence, type, size, permissions, owner, modified time) of a remote file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote path to inspect." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_mkdir",
            "description": "Create a directory on a remote SSH server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote directory path to create." },
                    "recursive": { "type": "boolean", "description": "Create parent directories as needed (default true)." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_delete",
            "description": "Delete a remote file or directory on an SSH server.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote file or directory path to delete." },
                    "recursive": { "type": "boolean", "description": "Delete directories recursively (default false)." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_move",
            "description": "Move or rename a remote file or directory.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "src": { "type": "string", "description": "Source remote path." },
                    "dst": { "type": "string", "description": "Destination remote path." }
                },
                "required": ["src", "dst"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "remote_search",
            "description": "Search remote files by filename pattern (find) or text content (grep).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "path": { "type": "string", "description": "Remote root directory to search (default '~')." },
                    "mode": { "type": "string", "enum": ["name", "content"], "description": "Search by filename ('name') or file content ('content', default)." },
                    "pattern": { "type": "string", "description": "Filename glob (for 'name') or grep pattern (for 'content')." },
                    "max_results": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum matching lines/files to return (default 100)." }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }
        }),
    ]
}

fn file_transfer_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "file_upload",
            "description": "Upload a local file (binary-safe) to a remote SSH server path, returning bytes transferred and SHA-256 checksum.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "local_path": { "type": "string", "description": "Local source file path (relative paths resolve against workspace local_workspace_dir)." },
                    "remote_path": { "type": "string", "description": "Remote destination file path." },
                    "create_dirs": { "type": "boolean", "description": "Create remote parent directories if needed (default true)." },
                    "chmod": { "type": "string", "description": "Optional POSIX permission mode after upload, e.g. '644' or '755'." }
                },
                "required": ["local_path", "remote_path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "file_download",
            "description": "Download a remote file (binary-safe) from an SSH server to a local file path, returning bytes transferred and SHA-256 checksum.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "server_id": { "type": "string", "description": "Server UUID or exact name. Falls back to workspace default_server_id." },
                    "remote_path": { "type": "string", "description": "Remote source file path." },
                    "local_path": { "type": "string", "description": "Local destination file path (relative paths resolve against workspace local_workspace_dir)." },
                    "create_dirs": { "type": "boolean", "description": "Create local parent directories if needed (default true)." }
                },
                "required": ["remote_path", "local_path"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "file_transfer_between_servers",
            "description": "Transfer a file (binary-safe) directly from one ServerHub SSH server to another.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source_server_id": { "type": "string", "description": "Source server UUID or exact name." },
                    "source_path": { "type": "string", "description": "Source file path on source server." },
                    "dest_server_id": { "type": "string", "description": "Destination server UUID or exact name." },
                    "dest_path": { "type": "string", "description": "Destination file path on destination server." },
                    "create_dirs": { "type": "boolean", "description": "Create parent directories on destination server (default true)." },
                    "chmod": { "type": "string", "description": "Optional POSIX permission mode on destination file." }
                },
                "required": ["source_server_id", "source_path", "dest_server_id", "dest_path"],
                "additionalProperties": false
            }
        }),
    ]
}

static CACHED_RESOURCES_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "resources": [
            {
                "uri": "serverhub://workspace/settings",
                "name": "Workspace Settings",
                "description": "Current ServerHub MCP workspace configuration and capability flags",
                "mimeType": "application/json"
            },
            {
                "uri": "serverhub://servers",
                "name": "Configured Servers",
                "description": "Non-sensitive list of all servers managed in ServerHub",
                "mimeType": "application/json"
            }
        ]
    })
});

pub fn list_resources() -> Value {
    CACHED_RESOURCES_SCHEMA.clone()
}

pub async fn read_resource(app: &tauri::AppHandle, uri: &str) -> Result<Value, String> {
    let state = app.state::<AppState>();
    match uri {
        "serverhub://workspace/settings" => {
            let cfg = state.mcp.config.read().await.clone();
            let text = serde_json::to_string_pretty(&json!({
                "workspace": cfg.workspace,
                "permissions": {
                    "allow_workspace_write": cfg.allow_workspace_write,
                    "allow_ssh_exec": cfg.allow_ssh_exec,
                    "allow_remote_files": cfg.allow_remote_files,
                    "allow_file_transfer": cfg.allow_file_transfer,
                }
            }))
            .map_err(|e| e.to_string())?;
            Ok(json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": text
                }]
            }))
        }
        "serverhub://servers" => {
            let servers = load_servers(app, &state).await?;
            let text = serde_json::to_string_pretty(&servers).map_err(|e| e.to_string())?;
            Ok(json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": text
                }]
            }))
        }
        _ => Err(format!("未知资源 URI: {uri}")),
    }
}

pub async fn call_tool(app: &tauri::AppHandle, name: &str, args: Value) -> Value {
    let state = app.state::<AppState>();
    let start = Instant::now();
    let summary = summarize_args(name, &args);
    let result = dispatch_tool(app, &state, name, args).await;
    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(val) => {
            state.mcp.record_log(name, summary, true, duration_ms).await;
            let text = serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string());
            json!({
                "content": [{ "type": "text", "text": text }],
                "isError": false
            })
        }
        Err(err) => {
            state
                .mcp
                .record_log(name, format!("{summary} -> {err}"), false, duration_ms)
                .await;
            json!({
                "content": [{ "type": "text", "text": err }],
                "isError": true
            })
        }
    }
}

fn summarize_args(name: &str, args: &Value) -> String {
    let srv = args
        .get("server_id")
        .or_else(|| args.get("source_server_id"))
        .and_then(|v| v.as_str());
    let detail = match name {
        "ssh_exec" => args.get("command").and_then(|v| v.as_str()),
        "remote_list_dir" | "remote_read_file" | "remote_write_file" | "remote_stat"
        | "remote_mkdir" | "remote_delete" => args.get("path").and_then(|v| v.as_str()),
        "remote_move" => args.get("src").and_then(|v| v.as_str()),
        "file_upload" | "file_download" => args.get("remote_path").and_then(|v| v.as_str()),
        "file_transfer_between_servers" => args.get("source_path").and_then(|v| v.as_str()),
        "server_upsert" => args.get("name").and_then(|v| v.as_str()),
        _ => None,
    };
    let mut parts = Vec::new();
    if let Some(s) = srv {
        parts.push(format!("server={s}"));
    }
    if let Some(d) = detail {
        let truncated: String = d.chars().take(80).collect();
        parts.push(truncated);
    }
    if parts.is_empty() {
        "ok".to_string()
    } else {
        parts.join(" · ")
    }
}

async fn dispatch_tool(
    app: &tauri::AppHandle,
    state: &AppState,
    name: &str,
    args: Value,
) -> Result<Value, String> {
    let cfg = state.mcp.config.read().await.clone();

    match name {
        // --- Workspace & Servers ---
        "workspace_get_settings" => tool_workspace_get_settings(app, state).await,
        "workspace_update_settings" => {
            if !cfg.allow_workspace_write {
                return Err("MCP 配置已禁止修改工作区设置 (allow_workspace_write=false)".into());
            }
            tool_workspace_update_settings(app, state, args).await
        }
        "servers_list" => tool_servers_list(app, state, args).await,
        "server_get" => tool_server_get(app, state, args).await,
        "server_upsert" => {
            if !cfg.allow_workspace_write {
                return Err("MCP 配置已禁止修改服务器列表 (allow_workspace_write=false)".into());
            }
            tool_server_upsert(app, state, args).await
        }
        "server_delete" => {
            if !cfg.allow_workspace_write {
                return Err("MCP 配置已禁止删除服务器 (allow_workspace_write=false)".into());
            }
            tool_server_delete(app, state, args).await
        }
        "server_ping" => tool_server_ping(app, state, args).await,

        // --- SSH Operations ---
        "ssh_exec" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 命令执行 (allow_ssh_exec=false)".into());
            }
            tool_ssh_exec(app, state, args).await
        }
        "ssh_session_open" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 会话操作 (allow_ssh_exec=false)".into());
            }
            tool_ssh_session_open(app, state, args).await
        }
        "ssh_session_write" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 会话操作 (allow_ssh_exec=false)".into());
            }
            tool_ssh_session_write(state, args).await
        }
        "ssh_session_read" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 会话操作 (allow_ssh_exec=false)".into());
            }
            tool_ssh_session_read(state, args).await
        }
        "ssh_session_close" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 会话操作 (allow_ssh_exec=false)".into());
            }
            tool_ssh_session_close(state, args).await
        }
        "ssh_sessions_list" => tool_ssh_sessions_list(state).await,
        "server_stats" => {
            if !cfg.allow_ssh_exec {
                return Err("MCP 配置已禁止 SSH 采集操作 (allow_ssh_exec=false)".into());
            }
            tool_server_stats(app, state, args).await
        }

        // --- Remote File Operations ---
        "remote_list_dir" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_list_dir(app, state, args).await
        }
        "remote_read_file" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_read_file(app, state, args).await
        }
        "remote_write_file" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_write_file(app, state, args).await
        }
        "remote_stat" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_stat(app, state, args).await
        }
        "remote_mkdir" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_mkdir(app, state, args).await
        }
        "remote_delete" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_delete(app, state, args).await
        }
        "remote_move" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_move(app, state, args).await
        }
        "remote_search" => {
            if !cfg.allow_remote_files {
                return Err("MCP 配置已禁止远程文件操作 (allow_remote_files=false)".into());
            }
            tool_remote_search(app, state, args).await
        }

        // --- File Transfer ---
        "file_upload" => {
            if !cfg.allow_file_transfer {
                return Err("MCP 配置已禁止文件传输 (allow_file_transfer=false)".into());
            }
            tool_file_upload(app, state, args).await
        }
        "file_download" => {
            if !cfg.allow_file_transfer {
                return Err("MCP 配置已禁止文件传输 (allow_file_transfer=false)".into());
            }
            tool_file_download(app, state, args).await
        }
        "file_transfer_between_servers" => {
            if !cfg.allow_file_transfer {
                return Err("MCP 配置已禁止文件传输 (allow_file_transfer=false)".into());
            }
            tool_file_transfer_between_servers(app, state, args).await
        }

        _ => Err(format!("未知 MCP 工具: {name}")),
    }
}

// ============================================================================
// Helpers: Servers, SSH Pool, Shell Escaping, Local Paths
// ============================================================================

fn server_store(app: &tauri::AppHandle) -> Result<ServerStore, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
    Ok(ServerStore::new(data_dir.join("servers.json")))
}

async fn load_servers(app: &tauri::AppHandle, state: &AppState) -> Result<Vec<Server>, String> {
    let _guard = state.store_lock.read().await;
    server_store(app)?.load().map_err(|e| e.to_string())
}

async fn resolve_server(
    app: &tauri::AppHandle,
    state: &AppState,
    server_id_arg: Option<&str>,
) -> Result<Server, String> {
    let target = match server_id_arg.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => {
            let cfg = state.mcp.config.read().await;
            cfg.workspace
                .default_server_id
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    "未指定 server_id，且工作区未设置默认服务器 (default_server_id)".to_string()
                })?
        }
    };

    let servers = load_servers(app, state).await?;
    if let Ok(uuid) = Uuid::parse_str(&target)
        && let Some(s) = servers.iter().find(|s| s.id == uuid)
    {
        return Ok(s.clone());
    }
    if let Some(s) = servers
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(&target))
    {
        return Ok(s.clone());
    }
    Err(format!("找不到服务器: {target}"))
}

async fn connect_ssh_for_server(
    app: &tauri::AppHandle,
    state: &AppState,
    server: &Server,
) -> Result<SshSession, String> {
    if server.protocol != Protocol::Ssh {
        return Err(format!(
            "服务器 '{}' 协议为 {:?}，不支持 SSH 操作",
            server.name, server.protocol
        ));
    }

    let known_hosts = load_known_hosts(app, state).map_err(|e| e.message)?;
    let auth = resolve_server_auth(app, state, server)
        .await
        .map_err(|e| e.message)?;

    let auto_accept = state.mcp.config.read().await.auto_accept_unknown_host_keys;

    let jump_hosts = resolve_jump_configs(
        app,
        state,
        Some(server.id),
        &server.jump_hosts,
        None,
        auto_accept,
    )
    .await
    .map_err(|e| e.message)?;

    let username = match &auth {
        Auth::Credential(c) => c
            .username
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&server.username)
            .to_string(),
        _ => server.username.clone(),
    };

    let connect_cfg = ConnectConfig {
        host: server.host.clone(),
        port: server.port,
        username,
        auth,
        auth_priority: map_auth_priority(&server.auth_priority),
        timeout_secs: server.timeout_secs,
        keepalive_secs: server.keepalive_secs,
        jump_hosts,
        term_type: server.term_type.clone(),
        accept_host_key: None,
        auto_trust_unknown_host_key: auto_accept,
    };

    let _permit = tokio::time::timeout(Duration::from_secs(20), state.connect_semaphore.acquire())
        .await
        .map_err(|_| "并发 SSH 连接排队超时，请稍后重试".to_string())?
        .map_err(|_| "SSH 连接信号量异常".to_string())?;

    SshSession::connect(connect_cfg, known_hosts)
        .await
        .map_err(|e| e.to_string())
}

fn is_timeout_ssh_error(err: &serverhub_ssh::SshError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("timed out") || msg.contains("timeout")
}

/// Execute a command on a server using a pooled SSH connection, with lock-free
fn is_retryable_transport_error(err: &serverhub_ssh::SshError) -> bool {
    if is_timeout_ssh_error(err) {
        return false;
    }
    matches!(err, serverhub_ssh::SshError::Channel(_))
}

/// channel multiplexing across concurrent callers and transparent one-time reconnect
/// if an idle pooled session was closed by the remote host (only for idempotent ops
/// and never on command timeout).
async fn pooled_exec_raw(
    app: &tauri::AppHandle,
    state: &AppState,
    server: &Server,
    cmd: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
    idempotent: bool,
) -> Result<ExecOutput, String> {
    let key = server.id.to_string();
    let slot = {
        if let Some(existing) = state.mcp.ssh_pool.read().await.get(&key) {
            Arc::clone(existing)
        } else {
            let mut pool = state.mcp.ssh_pool.write().await;
            Arc::clone(
                pool.entry(key)
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        }
    };

    // Acquire per-server slot lock only long enough to obtain/create the shared Arc<SshSession>.
    // Release before exec_raw so concurrent calls multiplex over the same SSH connection!
    let (session, reused) = {
        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_mut() {
            entry.last_used = Instant::now();
            (Arc::clone(&entry.session), true)
        } else {
            let new_sess = Arc::new(connect_ssh_for_server(app, state, server).await?);
            *guard = Some(PooledSshEntry {
                session: Arc::clone(&new_sess),
                last_used: Instant::now(),
            });
            (new_sess, false)
        }
    };

    match session.exec_raw(cmd, stdin, timeout).await {
        Ok(out) => Ok(out),
        Err(first_err) if reused && idempotent && is_retryable_transport_error(&first_err) => {
            // Reconnect once if nobody else has already replaced this stale session.
            let fresh_session = {
                let mut guard = slot.lock().await;
                if let Some(cur) = guard.as_mut() {
                    if !Arc::ptr_eq(&cur.session, &session) {
                        cur.last_used = Instant::now();
                        Arc::clone(&cur.session)
                    } else {
                        if let Some(old) = guard.take() {
                            tokio::spawn(async move {
                                let _ = old.session.close().await;
                            });
                        }
                        let new_sess = Arc::new(connect_ssh_for_server(app, state, server).await?);
                        *guard = Some(PooledSshEntry {
                            session: Arc::clone(&new_sess),
                            last_used: Instant::now(),
                        });
                        new_sess
                    }
                } else {
                    let new_sess = Arc::new(connect_ssh_for_server(app, state, server).await?);
                    *guard = Some(PooledSshEntry {
                        session: Arc::clone(&new_sess),
                        last_used: Instant::now(),
                    });
                    new_sess
                }
            };

            match fresh_session.exec_raw(cmd, stdin, timeout).await {
                Ok(out) => Ok(out),
                Err(e) => {
                    if !is_timeout_ssh_error(&e) {
                        let mut guard = slot.lock().await;
                        if let Some(cur) = guard.as_ref()
                            && Arc::ptr_eq(&cur.session, &fresh_session)
                            && let Some(old) = guard.take()
                        {
                            tokio::spawn(async move {
                                let _ = old.session.close().await;
                            });
                        }
                    }
                    Err(format!("SSH 执行失败 ({first_err}); 重连后仍失败: {e}"))
                }
            }
        }
        Err(e) => {
            if !is_timeout_ssh_error(&e) {
                let mut guard = slot.lock().await;
                if let Some(cur) = guard.as_ref()
                    && Arc::ptr_eq(&cur.session, &session)
                    && let Some(old) = guard.take()
                {
                    tokio::spawn(async move {
                        let _ = old.session.close().await;
                    });
                }
            }
            Err(e.to_string())
        }
    }
}

fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn remote_path_expr(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "~" {
        "\"$HOME\"".to_string()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        format!("\"$HOME\"/{}", shell_quote(rest))
    } else {
        shell_quote(trimmed)
    }
}

fn expand_local_tilde(path: &str) -> PathBuf {
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

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonicalize_best_effort(path: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(path) {
        return c;
    }
    let mut ancestor = path;
    let mut tail = Vec::new();
    while std::fs::symlink_metadata(ancestor).is_err() {
        if let Some(name) = ancestor.file_name() {
            tail.push(name.to_os_string());
        }
        match ancestor.parent() {
            Some(p) if !p.as_os_str().is_empty() => ancestor = p,
            _ => break,
        }
    }
    let mut base = std::fs::canonicalize(ancestor).unwrap_or_else(|_| normalize_lexical(ancestor));
    for seg in tail.into_iter().rev() {
        base.push(seg);
    }
    normalize_lexical(&base)
}

fn resolve_and_validate_local_path(
    raw_path: &str,
    workspace_dir: &str,
    allowed_roots: &[String],
    app_data_dir: Option<&Path>,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let expanded = expand_local_tilde(raw_path);
    let resolved = if expanded.is_absolute() {
        expanded
    } else {
        let base = if !workspace_dir.trim().is_empty() {
            expand_local_tilde(workspace_dir)
        } else {
            std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("."))
        };
        base.join(expanded)
    };

    let check_path = if must_exist {
        std::fs::canonicalize(&resolved)
            .map_err(|e| format!("本地路径 '{}' 无法访问: {e}", resolved.display()))?
    } else {
        // Refuse writing directly through a symlink (including dangling symlinks).
        if let Ok(meta) = std::fs::symlink_metadata(&resolved)
            && meta.file_type().is_symlink()
        {
            return Err(format!("拒绝写入符号链接路径 '{}'", resolved.display()));
        }
        // Walk up to the nearest path entry visible via symlink_metadata (detects dangling symlinks).
        let mut ancestor = resolved.as_path();
        let mut tail = Vec::new();
        while std::fs::symlink_metadata(ancestor).is_err() {
            if let Some(name) = ancestor.file_name() {
                tail.push(name.to_os_string());
            }
            match ancestor.parent() {
                Some(p) if !p.as_os_str().is_empty() => ancestor = p,
                _ => break,
            }
        }
        if let Ok(meta) = std::fs::symlink_metadata(ancestor)
            && meta.file_type().is_symlink()
            && std::fs::canonicalize(ancestor).is_err()
        {
            return Err(format!("路径包含悬空符号链接 '{}'", ancestor.display()));
        }
        let mut base = std::fs::canonicalize(ancestor)
            .map_err(|e| format!("无法解析本地父目录 '{}': {e}", ancestor.display()))?;
        for seg in tail.into_iter().rev() {
            base.push(seg);
        }
        normalize_lexical(&base)
    };

    // Always block access to ServerHub's own application data directory (vault.key, secrets.db, configs).
    if let Some(data_dir) = app_data_dir {
        let data_canon = canonicalize_best_effort(data_dir);
        if check_path.starts_with(&data_canon) {
            return Err("安全策略限制：禁止通过 MCP 访问 ServerHub 内部应用数据目录".to_string());
        }
    }

    if !allowed_roots.is_empty() {
        let mut permitted = false;
        for root in allowed_roots {
            let root_expanded = expand_local_tilde(root);
            let root_canon = canonicalize_best_effort(&root_expanded);
            if check_path.starts_with(&root_canon) {
                permitted = true;
                break;
            }
        }
        if !permitted {
            return Err(format!(
                "本地路径 '{}' 不在允许的工作区根目录 (allowed_local_roots) 内",
                check_path.display()
            ));
        }
    }

    Ok(check_path)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn validate_chmod(mode: &str) -> Result<&str, String> {
    let m = mode.trim();
    if m.is_empty() || m.len() > 4 || !m.chars().all(|c| ('0'..='7').contains(&c)) {
        return Err(format!(
            "无效的 chmod 权限模式: '{mode}' (应为八进制数字，如 644 或 755)"
        ));
    }
    Ok(m)
}

// ============================================================================
// Tool Implementations: Workspace & Servers
// ============================================================================

async fn tool_workspace_get_settings(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<Value, String> {
    let cfg = state.mcp.config.read().await.clone();
    let servers = load_servers(app, state).await?;
    let mut groups: Vec<String> = servers
        .iter()
        .filter_map(|s| s.group.as_ref().map(|g| g.trim().to_string()))
        .filter(|g| !g.is_empty())
        .collect();
    groups.sort();
    groups.dedup();

    Ok(json!({
        "workspace": cfg.workspace,
        "permissions": {
            "allow_workspace_write": cfg.allow_workspace_write,
            "allow_ssh_exec": cfg.allow_ssh_exec,
            "allow_remote_files": cfg.allow_remote_files,
            "allow_file_transfer": cfg.allow_file_transfer,
            "auto_accept_unknown_host_keys": cfg.auto_accept_unknown_host_keys,
        },
        "server_count": servers.len(),
        "groups": groups,
    }))
}

async fn tool_workspace_update_settings(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    if args.get("allowed_local_roots").is_some() {
        return Err(
            "安全策略限制：allowed_local_roots 仅允许在本地桌面端设置页修改，禁止通过 MCP 远程修改"
                .to_string(),
        );
    }
    if args.get("allow_file_transfer").is_some() {
        return Err(
            "安全策略限制：allow_file_transfer 仅允许在本地桌面端设置页修改，禁止通过 MCP 远程修改"
                .to_string(),
        );
    }

    let mut cfg = state.mcp.config.write().await;
    if let Some(dir) = args.get("local_workspace_dir").and_then(|v| v.as_str()) {
        cfg.workspace.local_workspace_dir = dir.trim().to_string();
    }
    if let Some(v) = args.get("default_server_id") {
        if v.is_null() {
            cfg.workspace.default_server_id = None;
        } else if let Some(s) = v.as_str() {
            let trimmed = s.trim();
            cfg.workspace.default_server_id = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
    }
    if let Some(v) = args.get("default_group") {
        if v.is_null() {
            cfg.workspace.default_group = None;
        } else if let Some(s) = v.as_str() {
            let trimmed = s.trim();
            cfg.workspace.default_group = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        }
    }
    if let Some(dir) = args.get("default_remote_dir").and_then(|v| v.as_str()) {
        let trimmed = dir.trim();
        cfg.workspace.default_remote_dir = if trimmed.is_empty() {
            "~".to_string()
        } else {
            trimmed.to_string()
        };
    }

    save_config_to_disk(app, &cfg)?;
    let workspace = cfg.workspace.clone();
    drop(cfg);

    let _ = app.emit("mcp:config-changed", ());
    Ok(json!({ "updated": true, "workspace": workspace }))
}

async fn tool_servers_list(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let mut servers = load_servers(app, state).await?;
    if let Some(group) = args
        .get("group")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        servers.retain(|s| s.group.as_deref() == Some(group));
    }
    if let Some(proto) = args.get("protocol").and_then(|v| v.as_str()) {
        let target = match proto {
            "ssh" => Some(Protocol::Ssh),
            "vnc" => Some(Protocol::Vnc),
            "rdp" => Some(Protocol::Rdp),
            _ => None,
        };
        if let Some(p) = target {
            servers.retain(|s| s.protocol == p);
        }
    }
    if let Some(tag) = args
        .get("tag")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        servers.retain(|s| s.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)));
    }
    if let Some(q) = args
        .get("search")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    {
        servers.retain(|s| {
            s.name.to_lowercase().contains(&q)
                || s.host.to_lowercase().contains(&q)
                || s.username.to_lowercase().contains(&q)
                || s.group.as_deref().unwrap_or("").to_lowercase().contains(&q)
                || s.tags.iter().any(|t| t.to_lowercase().contains(&q))
        });
    }

    Ok(json!({
        "count": servers.len(),
        "servers": servers,
    }))
}

async fn tool_server_get(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let id = args
        .get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 server_id".to_string())?;
    let server = resolve_server(app, state, Some(id)).await?;
    let has_saved_secret = resolve_secret(app, state, &server.id.to_string())
        .await
        .is_some();
    Ok(json!({
        "server": server,
        "has_saved_secret": has_saved_secret,
    }))
}

async fn tool_server_upsert(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少必需参数 name".to_string())?
        .to_string();
    let host = args
        .get("host")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少必需参数 host".to_string())?
        .to_string();
    if !crate::is_valid_ping_host(&host) || host.chars().any(|c| matches!(c, '@' | '?' | '#' | '%'))
    {
        return Err(format!("无效的主机地址: '{host}'"));
    }

    let explicit_port = match args.get("port") {
        Some(v) => {
            let p = v
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .filter(|&p| p >= 1)
                .ok_or_else(|| "端口号必须在 1-65535 之间".to_string())?;
            Some(p)
        }
        None => None,
    };

    let existing_id = args
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (id, is_update_req) = match existing_id {
        Some(raw) => (
            Uuid::parse_str(raw).map_err(|e| format!("无效服务器 UUID: {e}"))?,
            true,
        ),
        None => (Uuid::new_v4(), false),
    };

    let supplied_password = args
        .get("password")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let existing_has_vault_secret = if is_update_req {
        resolve_secret(app, state, &id.to_string()).await.is_some()
    } else {
        false
    };

    let opt_str = |key: &str| -> Option<String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let tags = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let saved_server = {
        let _guard = state.store_lock.write().await;
        let store = server_store(app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        let existing = list.iter().find(|s| s.id == id).cloned();
        if is_update_req && existing.is_none() {
            return Err(format!("要更新的服务器 ID 不存在: {id}"));
        }
        if list
            .iter()
            .any(|s| s.id != id && s.name.eq_ignore_ascii_case(&name))
        {
            return Err(format!("已存在同名服务器 '{name}'，请使用唯一名称"));
        }

        let protocol_arg = args.get("protocol").and_then(|v| v.as_str());
        let protocol = match protocol_arg {
            Some("vnc") => Protocol::Vnc,
            Some("rdp") => Protocol::Rdp,
            Some("ssh") => Protocol::Ssh,
            Some(other) => return Err(format!("不支持的协议类型: '{other}'")),
            None => existing
                .as_ref()
                .map(|e| e.protocol)
                .unwrap_or(Protocol::Ssh),
        };
        let default_port = match protocol {
            Protocol::Ssh => 22,
            Protocol::Vnc => 5900,
            Protocol::Rdp => 3389,
        };
        let port = explicit_port.unwrap_or_else(|| {
            if protocol_arg.is_none() {
                existing.as_ref().map(|e| e.port).unwrap_or(default_port)
            } else {
                default_port
            }
        });
        let username = args
            .get("username")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                existing
                    .as_ref()
                    .map(|e| e.username.clone())
                    .unwrap_or_else(|| "root".to_string())
            });

        // Prevent vault credential exfiltration by retargeting an existing server to an attacker host.
        if let Some(ref old) = existing {
            let endpoint_changed = !old.host.eq_ignore_ascii_case(&host)
                || old.port != port
                || old.username != username;
            let uses_stored_secret =
                existing_has_vault_secret || matches!(old.auth, AuthMethod::Credential { .. });
            if endpoint_changed && uses_stored_secret && supplied_password.is_none() {
                return Err(
                    "安全策略限制：修改现有服务器的 host/port/username 时必须重新提供新凭据，以防已保存密钥被重定向至其他主机"
                        .to_string(),
                );
            }
        }

        let key_path = args
            .get("key_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let auth_type = args.get("auth_type").and_then(|v| v.as_str());
        let auth = match (auth_type, key_path) {
            (Some("key"), Some(path)) => AuthMethod::Key { path },
            (Some("key"), None) => AuthMethod::Key {
                path: "~/.ssh/id_ed25519".to_string(),
            },
            (Some("password"), _) => AuthMethod::Password,
            (None, Some(path)) => AuthMethod::Key { path },
            (None, None) => existing
                .as_ref()
                .map(|e| e.auth.clone())
                .unwrap_or(AuthMethod::Password),
            _ => AuthMethod::Password,
        };

        let server = Server {
            id,
            name,
            protocol,
            host,
            port,
            username,
            domain: existing.as_ref().and_then(|e| e.domain.clone()),
            auth,
            auth_priority: existing
                .as_ref()
                .map(|e| e.auth_priority.clone())
                .unwrap_or_default(),
            timeout_secs: existing.as_ref().and_then(|e| e.timeout_secs),
            keepalive_secs: existing.as_ref().and_then(|e| e.keepalive_secs),
            jump_hosts: existing
                .as_ref()
                .map(|e| e.jump_hosts.clone())
                .unwrap_or_default(),
            term_type: existing.as_ref().and_then(|e| e.term_type.clone()),
            group: if args.get("group").is_some() {
                opt_str("group")
            } else {
                existing.as_ref().and_then(|e| e.group.clone())
            },
            provider: if args.get("provider").is_some() {
                opt_str("provider")
            } else {
                existing.as_ref().and_then(|e| e.provider.clone())
            },
            region: if args.get("region").is_some() {
                opt_str("region")
            } else {
                existing.as_ref().and_then(|e| e.region.clone())
            },
            os: if args.get("os").is_some() {
                opt_str("os")
            } else {
                existing.as_ref().and_then(|e| e.os.clone())
            },
            tags: if args.get("tags").is_some() {
                tags
            } else {
                existing
                    .as_ref()
                    .map(|e| e.tags.clone())
                    .unwrap_or_default()
            },
            cost: existing
                .as_ref()
                .and_then(|e| e.cost.clone())
                .map(|c| ServerCost {
                    amount: c.amount,
                    cycle: match c.cycle {
                        BillingCycle::Monthly => BillingCycle::Monthly,
                        BillingCycle::Quarterly => BillingCycle::Quarterly,
                        BillingCycle::Semiannual => BillingCycle::Semiannual,
                        BillingCycle::Annual => BillingCycle::Annual,
                    },
                    currency: c.currency,
                }),
            expires_at: existing.as_ref().and_then(|e| e.expires_at.clone()),
            updated_at: now_unix_secs(),
        };

        if let Some(slot) = list.iter_mut().find(|s| s.id == id) {
            *slot = server.clone();
        } else {
            list.insert(0, server.clone());
        }
        store.save(&list).map_err(|e| e.to_string())?;
        server
    };

    if let Some(pw) = supplied_password {
        persist_secret(app, state, &saved_server.id.to_string(), &pw)
            .await
            .map_err(|e| e.message)?;
    }

    state.evict_server_caches(&saved_server.id).await;

    let _ = app.emit("mcp:servers-changed", ());
    Ok(json!({ "server": saved_server }))
}

async fn tool_server_delete(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let id_arg = args
        .get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 server_id".to_string())?;
    let server = resolve_server(app, state, Some(id_arg)).await?;

    {
        let _guard = state.store_lock.write().await;
        let store = server_store(app)?;
        let mut list = store.load().map_err(|e| e.to_string())?;
        list.retain(|s| s.id != server.id);
        for other in &mut list {
            if other.jump_hosts.contains(&server.id) {
                other.jump_hosts.retain(|&hop| hop != server.id);
                other.updated_at = now_unix_secs();
            }
        }
        store.save(&list).map_err(|e| e.to_string())?;
        crate::sync_cmds::record_server_deletion(app, &server.id.to_string());
    }

    let _ = crate::vault::delete_secret(app, state, &server.id.to_string()).await;
    state.evict_server_caches(&server.id).await;

    let _ = app.emit("mcp:servers-changed", ());
    Ok(json!({ "deleted": true, "server_id": server.id, "name": server.name }))
}

async fn tool_server_ping(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let test_ssh = args
        .get("test_ssh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if test_ssh && !state.mcp.config.read().await.allow_ssh_exec {
        return Err("MCP 配置已禁止 SSH 连接操作 (allow_ssh_exec=false)".to_string());
    }
    let icmp_ms = icmp_ping_ms(&server.host).await;

    let mut ssh_ok = None;
    let mut ssh_ms = None;
    let mut ssh_error = None;
    if test_ssh {
        let start = Instant::now();
        match connect_ssh_for_server(app, state, &server).await {
            Ok(session) => {
                ssh_ok = Some(true);
                ssh_ms = Some(start.elapsed().as_millis() as u64);
                let _ = session.close().await;
            }
            Err(e) => {
                ssh_ok = Some(false);
                ssh_error = Some(e);
            }
        }
    }

    Ok(json!({
        "server_id": server.id,
        "name": server.name,
        "host": server.host,
        "port": server.port,
        "icmp_ms": icmp_ms,
        "ssh_ok": ssh_ok,
        "ssh_ms": ssh_ms,
        "ssh_error": ssh_error,
    }))
}

// ============================================================================
// Tool Implementations: SSH Operations
// ============================================================================

async fn tool_ssh_exec(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 command".to_string())?;
    let timeout_secs = args
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(30)
        .clamp(1, 300);

    let full_cmd = if let Some(cwd) = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
    {
        format!("cd -- {} || exit $?\n{}", remote_path_expr(cwd), command)
    } else {
        command.to_string()
    };

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &full_cmd,
        None,
        Duration::from_secs(timeout_secs),
        false,
    )
    .await?;

    Ok(json!({
        "server_id": server.id,
        "server_name": server.name,
        "exit_code": out.exit_code,
        "stdout": out.stdout_string(),
        "stderr": out.stderr_string(),
    }))
}

fn drain_shell_output(buf: &mut Vec<u8>, is_closed: bool) -> String {
    if buf.is_empty() {
        return String::new();
    }
    if is_closed {
        let s = String::from_utf8_lossy(buf).into_owned();
        buf.clear();
        return s;
    }
    let valid_len = trim_incomplete_utf8_tail(buf).len();
    let s = String::from_utf8_lossy(&buf[..valid_len]).into_owned();
    buf.drain(..valid_len);
    s
}

async fn reap_closed_shell_sessions(state: &AppState) {
    let mut to_close = Vec::new();
    {
        let mut guard = state.mcp.shell_sessions.lock().await;
        let dead_ids: Vec<String> = guard
            .iter()
            .filter_map(|(id, s)| {
                if s.closed.load(Ordering::Relaxed)
                    && let Ok(buf) = s.buffer.try_lock()
                    && buf.is_empty()
                {
                    return Some(id.clone());
                }
                None
            })
            .collect();
        for id in dead_ids {
            if let Some(entry) = guard.remove(&id) {
                to_close.push(entry);
            }
        }
    }
    for entry in to_close {
        tokio::spawn(async move {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        });
    }
}

async fn tool_ssh_session_open(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    reap_closed_shell_sessions(state).await;
    const MAX_SHELL_SESSIONS: usize = 32;
    if state.mcp.shell_sessions.lock().await.len() >= MAX_SHELL_SESSIONS {
        return Err(format!(
            "交互式 SSH 会话数量已达上限 ({MAX_SHELL_SESSIONS})，请先关闭不再使用的会话"
        ));
    }

    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .unwrap_or(120)
        .clamp(20, 400) as u32;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .unwrap_or(40)
        .clamp(10, 200) as u32;

    let session = connect_ssh_for_server(app, state, &server).await?;
    let (shell, mut rx) = match session.open_shell(cols, rows).await {
        Ok(res) => res,
        Err(e) => {
            let _ = session.close().await;
            return Err(e.to_string());
        }
    };

    let session_id = Uuid::new_v4().to_string();
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let closed = Arc::new(AtomicBool::new(false));

    let buf_clone = Arc::clone(&buffer);
    let closed_clone = Arc::clone(&closed);
    let app_for_cleanup = app.clone();
    let sid_for_cleanup = session_id.clone();
    tokio::spawn(async move {
        while let Some(evt) = rx.recv().await {
            match evt {
                ShellEvent::Data(bytes) => {
                    let mut guard = buf_clone.lock().await;
                    guard.extend_from_slice(&bytes);
                    if guard.len() > MAX_SHELL_BUFFER_BYTES {
                        let mut drain_len = guard.len() - MAX_SHELL_BUFFER_BYTES;
                        while drain_len < guard.len()
                            && (guard[drain_len] & 0b1100_0000) == 0b1000_0000
                        {
                            drain_len += 1;
                        }
                        guard.drain(..drain_len);
                    }
                }
                ShellEvent::Exit(_) => {
                    // Keep draining any remaining buffered Data until Closed.
                    closed_clone.store(true, Ordering::Relaxed);
                }
                ShellEvent::Closed => {
                    closed_clone.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        closed_clone.store(true, Ordering::Relaxed);
        // Schedule automatic cleanup if the client never reads/closes this exited session.
        tokio::time::sleep(Duration::from_secs(120)).await;
        let state = app_for_cleanup.state::<AppState>();
        let removed = state
            .mcp
            .shell_sessions
            .lock()
            .await
            .remove(&sid_for_cleanup);
        if let Some(entry) = removed {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        }
    });

    // Give the shell a short moment to emit initial prompt/MOTD.
    tokio::time::sleep(Duration::from_millis(450)).await;
    let is_closed = closed.load(Ordering::Relaxed);
    let initial_output = {
        let mut guard = buffer.lock().await;
        drain_shell_output(&mut guard, is_closed)
    };

    {
        let mut sessions = state.mcp.shell_sessions.lock().await;
        if sessions.len() >= MAX_SHELL_SESSIONS {
            drop(sessions);
            let _ = shell.close().await;
            let _ = session.close().await;
            return Err(format!(
                "交互式 SSH 会话数量已达上限 ({MAX_SHELL_SESSIONS})，请先关闭不再使用的会话"
            ));
        }
        sessions.insert(
            session_id.clone(),
            McpShellSession {
                id: session_id.clone(),
                server_id: server.id.to_string(),
                server_name: server.name.clone(),
                shell,
                session,
                buffer,
                closed,
                created_at: now_unix_secs(),
                last_used: Arc::new(Mutex::new(Instant::now())),
            },
        );
    }

    Ok(json!({
        "session_id": session_id,
        "server_id": server.id,
        "server_name": server.name,
        "output": initial_output,
    }))
}

async fn tool_ssh_session_write(state: &AppState, args: Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 session_id".to_string())?;
    let input = args
        .get("input")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 input".to_string())?;
    let append_newline = args
        .get("append_newline")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let wait_ms = args
        .get("wait_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(600)
        .clamp(50, 10000);

    let (shell, buffer, closed, last_used) = {
        let guard = state.mcp.shell_sessions.lock().await;
        let entry = guard
            .get(session_id)
            .ok_or_else(|| format!("SSH 会话不存在或已关闭: {session_id}"))?;
        (
            entry.shell.clone(),
            Arc::clone(&entry.buffer),
            Arc::clone(&entry.closed),
            Arc::clone(&entry.last_used),
        )
    };
    *last_used.lock().await = Instant::now();

    let mut payload = input.as_bytes().to_vec();
    if append_newline {
        payload.push(b'\n');
    }
    shell.write(payload).await.map_err(|e| e.to_string())?;

    tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    let is_closed = closed.load(Ordering::Relaxed);
    let output = {
        let mut guard = buffer.lock().await;
        drain_shell_output(&mut guard, is_closed)
    };
    if is_closed && let Some(entry) = state.mcp.shell_sessions.lock().await.remove(session_id) {
        tokio::spawn(async move {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        });
    }

    Ok(json!({
        "session_id": session_id,
        "output": output,
        "closed": is_closed,
    }))
}

async fn tool_ssh_session_read(state: &AppState, args: Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 session_id".to_string())?;
    let wait_ms = args
        .get("wait_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(100)
        .min(10000);

    let (buffer, closed, last_used) = {
        let guard = state.mcp.shell_sessions.lock().await;
        let entry = guard
            .get(session_id)
            .ok_or_else(|| format!("SSH 会话不存在或已关闭: {session_id}"))?;
        (
            Arc::clone(&entry.buffer),
            Arc::clone(&entry.closed),
            Arc::clone(&entry.last_used),
        )
    };
    *last_used.lock().await = Instant::now();

    if wait_ms > 0 {
        tokio::time::sleep(Duration::from_millis(wait_ms)).await;
    }

    let is_closed = closed.load(Ordering::Relaxed);
    let output = {
        let mut guard = buffer.lock().await;
        drain_shell_output(&mut guard, is_closed)
    };
    if is_closed && let Some(entry) = state.mcp.shell_sessions.lock().await.remove(session_id) {
        tokio::spawn(async move {
            let _ = entry.shell.close().await;
            let _ = entry.session.close().await;
        });
    }

    Ok(json!({
        "session_id": session_id,
        "output": output,
        "closed": is_closed,
    }))
}

async fn tool_ssh_session_close(state: &AppState, args: Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 session_id".to_string())?;

    let removed = state.mcp.shell_sessions.lock().await.remove(session_id);
    if let Some(entry) = removed {
        let _ = entry.shell.close().await;
        let _ = entry.session.close().await;
        Ok(json!({ "closed": true, "session_id": session_id }))
    } else {
        Ok(json!({ "closed": false, "session_id": session_id, "message": "会话不存在或已关闭" }))
    }
}

async fn tool_ssh_sessions_list(state: &AppState) -> Result<Value, String> {
    let guard = state.mcp.shell_sessions.lock().await;
    let sessions: Vec<Value> = guard
        .values()
        .map(|s| {
            json!({
                "session_id": s.id,
                "server_id": s.server_id,
                "server_name": s.server_name,
                "closed": s.closed.load(Ordering::Relaxed),
                "created_at": s.created_at,
            })
        })
        .collect();
    Ok(json!({ "count": sessions.len(), "sessions": sessions }))
}

async fn tool_server_stats(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let start = Instant::now();
    let out = pooled_exec_raw(
        app,
        state,
        &server,
        PROBE_CMD,
        None,
        Duration::from_secs(10),
        true,
    )
    .await?;
    let rtt_ms = start.elapsed().as_secs_f64() * 1000.0;
    let snap = RawSnapshot::parse(&out.stdout_string()).map_err(|e| e.to_string())?;
    let now = Instant::now();
    let stats = {
        let mut prev_map = state.mcp.stats_prev.lock().await;
        let key = server.id.to_string();
        let computed = match prev_map.get(&key) {
            Some((prev_snap, prev_at))
                if now.duration_since(*prev_at) < Duration::from_secs(300) =>
            {
                ServerStats::compute(
                    Some(prev_snap),
                    &snap,
                    now.duration_since(*prev_at).as_secs_f64(),
                    Some(rtt_ms),
                )
            }
            _ => ServerStats::compute(None, &snap, 0.0, Some(rtt_ms)),
        };
        if prev_map.len() >= 128 && !prev_map.contains_key(&key) {
            prev_map.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(300));
        }
        prev_map.insert(key, (snap, now));
        computed
    };
    Ok(json!({
        "server_id": server.id,
        "server_name": server.name,
        "stats": stats,
    }))
}

// ============================================================================
// Tool Implementations: Remote File Operations
// ============================================================================

/// Splits `n` whitespace-delimited tokens from `line`, returning the tokens and the
/// uncollapsed trailing substring (so filenames containing multiple spaces are preserved).
fn split_n_fields_and_rest(line: &str, n: usize) -> Option<(Vec<&str>, &str)> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut fields = Vec::with_capacity(n);
    while fields.len() < n {
        while i < len && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= len {
            return None;
        }
        let start = i;
        while i < len && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        fields.push(&line[start..i]);
    }
    while i < len && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i >= len {
        return None;
    }
    Some((fields, &line[i..]))
}

fn parse_ls_line(line: &str) -> Option<Value> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with("total ") {
        return None;
    }
    // Peek first 6 tokens to detect ISO date format (YYYY-MM-DD HH:MM -> 7 header fields before name)
    // vs POSIX C format (Mon DD HH:MM/YYYY -> 8 header fields before name).
    let (prefix6, _) = split_n_fields_and_rest(trimmed, 6)?;
    let is_iso_date = prefix6[5].len() == 10
        && prefix6[5].as_bytes()[4] == b'-'
        && prefix6[5].as_bytes()[7] == b'-';

    let (fields, raw_name) = if is_iso_date {
        split_n_fields_and_rest(trimmed, 7)?
    } else {
        split_n_fields_and_rest(trimmed, 8)?
    };
    let name = raw_name.trim_end_matches('\r');
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    let perms = fields[0];
    let entry_type = match perms.chars().next() {
        Some('d') => "directory",
        Some('l') => "symlink",
        Some('-') => "file",
        _ => "other",
    };
    let size = fields[4].parse::<u64>().ok();
    let modified = if is_iso_date {
        format!("{} {}", fields[5], fields[6])
    } else {
        format!("{} {} {}", fields[5], fields[6], fields[7])
    };
    Some(json!({
        "name": name,
        "type": entry_type,
        "permissions": perms,
        "owner": fields[2],
        "group": fields[3],
        "size": size,
        "modified": modified,
    }))
}

fn trim_incomplete_utf8_tail(bytes: &[u8]) -> &[u8] {
    if bytes.is_empty() {
        return bytes;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes,
        Err(err) => {
            if err.error_len().is_none() {
                &bytes[..err.valid_up_to()]
            } else {
                // Non-UTF8 binary data earlier in the buffer; check only the last 3 bytes
                let len = bytes.len();
                let start = len.saturating_sub(3);
                for cut in (start..len).rev() {
                    if std::str::from_utf8(&bytes[cut..]).is_ok() {
                        return bytes;
                    }
                    let b = bytes[cut];
                    if (b & 0b1100_0000) != 0b1000_0000 {
                        // Leading byte of an incomplete multi-byte sequence at the tail
                        return &bytes[..cut];
                    }
                }
                bytes
            }
        }
    }
}

async fn tool_remote_list_dir(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let default_dir = state
        .mcp
        .config
        .read()
        .await
        .workspace
        .default_remote_dir
        .clone();
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_dir);
    let show_hidden = args
        .get("show_hidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let flags = if show_hidden { "-la" } else { "-l" };
    let cmd = format!(
        "p={}; [ -d \"$p\" ] && LC_ALL=C ls {flags} -- \"$p\" || {{ echo \"NOT_A_DIRECTORY\" >&2; exit 2; }}",
        remote_path_expr(path)
    );
    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(20),
        true,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "列出远程目录失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }

    let raw = out.stdout_string();
    let mut entries = Vec::new();
    for line in raw.lines() {
        if let Some(entry) = parse_ls_line(line) {
            entries.push(entry);
        }
    }

    Ok(json!({
        "server_id": server.id,
        "path": path,
        "count": entries.len(),
        "entries": entries,
    }))
}

async fn tool_remote_read_file(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 path".to_string())?;
    let start_line = args.get("start_line").and_then(|v| v.as_u64());
    let end_line = args.get("end_line").and_then(|v| v.as_u64());
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(256 * 1024)
        .clamp(1, MAX_READ_BYTES as u64) as usize;

    let path_expr = remote_path_expr(path);
    let check_prefix = format!(
        "p={path_expr}; [ -f \"$p\" ] && [ -r \"$p\" ] || {{ echo 'FILE_NOT_READABLE' >&2; exit 2; }};"
    );
    let cmd = match (start_line, end_line) {
        (Some(s), Some(e)) => {
            let s = s.max(1);
            let e = e.max(s);
            format!(
                "{check_prefix} sed -n '{s},{e}p' -- \"$p\" | head -c {}",
                max_bytes + 1
            )
        }
        (Some(s), None) => {
            let s = s.max(1);
            format!(
                "{check_prefix} tail -n +{s} -- \"$p\" | head -c {}",
                max_bytes + 1
            )
        }
        (None, Some(e)) => {
            let e = e.max(1);
            format!(
                "{check_prefix} head -n {e} -- \"$p\" | head -c {}",
                max_bytes + 1
            )
        }
        (None, None) => {
            format!("{check_prefix} head -c {} -- \"$p\"", max_bytes + 1)
        }
    };

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(30),
        true,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "读取远程文件失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }

    let truncated = out.stdout.len() > max_bytes;
    let slice = if truncated {
        trim_incomplete_utf8_tail(&out.stdout[..max_bytes])
    } else {
        &out.stdout[..]
    };

    Ok(json!({
        "server_id": server.id,
        "path": path,
        "bytes": slice.len(),
        "truncated": truncated,
        "content": String::from_utf8_lossy(slice),
    }))
}

async fn tool_remote_write_file(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 path".to_string())?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 content".to_string())?;
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("overwrite");
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let chmod = args.get("chmod").and_then(|v| v.as_str());
    if let Some(m) = chmod {
        validate_chmod(m)?;
    }

    let bytes = content.as_bytes();
    let path_expr = remote_path_expr(path);
    let redirect = if mode == "append" { ">>" } else { ">" };
    let mut parts = Vec::new();
    if create_dirs {
        parts.push(format!("mkdir -p -- \"$(dirname -- {path_expr})\""));
    }
    parts.push(format!("cat {redirect} {path_expr}"));
    if let Some(m) = chmod {
        parts.push(format!("chmod {} -- {path_expr}", m.trim()));
    }
    let cmd = parts.join(" && ");

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        Some(bytes),
        Duration::from_secs(30),
        false,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "写入远程文件失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }

    Ok(json!({
        "server_id": server.id,
        "path": path,
        "mode": mode,
        "bytes_written": bytes.len(),
        "sha256": sha256_hex(bytes),
    }))
}

async fn tool_remote_stat(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 path".to_string())?;

    let p = remote_path_expr(path);
    let cmd = format!(
        "p={p}; if [ ! -e \"$p\" ] && [ ! -L \"$p\" ]; then echo 'EXISTS=0'; exit 0; fi; \
         echo 'EXISTS=1'; \
         [ -d \"$p\" ] && echo 'IS_DIR=1' || echo 'IS_DIR=0'; \
         [ -f \"$p\" ] && echo 'IS_FILE=1' || echo 'IS_FILE=0'; \
         [ -L \"$p\" ] && echo 'IS_SYMLINK=1' || echo 'IS_SYMLINK=0'; \
         stat -c 'SIZE=%s%nMODE=%a%nOWNER=%U%nGROUP=%G%nMTIME=%Y' -- \"$p\" 2>/dev/null || \
         stat -f 'SIZE=%z%nMODE=%Lp%nOWNER=%Su%nGROUP=%Sg%nMTIME=%m' -- \"$p\" 2>/dev/null || true"
    );

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(15),
        true,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "获取远程路径信息失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }
    let stdout = out.stdout_string();
    let mut exists = false;
    let mut is_dir = false;
    let mut is_file = false;
    let mut is_symlink = false;
    let mut size: Option<u64> = None;
    let mut mode: Option<String> = None;
    let mut owner: Option<String> = None;
    let mut group: Option<String> = None;
    let mut mtime: Option<i64> = None;

    for line in stdout.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k {
                "EXISTS" => exists = v == "1",
                "IS_DIR" => is_dir = v == "1",
                "IS_FILE" => is_file = v == "1",
                "IS_SYMLINK" => is_symlink = v == "1",
                "SIZE" => size = v.parse().ok(),
                "MODE" => mode = Some(v.to_string()),
                "OWNER" => owner = Some(v.to_string()),
                "GROUP" => group = Some(v.to_string()),
                "MTIME" => mtime = v.parse().ok(),
                _ => {}
            }
        }
    }

    Ok(json!({
        "server_id": server.id,
        "path": path,
        "exists": exists,
        "is_dir": is_dir,
        "is_file": is_file,
        "is_symlink": is_symlink,
        "size": size,
        "mode": mode,
        "owner": owner,
        "group": group,
        "mtime": mtime,
    }))
}

async fn tool_remote_mkdir(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 path".to_string())?;
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let flag = if recursive { "-p " } else { "" };
    let cmd = format!("mkdir {flag}-- {}", remote_path_expr(path));

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(15),
        false,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "创建远程目录失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }
    Ok(json!({ "server_id": server.id, "path": path, "created": true }))
}

fn is_protected_remote_delete_path(raw: &str, recursive: bool) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed == "~"
        || trimmed == "~/"
        || trimmed == "~/*"
        || trimmed == "~/.*"
        || trimmed == "$HOME"
        || trimmed == "$HOME/"
        || trimmed == "$HOME/*"
        || trimmed == "."
        || trimmed == ".."
    {
        return true;
    }
    if let Some(after_tilde) = trimmed.strip_prefix("~/") {
        let norm_rel = normalize_lexical(Path::new(after_tilde));
        let rel_str = norm_rel.to_string_lossy();
        let rel_trimmed = rel_str.trim_matches('/');
        if rel_trimmed.is_empty() || rel_trimmed == "." || rel_trimmed == ".." || rel_trimmed == "*"
        {
            return true;
        }
    }
    let normalized = normalize_lexical(Path::new(trimmed));
    let norm_str = normalized.to_string_lossy();
    let stripped = norm_str.trim_end_matches('/');
    if stripped.is_empty() || stripped == "/*" || norm_str == "/" || norm_str == "/*" {
        return true;
    }
    if recursive {
        const PROTECTED_TOP_DIRS: &[&str] = &[
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/home",
            "/lib",
            "/lib64",
            "/opt",
            "/proc",
            "/root",
            "/run",
            "/sbin",
            "/srv",
            "/sys",
            "/tmp",
            "/usr",
            "/var",
            "/System",
            "/Applications",
            "/Users",
        ];
        if PROTECTED_TOP_DIRS.contains(&stripped) {
            return true;
        }
    }
    false
}

async fn tool_remote_delete(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少必需参数 path".to_string())?;
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if is_protected_remote_delete_path(path, recursive) {
        return Err(format!("拒绝删除受保护的系统路径或根目录: '{path}'"));
    }
    let cmd = if recursive {
        format!("rm -rf -- {}", remote_path_expr(path))
    } else {
        format!("rm -f -- {}", remote_path_expr(path))
    };

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(20),
        false,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "删除远程路径失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }
    Ok(json!({ "server_id": server.id, "path": path, "deleted": true }))
}

async fn tool_remote_move(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let src = args
        .get("src")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 src".to_string())?;
    let dst = args
        .get("dst")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 dst".to_string())?;

    let cmd = format!("mv -- {} {}", remote_path_expr(src), remote_path_expr(dst));
    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(20),
        false,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "移动远程路径失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }
    Ok(json!({ "server_id": server.id, "src": src, "dst": dst, "moved": true }))
}

async fn tool_remote_search(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let default_dir = state
        .mcp
        .config
        .read()
        .await
        .workspace
        .default_remote_dir
        .clone();
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_dir);
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("content");
    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少必需参数 pattern".to_string())?;
    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(100)
        .clamp(1, 500);

    let safe_find_path = if path.starts_with('-') || matches!(path, "!" | "(" | ")") {
        format!("./{path}")
    } else {
        path.to_string()
    };
    let cmd = if mode == "name" {
        format!(
            "find {} -name {} 2>/dev/null | head -n {max_results}",
            remote_path_expr(&safe_find_path),
            shell_quote(pattern)
        )
    } else {
        format!(
            "grep -rnI -- {} {} 2>/dev/null | head -n {max_results}",
            shell_quote(pattern),
            remote_path_expr(path)
        )
    };

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        None,
        Duration::from_secs(30),
        true,
    )
    .await?;
    let matches: Vec<String> = out.stdout_string().lines().map(|l| l.to_string()).collect();

    Ok(json!({
        "server_id": server.id,
        "path": path,
        "mode": mode,
        "pattern": pattern,
        "count": matches.len(),
        "matches": matches,
    }))
}

// ============================================================================
// Tool Implementations: File Transfer
// ============================================================================

async fn tool_file_upload(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let local_raw = args
        .get("local_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 local_path".to_string())?;
    let remote_path = args
        .get("remote_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 remote_path".to_string())?;
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let chmod = args.get("chmod").and_then(|v| v.as_str());
    if let Some(m) = chmod {
        validate_chmod(m)?;
    }

    let (workspace_dir, allowed_roots) = {
        let cfg = state.mcp.config.read().await;
        (
            cfg.workspace.local_workspace_dir.clone(),
            cfg.workspace.allowed_local_roots.clone(),
        )
    };
    let app_data_dir = app.path().app_data_dir().ok();
    let local_path = resolve_and_validate_local_path(
        local_raw,
        &workspace_dir,
        &allowed_roots,
        app_data_dir.as_deref(),
        true,
    )?;
    let meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("无法读取本地文件元数据: {e}"))?;
    if !meta.is_file() {
        return Err(format!("本地路径 '{}' 不是普通文件", local_path.display()));
    }
    if meta.len() > MAX_TRANSFER_BYTES as u64 {
        return Err(format!(
            "文件过大 ({} bytes)，超过单次传输上限 ({} bytes)",
            meta.len(),
            MAX_TRANSFER_BYTES
        ));
    }

    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let mut bytes = Vec::with_capacity((meta.len() as usize).min(MAX_TRANSFER_BYTES));
    file.take((MAX_TRANSFER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err(format!(
            "文件在读取期间超过单次传输上限 ({MAX_TRANSFER_BYTES} bytes)"
        ));
    }
    let checksum = sha256_hex(&bytes);

    let rpath = remote_path_expr(remote_path);
    let mut parts = Vec::new();
    if create_dirs {
        parts.push(format!("mkdir -p -- \"$(dirname -- {rpath})\""));
    }
    parts.push(format!("cat > {rpath}"));
    if let Some(m) = chmod {
        parts.push(format!("chmod {} -- {rpath}", m.trim()));
    }
    let cmd = parts.join(" && ");

    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &cmd,
        Some(&bytes),
        Duration::from_secs(180),
        false,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "上传文件到远程服务器失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }

    Ok(json!({
        "server_id": server.id,
        "server_name": server.name,
        "local_path": local_path.display().to_string(),
        "remote_path": remote_path,
        "bytes": bytes.len(),
        "sha256": checksum,
    }))
}

async fn tool_file_download(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let server = resolve_server(app, state, args.get("server_id").and_then(|v| v.as_str())).await?;
    let remote_path = args
        .get("remote_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 remote_path".to_string())?;
    let local_raw = args
        .get("local_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 local_path".to_string())?;
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let (workspace_dir, allowed_roots) = {
        let cfg = state.mcp.config.read().await;
        (
            cfg.workspace.local_workspace_dir.clone(),
            cfg.workspace.allowed_local_roots.clone(),
        )
    };
    let app_data_dir = app.path().app_data_dir().ok();
    let local_path = resolve_and_validate_local_path(
        local_raw,
        &workspace_dir,
        &allowed_roots,
        app_data_dir.as_deref(),
        false,
    )?;

    let rpath = remote_path_expr(remote_path);
    let size_cmd = format!(
        "p={rpath}; [ -f \"$p\" ] && [ -r \"$p\" ] || {{ echo 'FILE_NOT_FOUND' >&2; exit 2; }}; wc -c < \"$p\""
    );
    let size_out = pooled_exec_raw(
        app,
        state,
        &server,
        &size_cmd,
        None,
        Duration::from_secs(15),
        true,
    )
    .await?;
    if size_out.exit_code != Some(0) {
        return Err(format!(
            "远程文件不存在或不可读: {}",
            size_out.stderr_string().trim()
        ));
    }
    if let Ok(sz) = size_out.stdout_string().trim().parse::<usize>()
        && sz > MAX_TRANSFER_BYTES
    {
        return Err(format!(
            "远程文件过大 ({sz} bytes)，超过单次传输上限 ({MAX_TRANSFER_BYTES} bytes)"
        ));
    }

    let dl_cmd = format!(
        "p={rpath}; [ -f \"$p\" ] && [ -r \"$p\" ] || {{ echo 'FILE_NOT_FOUND' >&2; exit 2; }}; head -c {} -- \"$p\"",
        MAX_TRANSFER_BYTES + 1
    );
    let out = pooled_exec_raw(
        app,
        state,
        &server,
        &dl_cmd,
        None,
        Duration::from_secs(180),
        true,
    )
    .await?;
    if out.exit_code != Some(0) {
        return Err(format!(
            "下载远程文件失败 (exit={:?}): {}",
            out.exit_code,
            out.stderr_string().trim()
        ));
    }
    if out.stdout.len() > MAX_TRANSFER_BYTES {
        return Err(format!(
            "远程文件在下载期间超过单次传输上限 ({MAX_TRANSFER_BYTES} bytes)"
        ));
    }

    if create_dirs && let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建本地目录失败: {e}"))?;
    }
    // Re-validate final destination right before writing and write atomically via create_new temp file
    // so symlinks cannot be followed or clobbered.
    let final_path = resolve_and_validate_local_path(
        &local_path.to_string_lossy(),
        &workspace_dir,
        &allowed_roots,
        app_data_dir.as_deref(),
        false,
    )?;
    let write_bytes = out.stdout.clone();
    let target_for_write = final_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        if let Ok(meta) = std::fs::symlink_metadata(&target_for_write)
            && meta.file_type().is_symlink()
        {
            return Err("拒绝覆盖本地符号链接目标".to_string());
        }
        let parent = target_for_write
            .parent()
            .ok_or_else(|| "无效的本地目标目录".to_string())?;
        let fname = target_for_write
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download");
        let tmp = parent.join(format!(".{fname}.tmp.{}", Uuid::new_v4()));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("创建临时下载文件失败: {e}"))?;
        if let Err(e) = f.write_all(&write_bytes).and_then(|_| f.sync_all()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("写入本地文件失败: {e}"));
        }
        drop(f);
        if let Err(e) = crate::sync_cmds::atomic_replace_file_safe(&tmp, &target_for_write) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("保存本地文件失败: {e}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("写入本地文件任务失败: {e}"))??;

    let checksum = sha256_hex(&out.stdout);
    Ok(json!({
        "server_id": server.id,
        "server_name": server.name,
        "remote_path": remote_path,
        "local_path": final_path.display().to_string(),
        "bytes": out.stdout.len(),
        "sha256": checksum,
    }))
}

async fn tool_file_transfer_between_servers(
    app: &tauri::AppHandle,
    state: &AppState,
    args: Value,
) -> Result<Value, String> {
    let src_id = args
        .get("source_server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 source_server_id".to_string())?;
    let dst_id = args
        .get("dest_server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "缺少必需参数 dest_server_id".to_string())?;
    let src_path = args
        .get("source_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 source_path".to_string())?;
    let dst_path = args
        .get("dest_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "缺少必需参数 dest_path".to_string())?;
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let chmod = args.get("chmod").and_then(|v| v.as_str());
    if let Some(m) = chmod {
        validate_chmod(m)?;
    }

    let src_server = resolve_server(app, state, Some(src_id)).await?;
    let dst_server = resolve_server(app, state, Some(dst_id)).await?;

    let spath = remote_path_expr(src_path);
    let size_cmd = format!(
        "p={spath}; [ -f \"$p\" ] && [ -r \"$p\" ] || {{ echo 'FILE_NOT_FOUND' >&2; exit 2; }}; wc -c < \"$p\""
    );
    let size_out = pooled_exec_raw(
        app,
        state,
        &src_server,
        &size_cmd,
        None,
        Duration::from_secs(15),
        true,
    )
    .await?;
    if size_out.exit_code != Some(0) {
        return Err(format!(
            "源服务器文件不存在或不可读: {}",
            size_out.stderr_string().trim()
        ));
    }
    if let Ok(sz) = size_out.stdout_string().trim().parse::<usize>()
        && sz > MAX_TRANSFER_BYTES
    {
        return Err(format!(
            "源文件过大 ({sz} bytes)，超过单次传输上限 ({MAX_TRANSFER_BYTES} bytes)"
        ));
    }

    let dl_out = pooled_exec_raw(
        app,
        state,
        &src_server,
        &format!(
            "p={spath}; [ -f \"$p\" ] && [ -r \"$p\" ] || {{ echo 'FILE_NOT_FOUND' >&2; exit 2; }}; head -c {} -- \"$p\"",
            MAX_TRANSFER_BYTES + 1
        ),
        None,
        Duration::from_secs(180),
        true,
    )
    .await?;
    if dl_out.exit_code != Some(0) {
        return Err(format!(
            "从源服务器读取文件失败: {}",
            dl_out.stderr_string().trim()
        ));
    }
    if dl_out.stdout.len() > MAX_TRANSFER_BYTES {
        return Err(format!(
            "源文件在传输期间超过单次传输上限 ({MAX_TRANSFER_BYTES} bytes)"
        ));
    }

    let dpath = remote_path_expr(dst_path);
    let mut parts = Vec::new();
    if create_dirs {
        parts.push(format!("mkdir -p -- \"$(dirname -- {dpath})\""));
    }
    parts.push(format!("cat > {dpath}"));
    if let Some(m) = chmod {
        parts.push(format!("chmod {} -- {dpath}", m.trim()));
    }
    let up_cmd = parts.join(" && ");

    let up_out = pooled_exec_raw(
        app,
        state,
        &dst_server,
        &up_cmd,
        Some(&dl_out.stdout),
        Duration::from_secs(180),
        false,
    )
    .await?;
    if up_out.exit_code != Some(0) {
        return Err(format!(
            "写入目标服务器失败: {}",
            up_out.stderr_string().trim()
        ));
    }

    Ok(json!({
        "source_server_id": src_server.id,
        "source_path": src_path,
        "dest_server_id": dst_server.id,
        "dest_path": dst_path,
        "bytes": dl_out.stdout.len(),
        "sha256": sha256_hex(&dl_out.stdout),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_quote_and_remote_path() {
        assert_eq!(shell_quote("hello"), "'hello'");
        assert_eq!(shell_quote("it's a test"), "'it'\\''s a test'");
        assert_eq!(remote_path_expr("~"), "\"$HOME\"");
        assert_eq!(
            remote_path_expr("~/my dir/a.txt"),
            "\"$HOME\"/'my dir/a.txt'"
        );
        assert_eq!(remote_path_expr("/var/log/app.log"), "'/var/log/app.log'");
    }

    #[test]
    fn test_validate_chmod() {
        assert!(validate_chmod("644").is_ok());
        assert!(validate_chmod("0755").is_ok());
        assert!(validate_chmod("777; rm -rf /").is_err());
        assert!(validate_chmod("999").is_err());
        assert!(validate_chmod("").is_err());
    }

    #[test]
    fn test_tool_schema_count_and_uniqueness() {
        let val = list_tools();
        let arr = val["tools"].as_array().expect("tools array");
        assert_eq!(arr.len(), 25);
        let mut names = std::collections::HashSet::new();
        for t in arr {
            let name = t["name"].as_str().expect("tool name");
            assert!(names.insert(name), "duplicate tool name: {name}");
            assert!(t["inputSchema"].is_object());
        }
    }

    #[test]
    fn test_local_path_whitelist() {
        let tmp = std::env::temp_dir();
        let root_str = tmp.display().to_string();
        let fake_data_dir = tmp.join("serverhub_fake_appdata");
        let ok = resolve_and_validate_local_path(
            "serverhub_mcp_test_nonexistent.txt",
            &root_str,
            std::slice::from_ref(&root_str),
            Some(&fake_data_dir),
            false,
        );
        assert!(ok.is_ok());

        let escaped = resolve_and_validate_local_path(
            "/etc/hosts",
            &root_str,
            std::slice::from_ref(&root_str),
            Some(&fake_data_dir),
            false,
        );
        assert!(escaped.is_err());

        let vault_attempt = resolve_and_validate_local_path(
            "serverhub_fake_appdata/vault.key",
            &root_str,
            std::slice::from_ref(&root_str),
            Some(&fake_data_dir),
            false,
        );
        assert!(vault_attempt.is_err());
    }

    #[test]
    fn test_protected_remote_delete_paths() {
        assert!(is_protected_remote_delete_path("/", false));
        assert!(is_protected_remote_delete_path("///", true));
        assert!(is_protected_remote_delete_path("/etc/..", true));
        assert!(is_protected_remote_delete_path("~", false));
        assert!(is_protected_remote_delete_path("~/*", true));
        assert!(is_protected_remote_delete_path("~/..", true));
        assert!(is_protected_remote_delete_path("/etc", true));
        assert!(is_protected_remote_delete_path("/var/", true));
        assert!(!is_protected_remote_delete_path("/var/log/app.log", false));
        assert!(!is_protected_remote_delete_path("/opt/myapp/cache", true));
    }

    #[test]
    fn test_drain_shell_output_preserves_incomplete_utf8() {
        let mut buf = "你好".as_bytes().to_vec();
        let last = buf.pop().unwrap(); // incomplete trailing byte of '好'
        let part1 = drain_shell_output(&mut buf, false);
        assert_eq!(part1, "你");
        assert!(!buf.is_empty());
        buf.push(last);
        let part2 = drain_shell_output(&mut buf, false);
        assert_eq!(part2, "好");
        assert!(buf.is_empty());
    }
}
