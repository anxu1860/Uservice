export interface TerminalHighlightRule {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  ignoreCase: boolean;
  foreground: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export function getDefaultHighlightRules(): TerminalHighlightRule[] {
  return [
    {
      id: "builtin-error",
      name: "错误 / 异常关键字",
      pattern:
        "\\b(?:ERROR|FATAL|CRITICAL|PANIC|EXCEPTION|FAIL(?:ED|URE)?|DENIED|REFUSED|SEGFAULT|OOM)\\b",
      enabled: true,
      ignoreCase: true,
      foreground: "#ff5f56",
      bold: true,
    },
    {
      id: "builtin-warn",
      name: "警告 / 超时关键字",
      pattern: "\\b(?:WARN(?:ING)?|DEPRECATED|TIMEOUT|TIMED\\s+OUT|RETRY(?:ING)?|CAUTION)\\b",
      enabled: true,
      ignoreCase: true,
      foreground: "#ffbd2e",
      bold: true,
    },
    {
      id: "builtin-success",
      name: "成功 / 在线状态",
      pattern:
        "\\b(?:SUCCESS(?:FUL)?|SUCCEEDED|PASSED|READY|ACTIVE|RUNNING|HEALTHY|CONNECTED|ONLINE|OK)\\b",
      enabled: true,
      ignoreCase: false,
      foreground: "#27c93f",
      bold: true,
    },
    {
      id: "builtin-http-err",
      name: "HTTP 4xx / 5xx 状态码",
      pattern: "\\bHTTP/\\d(?:\\.\\d)?\\s+[45]\\d{2}\\b|\\bstatus[=: ]+[45]\\d{2}\\b",
      enabled: true,
      ignoreCase: true,
      foreground: "#fb7185",
      bold: true,
    },
    {
      id: "builtin-url",
      name: "URL 链接",
      pattern: "https?://[^\\s\"'<>()\\]]+",
      enabled: true,
      ignoreCase: true,
      foreground: "#60a5fa",
      underline: true,
    },
    {
      id: "builtin-ipv4",
      name: "IPv4 地址与端口",
      pattern:
        "\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)(?::\\d{1,5})?\\b",
      enabled: true,
      ignoreCase: false,
      foreground: "#38bdf8",
    },
    {
      id: "builtin-timestamp",
      name: "时间戳 / 日期",
      pattern:
        "\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b|\\b\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?\\b",
      enabled: true,
      ignoreCase: false,
      foreground: "#a78bfa",
    },
    {
      id: "builtin-path",
      name: "Linux 常见路径",
      pattern:
        "(?<![A-Za-z0-9_])/(?:etc|var|opt|usr|home|root|tmp|srv|proc|sys|dev|app|data|mnt|boot)(?:/[A-Za-z0-9._@-]+)*",
      enabled: true,
      ignoreCase: false,
      foreground: "#2dd4bf",
    },
    {
      id: "builtin-uuid",
      name: "UUID 标识符",
      pattern:
        "\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b",
      enabled: true,
      ignoreCase: false,
      foreground: "#818cf8",
    },
  ];
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_HIGHLIGHT_RULES = 50;
const MAX_PATTERN_LENGTH = 300;
const MAX_CHUNK_SCAN_MS = 12;

const BUILTIN_SAFE_PATTERNS = new Set(
  getDefaultHighlightRules().map((r) => r.pattern)
);

/**
 * Heuristic check for nested repeating quantifiers (e.g. `(a+)+`, `(\w*)*`, `(a+){2,}`)
 * that can trigger catastrophic backtracking (ReDoS) in JavaScript's regex engine.
 */
function hasUnsafeQuantifierNesting(pattern: string): boolean {
  if (BUILTIN_SAFE_PATTERNS.has(pattern)) return false;

  interface GroupFrame {
    hasRepetition: boolean;
  }
  const stack: GroupFrame[] = [{ hasRepetition: false }];
  let inCharClass = false;

  const isRepeatingQuantifierAt = (idx: number): { repeating: boolean; nextIdx: number } => {
    if (idx >= pattern.length) return { repeating: false, nextIdx: idx };
    const ch = pattern[idx];
    if (ch === "+" || ch === "*") {
      let next = idx + 1;
      if (pattern[next] === "?") next++;
      return { repeating: true, nextIdx: next };
    }
    if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(idx));
      if (m) {
        const min = Number.parseInt(m[1], 10);
        const hasComma = m[2] !== undefined;
        const max = m[3] ? Number.parseInt(m[3], 10) : Infinity;
        const repeating = hasComma ? max > 1 : min > 1;
        let next = idx + m[0].length;
        if (pattern[next] === "?") next++;
        return { repeating, nextIdx: next };
      }
    }
    return { repeating: false, nextIdx: idx };
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // Skip escaped char
      continue;
    }
    if (inCharClass) {
      if (ch === "]") inCharClass = false;
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      continue;
    }
    if (ch === "(") {
      stack.push({ hasRepetition: false });
      continue;
    }
    if (ch === ")") {
      const closed = stack.length > 1 ? stack.pop()! : { hasRepetition: false };
      const q = isRepeatingQuantifierAt(i + 1);
      if (q.repeating) {
        if (closed.hasRepetition) {
          return true;
        }
        stack[stack.length - 1].hasRepetition = true;
        i = q.nextIdx - 1;
      } else if (closed.hasRepetition) {
        stack[stack.length - 1].hasRepetition = true;
      }
      continue;
    }
    if (ch === "+" || ch === "*" || ch === "{") {
      const q = isRepeatingQuantifierAt(i);
      if (q.repeating) {
        stack[stack.length - 1].hasRepetition = true;
        i = q.nextIdx - 1;
      }
    }
  }
  return false;
}

export function sanitizeHighlightRules(raw: unknown): TerminalHighlightRule[] {
  if (!Array.isArray(raw)) {
    return getDefaultHighlightRules();
  }
  const out: TerminalHighlightRule[] = [];
  const limit = Math.min(raw.length, MAX_HIGHLIGHT_RULES);
  for (let i = 0; i < limit; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const rawPattern = typeof r.pattern === "string" ? r.pattern : "";
    const pattern =
      rawPattern.length <= MAX_PATTERN_LENGTH ? rawPattern : rawPattern.slice(0, MAX_PATTERN_LENGTH);
    const foreground =
      typeof r.foreground === "string" && HEX_RE.test(r.foreground.trim())
        ? r.foreground.trim()
        : "#38bdf8";
    const background =
      typeof r.background === "string" && HEX_RE.test(r.background.trim())
        ? r.background.trim()
        : undefined;
    out.push({
      id: typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 80) : `rule-${i}-${Date.now()}`,
      name: typeof r.name === "string" ? r.name.slice(0, 80) : "自定义规则",
      pattern,
      enabled: typeof r.enabled === "boolean" ? r.enabled : true,
      ignoreCase: typeof r.ignoreCase === "boolean" ? r.ignoreCase : false,
      foreground,
      background,
      bold: Boolean(r.bold),
      italic: Boolean(r.italic),
      underline: Boolean(r.underline),
    });
  }
  return out;
}

export function validateHighlightPattern(pattern: string): string | null {
  if (!pattern.trim()) return "正则表达式不能为空";
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `正则表达式过长（最多 ${MAX_PATTERN_LENGTH} 个字符）`;
  }
  if (hasUnsafeQuantifierNesting(pattern)) {
    return "检测到嵌套重复量词，可能导致终端卡顿，请简化正则表达式";
  }
  try {
    new RegExp(pattern, "g");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "无效正则表达式";
  }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
  if (!m) return null;
  return [
    Number.parseInt(m[1], 16),
    Number.parseInt(m[2], 16),
    Number.parseInt(m[3], 16),
  ];
}

function buildAnsiPrefix(rule: TerminalHighlightRule): string {
  const codes: string[] = [];
  if (rule.bold) codes.push("1");
  if (rule.italic) codes.push("3");
  if (rule.underline) codes.push("4");
  const fg = hexToRgb(rule.foreground);
  if (fg) codes.push(`38;2;${fg[0]};${fg[1]};${fg[2]}`);
  if (rule.background) {
    const bg = hexToRgb(rule.background);
    if (bg) codes.push(`48;2;${bg[0]};${bg[1]};${bg[2]}`);
  }
  if (codes.length === 0) return "";
  return `\x1b[${codes.join(";")}m`;
}

interface CompiledRule {
  regex: RegExp;
  ansiPrefix: string;
  rule: TerminalHighlightRule;
}

function compileRules(rules: TerminalHighlightRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  const limit = Math.min(rules.length, MAX_HIGHLIGHT_RULES);
  for (let i = 0; i < limit; i++) {
    const rule = rules[i];
    if (!rule.enabled || !rule.pattern.trim()) continue;
    if (
      rule.pattern.length > MAX_PATTERN_LENGTH ||
      hasUnsafeQuantifierNesting(rule.pattern)
    ) {
      continue;
    }
    const ansiPrefix = buildAnsiPrefix(rule);
    if (!ansiPrefix) continue;
    try {
      const flags = rule.ignoreCase ? "gi" : "g";
      const regex = new RegExp(rule.pattern, flags);
      compiled.push({ regex, ansiPrefix, rule });
    } catch {
      // Skip invalid user regexes safely
    }
  }
  return compiled;
}

interface MatchSpan {
  start: number;
  end: number;
  compiled: CompiledRule;
}

function findNonOverlappingMatches(
  text: string,
  compiled: CompiledRule[],
  deadlineMs?: number
): MatchSpan[] {
  if (!text || compiled.length === 0) return [];
  const matches: MatchSpan[] = [];

  for (const c of compiled) {
    if (deadlineMs !== undefined && performance.now() > deadlineMs) {
      break;
    }
    c.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = c.regex.exec(text)) !== null && guard < 200) {
      guard++;
      if (guard % 16 === 0 && deadlineMs !== undefined && performance.now() > deadlineMs) {
        break;
      }
      const matched = m[0];
      if (!matched) {
        c.regex.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + matched.length;
      let overlaps = false;
      for (const existing of matches) {
        if (start < existing.end && end > existing.start) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        matches.push({ start, end, compiled: c });
      }
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches;
}

interface SgrState {
  fg: boolean;
  bg: boolean;
  reverse: boolean;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function createEmptySgrState(): SgrState {
  return {
    fg: false,
    bg: false,
    reverse: false,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
}

function buildAnsiResetSuffix(rule: TerminalHighlightRule, sgr: SgrState): string {
  const codes: string[] = [];
  if (hexToRgb(rule.foreground)) codes.push("39");
  if (rule.background && hexToRgb(rule.background)) codes.push("49");
  if (rule.bold && !sgr.bold) {
    codes.push("22");
    if (sgr.dim) codes.push("2");
  }
  if (rule.italic && !sgr.italic) codes.push("23");
  if (rule.underline && !sgr.underline) codes.push("24");
  if (codes.length === 0) return "\x1b[39m";
  return `\x1b[${codes.join(";")}m`;
}

function applyCompiledToPlainText(
  text: string,
  compiled: CompiledRule[],
  sgr: SgrState,
  deadlineMs?: number
): string {
  // Skip expensive regex scans on massive raw output bursts to keep terminal at 60fps.
  if (text.length > 16384) return text;
  if (deadlineMs !== undefined && performance.now() > deadlineMs) return text;
  const spans = findNonOverlappingMatches(text, compiled, deadlineMs);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      out += text.slice(cursor, span.start);
    }
    const suffix = buildAnsiResetSuffix(span.compiled.rule, sgr);
    out += `${span.compiled.ansiPrefix}${text.slice(span.start, span.end)}${suffix}`;
    cursor = span.end;
  }
  if (cursor < text.length) {
    out += text.slice(cursor);
  }
  return out;
}

// Matches ANSI CSI, OSC/DCS/APC/PM/SOS string sequences, VT100 charset designation, and 2-byte ESC sequences
const ANSI_TOKEN_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|[()*+][0-9A-Za-z]|[@-Z\\-_])/g;

// Detects an incomplete trailing ESC/CSI/OSC/DCS/APC/PM/SOS/charset sequence at chunk boundary
const TRAILING_PARTIAL_ESC_RE =
  /\x1b(?:\[[0-?]*[ -/]*|[\]P_^X][^\x07\x1b]*\x1b?|[()*+])?$/;

const MAX_CSI_HOLDBACK = 64;
const MAX_OSC_HOLDBACK = 4096;

function isStringSequencePrefix(seq: string): boolean {
  if (seq.length < 2 || seq[0] !== "\x1b") return false;
  const ch = seq[1];
  return ch === "]" || ch === "P" || ch === "_" || ch === "^" || ch === "X";
}

function updateAltScreenState(seq: string, current: boolean): boolean {
  if (seq === "\x1bc") {
    return false;
  }
  if (!seq.startsWith("\x1b[?")) {
    return current;
  }
  const finalChar = seq[seq.length - 1];
  if (finalChar !== "h" && finalChar !== "l") {
    return current;
  }
  const params = seq.slice(3, -1).split(";");
  let next = current;
  for (const p of params) {
    if (p === "47" || p === "1047" || p === "1049") {
      next = finalChar === "h";
    }
  }
  return next;
}

function updateSgrState(seq: string, state: SgrState): SgrState {
  if (seq === "\x1bc") {
    return createEmptySgrState();
  }
  if (!seq.startsWith("\x1b[") || !seq.endsWith("m")) {
    return state;
  }
  const body = seq.slice(2, -1);
  if (body === "" || body === "0") {
    return createEmptySgrState();
  }
  const rawParams = body.split(";");
  const next: SgrState = { ...state };
  for (let i = 0; i < rawParams.length; i++) {
    const raw = rawParams[i];
    if (raw.startsWith("38:")) {
      next.fg = true;
      continue;
    }
    if (raw.startsWith("48:")) {
      next.bg = true;
      continue;
    }
    const p = Number.parseInt(raw || "0", 10);
    if (p === 0) {
      next.fg = false;
      next.bg = false;
      next.reverse = false;
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
    } else if (p === 1) {
      next.bold = true;
    } else if (p === 2) {
      next.dim = true;
    } else if (p === 3) {
      next.italic = true;
    } else if (p === 4) {
      next.underline = true;
    } else if (p === 7) {
      next.reverse = true;
    } else if (p === 22) {
      next.bold = false;
      next.dim = false;
    } else if (p === 23) {
      next.italic = false;
    } else if (p === 24) {
      next.underline = false;
    } else if (p === 27) {
      next.reverse = false;
    } else if (p === 39) {
      next.fg = false;
    } else if (p === 49) {
      next.bg = false;
    } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97) || p === 38) {
      next.fg = true;
      if (p === 38) {
        const mode = Number.parseInt(rawParams[i + 1] || "", 10);
        if (mode === 5) i += 2;
        else if (mode === 2) i += 4;
      }
    } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107) || p === 48) {
      next.bg = true;
      if (p === 48) {
        const mode = Number.parseInt(rawParams[i + 1] || "", 10);
        if (mode === 5) i += 2;
        else if (mode === 2) i += 4;
      }
    }
  }
  return next;
}

/**
 * Stateful streaming ANSI-aware highlighter for xterm.js SSH output.
 * Preserves existing ANSI colors, tracks alternate screen buffer synchronously,
 * and avoids corrupting partial UTF-8 or ESC sequences.
 */
export class TerminalStreamHighlighter {
  private decoder = new TextDecoder("utf-8");
  private pendingEsc = "";
  private sgrState: SgrState = createEmptySgrState();
  private altScreen = false;
  private compiled: CompiledRule[] = [];

  constructor(rules: TerminalHighlightRule[]) {
    this.compiled = compileRules(rules);
  }

  setRules(rules: TerminalHighlightRule[]) {
    this.compiled = compileRules(rules);
  }

  reset() {
    this.decoder = new TextDecoder("utf-8");
    this.pendingEsc = "";
    this.sgrState = createEmptySgrState();
    this.altScreen = false;
  }

  processChunk(bytes: Uint8Array): string {
    const decoded = this.decoder.decode(bytes, { stream: true });
    if (!decoded) return "";
    return this.processText(decoded);
  }

  processText(input: string): string {
    let text = this.pendingEsc + input;
    this.pendingEsc = "";

    // Hold back incomplete ESC sequence at end of chunk (up to 4096 chars for string seqs, 64 for others)
    const partialMatch = TRAILING_PARTIAL_ESC_RE.exec(text);
    if (partialMatch) {
      const limit = isStringSequencePrefix(partialMatch[0])
        ? MAX_OSC_HOLDBACK
        : MAX_CSI_HOLDBACK;
      if (partialMatch[0].length < limit) {
        this.pendingEsc = partialMatch[0];
        text = text.slice(0, partialMatch.index);
      }
    }

    if (!text) return "";
    if (this.compiled.length === 0) return text;

    const deadlineMs = performance.now() + MAX_CHUNK_SCAN_MS;
    ANSI_TOKEN_RE.lastIndex = 0;
    let out = "";
    let lastIdx = 0;
    let m: RegExpExecArray | null;

    const shouldSkip = () =>
      this.altScreen || this.sgrState.fg || this.sgrState.bg || this.sgrState.reverse;

    while ((m = ANSI_TOKEN_RE.exec(text)) !== null) {
      if (m.index > lastIdx) {
        const plain = text.slice(lastIdx, m.index);
        out += shouldSkip()
          ? plain
          : applyCompiledToPlainText(plain, this.compiled, this.sgrState, deadlineMs);
      }
      const seq = m[0];
      this.altScreen = updateAltScreenState(seq, this.altScreen);
      this.sgrState = updateSgrState(seq, this.sgrState);
      out += seq;
      lastIdx = m.index + seq.length;
    }

    if (lastIdx < text.length) {
      const plain = text.slice(lastIdx);
      out += shouldSkip()
        ? plain
        : applyCompiledToPlainText(plain, this.compiled, this.sgrState, deadlineMs);
    }

    return out;
  }
}

export interface PreviewSegment {
  text: string;
  rule?: TerminalHighlightRule;
}

/** Splits a plain preview line into styled spans for Settings UI preview. */
export function highlightPreviewLine(
  line: string,
  rules: TerminalHighlightRule[]
): PreviewSegment[] {
  const compiled = compileRules(rules);
  const spans = findNonOverlappingMatches(line, compiled);
  if (spans.length === 0) return [{ text: line }];

  const segments: PreviewSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({ text: line.slice(cursor, span.start) });
    }
    segments.push({
      text: line.slice(span.start, span.end),
      rule: span.compiled.rule,
    });
    cursor = span.end;
  }
  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor) });
  }
  return segments;
}

export const SAMPLE_PREVIEW_LINES: string[] = [
  "2026-11-21 23:18:04 [INFO] ServerHub worker READY on 192.168.1.42:22",
  "2026-11-21 23:18:05 [OK] Health check PASSED https://api.serverhub.dev/health",
  "2026-11-21 23:18:07 [WARN] Upstream TIMEOUT retrying /etc/nginx/conf.d/app.conf",
  "2026-11-21 23:18:09 [ERROR] HTTP/1.1 502 connection REFUSED (req 550e8400-e29b-41d4-a716-446655440000)",
  "2026-11-21 23:18:11 [INFO] Synced logs to /var/log/serverhub/deploy.log from 10.0.8.15:8080",
];
