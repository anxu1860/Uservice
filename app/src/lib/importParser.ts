import type { Protocol, Server } from "../types";

export interface ParsedServerCandidate {
  id: string;
  name: string;
  protocol?: Protocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

const NAME_KEYS = /^(名称|主机名|服务器名称|服务器|节点|备注|别名|name|title|label|alias|remark)$/i;
const HOST_KEYS = /^(地址|ip|ip地址|公网ip|服务器地址|主机|主机地址|域名|host|hostname|addr|address|ipaddr)$/i;
const PORT_KEYS = /^(端口|端口号|ssh端口|port)$/i;
const USER_KEYS = /^(用户|用户名|账号|登录名|user|username|account|login)$/i;
const PASS_KEYS = /^(密码|口令|登录密码|pass|password|pwd)$/i;

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripIpv6Brackets(host: string): string {
  const t = host.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    return t.slice(1, -1);
  }
  return t;
}

function splitHostPort(raw: string): { host: string; port?: number } {
  const trimmed = raw.trim();
  // Bracketed IPv6 with optional port: [::1]:22 or [2001:db8::1]
  const ipv6Match = trimmed.match(/^\[([0-9a-fA-F:]+(?:%[^\]]+)?)\](?::(\d{1,5}))?$/);
  if (ipv6Match) {
    const portNum = ipv6Match[2] ? Number.parseInt(ipv6Match[2], 10) : undefined;
    return {
      host: ipv6Match[1],
      port:
        portNum !== undefined && portNum >= 1 && portNum <= 65535
          ? portNum
          : undefined,
    };
  }
  // Unbracketed IPv6 literal contains multiple colons — never split off the last group as a port
  if ((trimmed.match(/:/g)?.length ?? 0) > 1) {
    return { host: trimmed };
  }
  const ipv4Port = trimmed.match(/^([a-zA-Z0-9.-]+):(\d{1,5})$/);
  if (ipv4Port) {
    const p = Number.parseInt(ipv4Port[2], 10);
    if (p >= 1 && p <= 65535) {
      return { host: ipv4Port[1], port: p };
    }
  }
  return { host: trimmed };
}

function parseSshCommandLine(line: string): Partial<ParsedServerCandidate> | null {
  if (!/\bssh\b/i.test(line)) return null;
  const userHostMatch = line.match(
    /([a-zA-Z0-9._-]+)@(\[[0-9a-fA-F:]+(?:%[^\]]+)?\]|[a-zA-Z0-9.:-]+)/
  );
  if (!userHostMatch) return null;
  const portMatch = line.match(/(?:-p\s*|--port(?:=|\s+))(\d{1,5})/);
  const hp = splitHostPort(userHostMatch[2]);
  const explicitPort = portMatch ? Number.parseInt(portMatch[1], 10) : hp.port ?? 22;
  return {
    username: userHostMatch[1],
    host: stripIpv6Brackets(hp.host),
    port: explicitPort >= 1 && explicitPort <= 65535 ? explicitPort : 22,
  };
}

function parseBlock(lines: string[]): ParsedServerCandidate | null {
  let name = "";
  let host = "";
  let port = 22;
  let username = "root";
  let password = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const sshCmd = parseSshCommandLine(line);
    if (sshCmd) {
      if (sshCmd.host) host = sshCmd.host;
      if (sshCmd.username) username = sshCmd.username;
      if (sshCmd.port) port = sshCmd.port;
      continue;
    }

    const kv = line.match(/^([^:=：]+?)\s*[:：=]\s*(.+)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (NAME_KEYS.test(key)) {
        name = val;
      } else if (HOST_KEYS.test(key)) {
        const hp = splitHostPort(val);
        host = hp.host;
        if (hp.port) port = hp.port;
      } else if (PORT_KEYS.test(key)) {
        const p = Number.parseInt(val, 10);
        if (p >= 1 && p <= 65535) port = p;
      } else if (USER_KEYS.test(key)) {
        username = val;
      } else if (PASS_KEYS.test(key)) {
        password = val;
      }
      continue;
    }

    // Bare user@host[:port] or user@[ipv6][:port]
    const bare = line.match(
      /^([a-zA-Z0-9._-]+)@(\[[0-9a-fA-F:]+(?:%[^\]]+)?\]|[a-zA-Z0-9.:-]+)$/
    );
    if (bare) {
      username = bare[1];
      const hp = splitHostPort(bare[2]);
      host = stripIpv6Brackets(hp.host);
      if (hp.port) {
        port = hp.port;
      }
    }
  }

  if (!host) return null;
  return {
    id: crypto.randomUUID(),
    name: name || host,
    host,
    port,
    username: username || "root",
    password,
  };
}

export function parseServerText(raw: string): ParsedServerCandidate[] {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  // 1. Try JSON object or array
  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const out: ParsedServerCandidate[] = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const rawHost = String(rec.host ?? rec.ip ?? rec.addr ?? rec.address ?? "").trim();
        if (!rawHost) continue;
        const hp = splitHostPort(rawHost);
        const host = stripIpv6Brackets(hp.host);
        if (!host) continue;
        const rawProto = String(rec.protocol ?? "").trim().toLowerCase();
        const protocol: Protocol | undefined =
          rawProto === "ssh" || rawProto === "vnc" || rawProto === "rdp"
            ? rawProto
            : undefined;
        const defaultPort =
          protocol === "rdp" ? 3389 : protocol === "vnc" ? 5900 : 22;
        const portNum =
          rec.port !== undefined && rec.port !== null && String(rec.port).trim() !== ""
            ? Number(rec.port)
            : hp.port ?? defaultPort;
        const rawUser =
          rec.username ?? rec.user ?? (protocol === "vnc" ? "" : "root");
        out.push({
          id: crypto.randomUUID(),
          name: String(rec.name ?? rec.title ?? rec.alias ?? host).trim() || host,
          protocol,
          host,
          port:
            Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535
              ? Math.round(portNum)
              : defaultPort,
          username:
            protocol === "vnc"
              ? String(rawUser).trim()
              : String(rawUser).trim() || "root",
          password: String(rec.password ?? rec.pass ?? rec.pwd ?? ""),
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Fall through to text parsing
    }
  }

  // 2. Try URI lines (e.g. ssh://user:pass@host:22, rdp://..., vnc://...)
  const uriLines = normalized.split("\n").map((l) => l.trim()).filter(Boolean);
  if (uriLines.length > 0 && uriLines.every((l) => /^(ssh|rdp|vnc):\/\//i.test(l))) {
    const out: ParsedServerCandidate[] = [];
    for (const line of uriLines) {
      try {
        const u = new URL(line);
        const host = stripIpv6Brackets(u.hostname);
        if (!host) continue;
        const protoRaw = u.protocol.replace(":", "").toLowerCase();
        const protocol: Protocol =
          protoRaw === "rdp" || protoRaw === "vnc" ? protoRaw : "ssh";
        const defaultPort =
          protocol === "rdp" ? 3389 : protocol === "vnc" ? 5900 : 22;
        const portNum = u.port ? Number.parseInt(u.port, 10) : defaultPort;
        const decodedUser = safeDecodeURIComponent(u.username || "");
        out.push({
          id: crypto.randomUUID(),
          name: safeDecodeURIComponent(u.hash.replace(/^#/, "")) || host,
          protocol,
          host,
          port:
            Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535
              ? portNum
              : defaultPort,
          username: decodedUser || (protocol === "vnc" ? "" : "root"),
          password: safeDecodeURIComponent(u.password || ""),
        });
      } catch {
        // Ignore invalid URI
      }
    }
    if (out.length > 0) return out;
  }

  // 3. Try space/tab separated single-line records: "<host> <port> <user> [pass]"
  const WS_RECORD_RE = /^(\S+)\s+(\d{1,5})\s+(\S+)(?:[ \t]+(.*))?$/;
  const isWhitespaceRecord = (l: string): boolean => {
    if (/\bssh\b/i.test(l)) return false;
    const m = WS_RECORD_RE.exec(l);
    if (!m) return false;
    if (/[:：=]$/.test(m[1]) || /[：=]/.test(m[1])) return false;
    const p = Number.parseInt(m[2], 10);
    if (p < 1 || p > 65535) return false;
    if (/[:：=]$/.test(m[3])) return false;
    return true;
  };
  if (uriLines.length > 0 && uriLines.every(isWhitespaceRecord)) {
    const out: ParsedServerCandidate[] = [];
    for (const line of uriLines) {
      const m = WS_RECORD_RE.exec(line);
      if (!m) continue;
      const hp = splitHostPort(m[1]);
      const host = stripIpv6Brackets(hp.host);
      const maybePort = Number.parseInt(m[2], 10);
      if (host && Number.isFinite(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        out.push({
          id: crypto.randomUUID(),
          name: host,
          host,
          port: maybePort,
          username: m[3] || "root",
          password: m[4] ?? "",
        });
      }
    }
    if (out.length > 0) return out;
  }

  // Split inline key-value pairs like "密码: xxx 名称: yyy" onto separate lines
  const expanded = normalized.replace(
    /\s+(?=(?:名称|主机名|服务器名称|服务器|节点|备注|别名|地址|ip地址|公网ip|服务器地址|主机地址|主机|域名|ip|端口号|ssh端口|端口|用户名|登录名|用户|账号|登录密码|密码|口令|hostname|ipaddr|address|addr|host|title|label|alias|remark|name|port|username|account|login|user|password|pass|pwd)\s*[:：=])/gi,
    "\n"
  );

  // Split by blank lines first; if single block has repeated name/host keys, split on those too.
  const blocks = expanded.split(/\n\s*\n+/);
  const results: ParsedServerCandidate[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // Check if multiple records are packed without blank lines
    const subBlocks: string[][] = [[]];
    let seenHostInCurrent = false;
    for (const line of lines) {
      const kv = line.trim().match(/^([^:=：]+?)\s*[:：=]\s*(.+)$/);
      const isName = kv ? NAME_KEYS.test(kv[1].trim()) : false;
      const isHost = kv ? HOST_KEYS.test(kv[1].trim()) : false;

      if ((isName || isHost) && seenHostInCurrent) {
        subBlocks.push([]);
        seenHostInCurrent = false;
      }
      subBlocks[subBlocks.length - 1].push(line);
      if (isHost) seenHostInCurrent = true;
    }

    for (const sub of subBlocks) {
      const parsed = parseBlock(sub);
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

export function candidateToServer(c: ParsedServerCandidate): Server {
  const protocol: Protocol = c.protocol ?? "ssh";
  return {
    id: c.id,
    name: c.name.trim() || c.host.trim(),
    protocol,
    host: c.host.trim(),
    port: c.port,
    username:
      protocol === "vnc" ? c.username.trim() : c.username.trim() || "root",
    auth: { type: "password" },
    tags: [],
    updated_at: Math.floor(Date.now() / 1000),
  };
}
