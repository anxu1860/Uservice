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
  password?: string;
  passphrase?: string;
}
