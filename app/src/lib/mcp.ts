import { invoke } from "@tauri-apps/api/core";

export interface McpWorkspaceSettings {
  local_workspace_dir: string;
  default_server_id: string | null;
  default_group: string | null;
  default_remote_dir: string;
  allowed_local_roots: string[];
}

export interface McpConfig {
  enabled: boolean;
  host: string;
  port: number;
  require_auth: boolean;
  allow_workspace_write: boolean;
  allow_ssh_exec: boolean;
  allow_remote_files: boolean;
  allow_file_transfer: boolean;
  auto_accept_unknown_host_keys: boolean;
  workspace: McpWorkspaceSettings;
}

export interface McpLogEntry {
  id: number;
  timestamp: number;
  tool: string;
  summary: string;
  ok: boolean;
  duration_ms: number;
}

export interface McpStatus {
  running: boolean;
  bind_url: string;
  sse_url: string;
  active_clients: number;
  active_ssh_sessions: number;
  total_requests: number;
  last_error: string | null;
  recent_logs: McpLogEntry[];
}

export interface McpStatePayload {
  config: McpConfig;
  status: McpStatus;
  token: string;
}

export function getMcpState(): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_get_state");
}

export function saveMcpConfig(config: McpConfig): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_save_config", { config });
}

export function startMcpServer(): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_start");
}

export function stopMcpServer(): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_stop");
}

export function regenerateMcpToken(): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_regenerate_token");
}

export function clearMcpLogs(): Promise<McpStatePayload> {
  return invoke<McpStatePayload>("mcp_clear_logs");
}

export interface McpToolGroup {
  title: string;
  tools: { name: string; desc: string }[];
}

export const MCP_TOOL_GROUPS: McpToolGroup[] = [
  {
    title: "工作区与服务器管理",
    tools: [
      { name: "workspace_get_settings", desc: "读取工作区配置、权限开关与分组信息" },
      { name: "workspace_update_settings", desc: "更新本地工作区目录、默认服务器、默认远程目录等" },
      { name: "servers_list", desc: "列出工作区中的服务器（支持分组/协议/标签/关键词筛选）" },
      { name: "server_get", desc: "查看单个服务器非敏感配置详情" },
      { name: "server_upsert", desc: "新增或更新服务器配置（可选保存加密凭据）" },
      { name: "server_delete", desc: "删除指定服务器" },
      { name: "server_ping", desc: "检测服务器 ICMP 延迟与 SSH 连通性" },
    ],
  },
  {
    title: "SSH 操作与系统监控",
    tools: [
      { name: "ssh_exec", desc: "在远程服务器执行命令并返回 stdout/stderr/exit_code" },
      { name: "ssh_session_open", desc: "打开持久化交互式 PTY SSH 会话" },
      { name: "ssh_session_write", desc: "向交互式 SSH 会话发送命令并读取输出" },
      { name: "ssh_session_read", desc: "读取交互式 SSH 会话缓冲区输出" },
      { name: "ssh_session_close", desc: "关闭指定交互式 SSH 会话" },
      { name: "ssh_sessions_list", desc: "列出当前活跃的 MCP SSH 会话" },
      { name: "server_stats", desc: "采集远程服务器实时 CPU / 内存 / 磁盘 / 负载信息" },
    ],
  },
  {
    title: "远程文件管理",
    tools: [
      { name: "remote_list_dir", desc: "列出远程目录文件与权限信息" },
      { name: "remote_read_file", desc: "按行范围或字节上限读取远程文件内容" },
      { name: "remote_write_file", desc: "覆盖或追加写入远程文件（支持自动建目录与 chmod）" },
      { name: "remote_stat", desc: "查询远程文件/目录元数据（存在性、大小、权限、属主）" },
      { name: "remote_mkdir", desc: "在远程服务器创建目录" },
      { name: "remote_delete", desc: "删除远程文件或目录" },
      { name: "remote_move", desc: "移动或重命名远程文件/目录" },
      { name: "remote_search", desc: "按文件名（find）或内容（grep）搜索远程目录" },
    ],
  },
  {
    title: "文件传输",
    tools: [
      { name: "file_upload", desc: "二进制安全上传本地文件到远程服务器（含 SHA-256 校验）" },
      { name: "file_download", desc: "二进制安全下载远程文件到本地（含 SHA-256 校验）" },
      { name: "file_transfer_between_servers", desc: "在两台 ServerHub 服务器之间直接传输文件" },
    ],
  },
];
