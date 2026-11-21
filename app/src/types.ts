export type AuthMethod =
  | { type: "password" }
  | { type: "key"; path: string };

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  group?: string;
  provider?: string;
  tags: string[];
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
    | "other";
  message: string;
  fingerprint?: string | null;
  expected?: string | null;
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
  latencyMs: number | null;
}

export function parseCmdError(err: unknown): CmdError {
  if (typeof err === "object" && err !== null && "kind" in err && "message" in err) {
    const e = err as Record<string, unknown>;
    return {
      kind: String(e.kind) as CmdError["kind"],
      message: String(e.message),
      fingerprint: typeof e.fingerprint === "string" ? e.fingerprint : null,
      expected: typeof e.expected === "string" ? e.expected : null,
    };
  }
  return {
    kind: "other",
    message: err instanceof Error ? err.message : String(err),
  };
}
