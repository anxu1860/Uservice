import { Channel, invoke } from "@tauri-apps/api/core";

export type AiProtocol = "open_ai_compatible" | "anthropic" | "gemini";

export interface AiProfile {
  id: string;
  name: string;
  protocol: AiProtocol;
  base_url: string;
  model: string;
  custom_headers: Record<string, string>;
  temperature?: number | null;
  max_tokens?: number | null;
  system_prompt?: string | null;
  has_api_key: boolean;
  updated_at: number;
}

export interface AiConfigData {
  default_profile_id: string | null;
  profiles: AiProfile[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ServerContext {
  server_name?: string;
  host?: string;
  port?: number;
  username?: string;
  os?: string;
  stats_summary?: string;
  terminal_tail?: string;
}

export type AiStreamEvent =
  | { event: "delta"; data: string }
  | { event: "done" }
  | { event: "error"; data: string };

export interface TestConnectionResult {
  ok: boolean;
  latency_ms: number;
  message: string;
}

export interface AiPreset {
  label: string;
  protocol: AiProtocol;
  base_url: string;
  model: string;
  needsKey: boolean;
}

export const AI_PRESETS: AiPreset[] = [
  {
    label: "OpenAI",
    protocol: "open_ai_compatible",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
  },
  {
    label: "DeepSeek",
    protocol: "open_ai_compatible",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    needsKey: true,
  },
  {
    label: "Anthropic Claude",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    needsKey: true,
  },
  {
    label: "Google Gemini",
    protocol: "gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    needsKey: true,
  },
  {
    label: "Ollama (本地)",
    protocol: "open_ai_compatible",
    base_url: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder:7b",
    needsKey: false,
  },
  {
    label: "OpenRouter",
    protocol: "open_ai_compatible",
    base_url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    needsKey: true,
  },
];

export type CommandRiskLevel = "safe" | "caution" | "danger";

export interface CommandRisk {
  level: CommandRiskLevel;
  reason?: string;
}

function stripShellComments(command: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (
      ch === "#" &&
      !inSingle &&
      !inDouble &&
      (i === 0 || /\s/.test(command[i - 1]))
    ) {
      while (i < command.length && command[i] !== "\n") {
        i++;
      }
      if (i < command.length && command[i] === "\n") {
        out += "\n";
      }
      continue;
    }
    out += ch;
  }
  return out;
}

const CMD_PREFIX =
  "(?:^|[\\s;|&(\`'\"\\$]|(?:\\/(?:usr\\/)?(?:local\\/)?s?bin\\/))";

/**
 * Normalize trivial shell obfuscations (e.g. `\rm`, `r\m`, `'rm'`, `"rm"`, `r''m`)
 * so risk heuristics still catch them without mutating the actual command text.
 */
function deobfuscateShellCommand(cmd: string): string {
  return cmd
    .replace(/''|""/g, "")
    .replace(/\\([a-zA-Z0-9_./-])/g, "$1")
    .replace(/(['"])([a-zA-Z0-9_./-]+)\1/g, "$2");
}

const DANGER_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(`${CMD_PREFIX}rm\\b[^\\n;|&]*\\s(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)(?:\\s|$)`), reason: "递归或强制删除文件" },
  { re: new RegExp(`${CMD_PREFIX}rm\\s+[^\\n;|&]*\\/(etc|bin|sbin|usr|lib|lib64|boot|var|sys|proc|dev|root)(\\/|\\s|$)`), reason: "删除系统关键路径文件" },
  { re: new RegExp(`${CMD_PREFIX}find\\b[\\s\\S]*\\s-delete\\b`), reason: "批量删除匹配文件" },
  { re: new RegExp(`${CMD_PREFIX}shred\\b`), reason: "覆写并销毁文件" },
  { re: new RegExp(`${CMD_PREFIX}(curl|wget)\\b[\\s\\S]*\\|\\s*(sudo\\s+)?(?:\\/(?:usr\\/)?bin\\/)?(sh|bash|zsh|dash|ksh|python[23]?|perl|ruby)\\b`), reason: "下载并直接执行远程脚本" },
  { re: new RegExp(`${CMD_PREFIX}(sh|bash|zsh|dash|ksh|source|\\.)\\s+[^\\n;|&]*<\\(\\s*(curl|wget)\\b`), reason: "通过进程替换直接执行远程脚本" },
  { re: new RegExp(`${CMD_PREFIX}(sh|bash|zsh|dash|ksh)\\s+-c\\s+[^\\n;|&]*(\\$\\(|\`)\\s*(curl|wget)\\b`), reason: "通过命令替换直接执行远程脚本" },
  { re: /\bbase64\b[\s\S]*(-d|--decode)\b[\s\S]*\|\s*(sudo\s+)?(?:\/(?:usr\/)?bin\/)?(sh|bash|zsh|dash|python[23]?|perl)\b/, reason: "解码并直接执行混淆脚本" },
  { re: new RegExp(`${CMD_PREFIX}eval\\b`), reason: "动态 eval 执行脚本" },
  { re: new RegExp(`${CMD_PREFIX}(nc|ncat|netcat|socat)\\b[^\\n;|&]*\\s(-e|-c|EXEC:)`), reason: "疑似反弹 Shell 或远程命令绑定" },
  { re: new RegExp(`${CMD_PREFIX}(python[23]?|perl|ruby|node)\\b[^\\n;|&]*\\s-[ce]\\s+[^\\n;|&]*(rmtree|unlink|os\\.system|subprocess|child_process|rm\\s+-rf)`), reason: "内联脚本包含破坏性操作" },
  { re: new RegExp(`${CMD_PREFIX}(mkfs(\\.[a-z0-9]+)?|fdisk|parted|wipefs)\\b`), reason: "磁盘分区或格式化操作" },
  { re: new RegExp(`${CMD_PREFIX}dd\\b[\\s\\S]*\\bof=`), reason: "底层块设备写入" },
  { re: new RegExp(`${CMD_PREFIX}(shutdown|reboot|poweroff|halt|init\\s+[06])\\b`), reason: "服务器关机或重启" },
  { re: new RegExp(`${CMD_PREFIX}(kill|pkill|killall)\\b[^\\n;|&]*\\s(-9|-KILL|-SIGKILL)\\b`), reason: "强制终止进程" },
  { re: new RegExp(`${CMD_PREFIX}ufw\\s+disable\\b`), reason: "关闭系统防火墙" },
  { re: new RegExp(`${CMD_PREFIX}iptables\\b[^\\n;|&]*\\s(-F|--flush)\\b`), reason: "清空防火墙规则" },
  { re: new RegExp(`${CMD_PREFIX}chmod\\s+(-R\\s+)?(0?777|a\\+rwx)\\b`), reason: "放开全部文件权限" },
  { re: />{1,2}\s*\/(etc|boot|dev|sys|proc|root)\//, reason: "重定向覆写系统关键路径" },
  { re: new RegExp(`${CMD_PREFIX}history\\s+(-c|--clear)\\b`), reason: "清除命令审计历史" },
  { re: /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, reason: "删除或清空数据库/数据表" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "Fork 炸弹模式" },
];

const CAUTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: new RegExp(`${CMD_PREFIX}rm\\s+`), reason: "删除文件" },
  { re: new RegExp(`${CMD_PREFIX}sudo\\b`), reason: "使用特权提权执行" },
  { re: new RegExp(`${CMD_PREFIX}systemctl\\s+(restart|stop|disable|mask)\\b`), reason: "停止或重启系统服务" },
  { re: new RegExp(`${CMD_PREFIX}docker\\s+(rm|rmi|stop|kill|system\\s+prune)\\b`), reason: "停止或清理容器/镜像" },
  { re: new RegExp(`${CMD_PREFIX}(apt|apt-get|yum|dnf|pacman|pip[23]?|npm|pnpm)\\s+(install|remove|purge|upgrade)\\b`), reason: "安装或卸载软件包" },
  { re: new RegExp(`${CMD_PREFIX}(mv|cp|chmod|chown|sed\\s+-i|tee|crontab\\s+-[er])\\b`), reason: "修改文件、权限或计划任务" },
];

function hasFileWriteRedirection(cmd: string): boolean {
  // Strip benign redirections such as 2>/dev/null, >/dev/null, 2>&1, 1>&2, &>/dev/null
  const cleaned = cmd
    .replace(/(?:\d|&)?>>?\s*\/dev\/null\b/g, "")
    .replace(/\d?>>?&\d+\b/g, "");
  return />{1,2}\s*[^\s&]/.test(cleaned);
}

export function assessCommandRisk(command: string): CommandRisk {
  const cmd = stripShellComments(command).trim();
  if (!cmd) return { level: "safe" };
  const normalized = deobfuscateShellCommand(cmd);
  const variants = normalized === cmd ? [cmd] : [cmd, normalized];
  for (const p of DANGER_PATTERNS) {
    if (variants.some((v) => p.re.test(v))) {
      return { level: "danger", reason: p.reason };
    }
  }
  for (const p of CAUTION_PATTERNS) {
    if (variants.some((v) => p.re.test(v))) {
      return { level: "caution", reason: p.reason };
    }
  }
  if (variants.some((v) => hasFileWriteRedirection(v))) {
    return { level: "caution", reason: "输出重定向写入文件" };
  }
  return { level: "safe" };
}

export async function listAiProfiles(): Promise<AiConfigData> {
  return invoke<AiConfigData>("ai_profiles_list");
}

export async function upsertAiProfile(params: {
  profile: AiProfile;
  apiKey?: string;
  clearApiKey?: boolean;
  setDefault?: boolean;
}): Promise<AiConfigData> {
  return invoke<AiConfigData>("ai_profiles_upsert", {
    profile: params.profile,
    apiKey: params.apiKey ?? null,
    clearApiKey: params.clearApiKey ?? false,
    setDefault: params.setDefault ?? false,
  });
}

export async function deleteAiProfile(profileId: string): Promise<AiConfigData> {
  return invoke<AiConfigData>("ai_profiles_delete", { profileId });
}

export async function setDefaultAiProfile(profileId: string): Promise<AiConfigData> {
  return invoke<AiConfigData>("ai_profiles_set_default", { profileId });
}

export async function testAiConnection(
  profile: AiProfile,
  apiKeyOverride?: string
): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>("ai_test_connection", {
    profile,
    apiKeyOverride: apiKeyOverride ?? null,
  });
}

export async function fetchAiModels(
  profile: AiProfile,
  apiKeyOverride?: string
): Promise<string[]> {
  return invoke<string[]>("ai_list_models", {
    profile,
    apiKeyOverride: apiKeyOverride ?? null,
  });
}

export async function startAiChatStream(params: {
  streamId: string;
  profileId?: string | null;
  messages: ChatMessage[];
  context?: ServerContext;
  onEvent: (event: AiStreamEvent) => void;
}): Promise<void> {
  const channel = new Channel<AiStreamEvent>();
  channel.onmessage = params.onEvent;
  await invoke("ai_chat_stream", {
    streamId: params.streamId,
    profileId: params.profileId ?? null,
    messages: params.messages,
    context: params.context ?? null,
    onEvent: channel,
  });
}

export async function cancelAiChatStream(streamId: string): Promise<void> {
  await invoke("ai_chat_cancel", { streamId });
}
