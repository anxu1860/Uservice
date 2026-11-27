export type Protocol = "ssh" | "vnc" | "rdp";

export type BillingCycle = "monthly" | "quarterly" | "semiannual" | "annual";

export interface ServerCost {
  amount: number;
  cycle: BillingCycle;
  currency: string;
}

export type AuthStage =
  | "key"
  | "credential"
  | "password"
  | "keyboard_interactive";

export const DEFAULT_AUTH_PRIORITY: AuthStage[] = [
  "key",
  "credential",
  "password",
  "keyboard_interactive",
];

export const AUTH_STAGE_META: Record<
  AuthStage,
  { label: string; shortLabel: string; desc: string }
> = {
  key: {
    label: "SSH 私钥",
    shortLabel: "私钥",
    desc: "PublicKey 非对称密钥签名认证",
  },
  credential: {
    label: "登录凭证",
    shortLabel: "凭证",
    desc: "复用已保存的凭证库账号/密钥",
  },
  password: {
    label: "密码认证",
    shortLabel: "密码",
    desc: "标准 SSH Password 静态密码认证",
  },
  keyboard_interactive: {
    label: "交互认证",
    shortLabel: "交互",
    desc: "PAM / 2FA 动态口令 / 挑战应答认证",
  },
};

export const TERMINAL_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "xterm-256color", label: "xterm-256color（默认推荐）" },
  { value: "xterm", label: "xterm（标准兼容）" },
  { value: "xterm-color", label: "xterm-color" },
  { value: "tmux-256color", label: "tmux-256color" },
  { value: "screen-256color", label: "screen-256color" },
  { value: "vt100", label: "vt100（经典终端/网络设备）" },
  { value: "vt220", label: "vt220" },
  { value: "linux", label: "linux（Linux 控制台）" },
  { value: "rxvt-unicode-256color", label: "rxvt-unicode-256color" },
  { value: "ansi", label: "ansi" },
];

export type CredentialKind = "password" | "key";

export interface Credential {
  id: string;
  name: string;
  username?: string;
  kind: CredentialKind;
  key_path?: string;
  updated_at: number;
}

export type AuthMethod =
  | { type: "password" }
  | { type: "key"; path: string }
  | { type: "credential"; credential_id: string }
  | { type: "keyboard_interactive" }
  | { type: "ask"; key_path?: string };

export interface Server {
  id: string;
  name: string;
  protocol?: Protocol;
  host: string;
  port: number;
  username: string;
  domain?: string;
  auth: AuthMethod;
  auth_priority?: AuthStage[];
  timeout_secs?: number;
  keepalive_secs?: number;
  jump_hosts?: string[];
  term_type?: string;
  group?: string;
  provider?: string;
  region?: string;
  os?: string;
  tags: string[];
  cost?: ServerCost;
  expires_at?: string;
  updated_at: number;
}

export type TabStatus = "connecting" | "connected" | "error" | "closed";

export interface TerminalTab {
  tabId: string;
  server: Server;
  sessionId: string | null;
  status: TabStatus;
  errorMessage?: string;
  errorKind?: CmdError["kind"];
  password?: string;
  passphrase?: string;
  acceptHostKey?: string;
  connectNonce: number;
}

export interface CmdError {
  kind:
    | "host_key_unknown"
    | "host_key_mismatch"
    | "auth"
    | "connect"
    | "busy"
    | "other";
  message: string;
  host?: string | null;
  fingerprint?: string | null;
  expected?: string | null;
}

export function buildSshAuthPayload(
  auth: AuthMethod,
  runtime?: { password?: string; passphrase?: string }
) {
  const pw = runtime?.password || null;
  const pp = runtime?.passphrase || runtime?.password || null;
  switch (auth.type) {
    case "password":
      return { type: "password" as const, password: pw };
    case "key":
      return { type: "key" as const, path: auth.path, passphrase: pp };
    case "credential":
      return {
        type: "credential" as const,
        credential_id: auth.credential_id,
        password: pw,
      };
    case "keyboard_interactive":
      return {
        type: "keyboard_interactive" as const,
        password: pw,
      };
    case "ask":
      return {
        type: "ask" as const,
        password: pw,
        key_path: auth.key_path || null,
        passphrase: pp,
      };
  }
}

export function sanitizeAuthPriority(raw: unknown): AuthStage[] {
  const valid: AuthStage[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (
        (item === "key" ||
          item === "credential" ||
          item === "password" ||
          item === "keyboard_interactive") &&
        !valid.includes(item)
      ) {
        valid.push(item);
      }
    }
  }
  for (const d of DEFAULT_AUTH_PRIORITY) {
    if (!valid.includes(d)) valid.push(d);
  }
  return valid;
}

export interface ServerStats {
  hostname: string;
  os: string;
  uptimeSecs: number;
  cpuPercent: number | null;
  cores: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  load1: number;
  load5: number;
  load15: number;
  diskTotal: number;
  diskUsed: number;
  netRxRate: number | null;
  netTxRate: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  latencyMs: number | null;
}

export function parseCmdError(err: unknown): CmdError {
  if (typeof err === "object" && err !== null && "kind" in err && "message" in err) {
    const e = err as Record<string, unknown>;
    return {
      kind: String(e.kind) as CmdError["kind"],
      message: String(e.message),
      host: typeof e.host === "string" ? e.host : null,
      fingerprint: typeof e.fingerprint === "string" ? e.fingerprint : null,
      expected: typeof e.expected === "string" ? e.expected : null,
    };
  }
  return {
    kind: "other",
    message: err instanceof Error ? err.message : String(err),
  };
}
