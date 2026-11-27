import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Copy,
  CornerDownLeft,
  Play,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Star,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  assessCommandRisk,
  cancelAiChatStream,
  listAiProfiles,
  startAiChatStream,
  type AiConfigData,
  type ChatMessage,
  type ServerContext,
} from "@/lib/ai";
import { copyToClipboard } from "@/lib/utils";

const MAX_HISTORY_MESSAGES = 24;

interface AiAssistantPanelProps {
  open: boolean;
  serverContext: ServerContext;
  getTerminalTail: () => string;
  getStatsSummary?: () => string | undefined;
  onInsertCommand: (cmd: string) => void;
  onRunCommand: (cmd: string) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRe = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-background/80 px-1 py-0.5 font-mono text-[11px] text-primary ring-1 ring-border/60"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={key++} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else {
      nodes.push(token);
    }
    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls =
        level === 1
          ? "mt-1.5 mb-1 text-[13px] font-semibold text-foreground"
          : level === 2
            ? "mt-1.5 mb-1 text-[12.5px] font-semibold text-foreground"
            : "mt-1 mb-0.5 text-[12px] font-semibold text-foreground/95";
      blocks.push(
        <div key={key++} className={cls}>
          {renderInlineMarkdown(headingMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-1 border-l-2 border-primary/50 pl-2.5 text-[11.5px] text-muted-foreground"
        >
          {quoteLines.map((ql, idx) => (
            <div key={idx}>{renderInlineMarkdown(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1 list-disc space-y-0.5 pl-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-4">
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1 whitespace-pre-wrap leading-relaxed first:mt-0 last:mb-0">
        {paraLines.map((pl, idx) => (
          <span key={idx}>
            {idx > 0 && "\n"}
            {renderInlineMarkdown(pl)}
          </span>
        ))}
      </p>
    );
  }

  return <div className="space-y-0.5">{blocks}</div>;
}

interface ContentSegment {
  type: "text" | "code";
  lang?: string;
  content: string;
}

const SHELL_LANGS = new Set([
  "",
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "fish",
  "powershell",
  "ps1",
  "cmd",
  "bat",
]);

function isShellLanguage(lang?: string): boolean {
  return SHELL_LANGS.has((lang ?? "").trim().toLowerCase());
}

function splitMarkdownSegments(raw: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const regex = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index).trim();
      if (text) segments.push({ type: "text", content: text });
    }
    segments.push({
      type: "code",
      lang: (match[1] || "").toLowerCase(),
      content: match[2].trim(),
    });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex).trim();
    if (tail) segments.push({ type: "text", content: tail });
  }
  return segments;
}

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(code);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopied(false);
    }, 1500);
  };

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/80 bg-background/80">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1 text-[10px]">
        <span className="font-mono uppercase text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          title="复制代码"
          className="motion-press flex items-center gap-0.5 rounded px-1.5 py-0.5 opacity-75 hover:bg-muted hover:opacity-100"
        >
          {copied ? (
            <Check className="motion-pop h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CommandBlock({
  command,
  onInsert,
  onRun,
}: {
  command: string;
  onInsert: (cmd: string) => void;
  onRun: (cmd: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmingDanger, setConfirmingDanger] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const dangerTimerRef = useRef<number | null>(null);
  const risk = assessCommandRisk(command);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      if (dangerTimerRef.current !== null) {
        window.clearTimeout(dangerTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(command);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopied(false);
    }, 1500);
  };

  const handleRunClick = () => {
    if (risk.level === "danger" && !confirmingDanger) {
      setConfirmingDanger(true);
      if (dangerTimerRef.current !== null) {
        window.clearTimeout(dangerTimerRef.current);
      }
      dangerTimerRef.current = window.setTimeout(() => {
        dangerTimerRef.current = null;
        setConfirmingDanger(false);
      }, 4000);
      return;
    }
    if (dangerTimerRef.current !== null) {
      window.clearTimeout(dangerTimerRef.current);
      dangerTimerRef.current = null;
    }
    setConfirmingDanger(false);
    onRun(command);
  };

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/80 bg-background/80">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-2.5 py-1 text-[10px]">
        <div className="flex items-center gap-1.5">
          {risk.level === "safe" && (
            <span className="flex items-center gap-1 text-emerald-500">
              <ShieldCheck className="h-3 w-3" />
              <span>安全</span>
            </span>
          )}
          {risk.level === "caution" && (
            <span
              title={risk.reason}
              className="flex items-center gap-1 text-amber-500"
            >
              <AlertTriangle className="h-3 w-3" />
              <span>注意 · {risk.reason}</span>
            </span>
          )}
          {risk.level === "danger" && (
            <span
              title={risk.reason}
              className="flex items-center gap-1 font-medium text-destructive"
            >
              <ShieldAlert className="h-3 w-3" />
              <span>高危 · {risk.reason}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleCopy()}
            title="复制命令"
            className="motion-press flex items-center gap-0.5 rounded px-1.5 py-0.5 opacity-75 hover:bg-muted hover:opacity-100"
          >
            {copied ? (
              <Check className="motion-pop h-3 w-3 text-emerald-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onInsert(command)}
            title="填入终端（不自动回车）"
            className="motion-press flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 opacity-85 hover:bg-muted/80 hover:opacity-100"
          >
            <CornerDownLeft className="h-3 w-3" />
            <span>填入</span>
          </button>
          <button
            type="button"
            onClick={handleRunClick}
            title={
              risk.level === "danger"
                ? "高危命令，需二次确认后执行"
                : "在终端中直接执行"
            }
            className={`motion-press flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium ${
              confirmingDanger
                ? "motion-shake bg-destructive text-destructive-foreground"
                : risk.level === "danger"
                  ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                  : "bg-primary/15 text-primary hover:bg-primary/25"
            }`}
          >
            <Play className="h-3 w-3" />
            <span>{confirmingDanger ? "确认执行?" : "执行"}</span>
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        <code>{command}</code>
      </pre>
    </div>
  );
}

const QUICK_PROMPTS = [
  {
    label: "诊断最近报错",
    prompt: "请结合当前终端最近输出，分析报错原因并给出修复命令。",
  },
  {
    label: "排查资源占用",
    prompt: "给我一套排查当前服务器 CPU、内存、磁盘 IO 占用的常用命令。",
  },
  {
    label: "查看端口与进程",
    prompt: "如何查看当前监听端口以及对应进程 PID？",
  },
  {
    label: "Docker 状态排查",
    prompt: "给我检查 Docker 容器状态、重启原因和日志的常用命令。",
  },
];

export function AiAssistantPanel({
  open,
  serverContext,
  getTerminalTail,
  getStatsSummary,
  onInsertCommand,
  onRunCommand,
  onClose,
  onOpenSettings,
}: AiAssistantPanelProps) {
  const [config, setConfig] = useState<AiConfigData>({
    default_profile_id: null,
    profiles: [],
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [includeContext, setIncludeContext] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<"运维" | "排障" | "问答">("运维");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilterTab, setModelFilterTab] = useState<"fav" | "all">("all");
  const [favProfileIds, setFavProfileIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("serverhub.ai_fav_profiles.v1");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const streamIdRef = useRef<string | null>(null);
  const pendingDeltaRef = useRef("");
  const deltaRafRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isNearBottomRef = useRef(true);
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null);

  const flushPendingDelta = () => {
    if (deltaRafRef.current !== null) {
      window.cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    const chunk = pendingDeltaRef.current;
    if (!chunk) return;
    pendingDeltaRef.current = "";
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last.role === "assistant") {
        copy[copy.length - 1] = {
          ...last,
          content: last.content + chunk,
        };
      }
      return copy;
    });
  };

  useEffect(() => {
    return () => {
      if (deltaRafRef.current !== null) {
        window.cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
      pendingDeltaRef.current = "";
      if (streamIdRef.current) {
        void cancelAiChatStream(streamIdRef.current).catch(() => {});
        streamIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listAiProfiles()
      .then((data) => {
        if (cancelled) return;
        setConfig(data);
        setSelectedProfileId((prev) => {
          if (prev && data.profiles.some((p) => p.id === prev)) return prev;
          return data.default_profile_id ?? data.profiles[0]?.id ?? "";
        });
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const anyMenuOpen = modeMenuOpen || modelMenuOpen || contextMenuOpen;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const closeMenus = () => {
      setModeMenuOpen(false);
      setModelMenuOpen(false);
      setContextMenuOpen(false);
      mentionRangeRef.current = null;
    };
    window.addEventListener("click", closeMenus);
    return () => window.removeEventListener("click", closeMenus);
  }, [anyMenuOpen]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming]);

  const activeProfile = useMemo(
    () =>
      config.profiles.find((p) => p.id === selectedProfileId) ??
      config.profiles[0] ??
      null,
    [config.profiles, selectedProfileId]
  );

  const validFavProfileIds = useMemo(
    () =>
      favProfileIds.filter((id) => config.profiles.some((p) => p.id === id)),
    [favProfileIds, config.profiles]
  );

  const visibleProfiles = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return config.profiles.filter((p) => {
      if (modelFilterTab === "fav" && !validFavProfileIds.includes(p.id)) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q)
      );
    });
  }, [config.profiles, modelFilterTab, validFavProfileIds, modelSearch]);

  const toggleFavProfile = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setFavProfileIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((item) => item !== id)
        : [...prev, id];
      try {
        localStorage.setItem("serverhub.ai_fav_profiles.v1", JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  };

  if (!open) return null;

  const dropEmptyTrailingAssistant = () => {
    setMessages((prev) => {
      if (
        prev.length > 0 &&
        prev[prev.length - 1].role === "assistant" &&
        !prev[prev.length - 1].content
      ) {
        return prev.slice(0, -1);
      }
      return prev;
    });
  };

  const sendMessage = async (textOverride?: string) => {
    const content = (textOverride ?? input).trim();
    if (!content || streaming) return;

    setErrorText(null);
    if (!textOverride) setInput("");
    isNearBottomRef.current = true;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content },
    ];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setStreaming(true);

    const streamId = crypto.randomUUID();
    streamIdRef.current = streamId;

    const hasTerminalMention = content.includes("@terminal");
    const hasServerMention = content.includes("@server");
    const latestStatsSummary =
      getStatsSummary?.() ?? serverContext.stats_summary;
    const ctx: ServerContext = {
      server_name: serverContext.server_name,
      os: serverContext.os,
      ...(includeContext || hasServerMention
        ? {
            host: serverContext.host,
            port: serverContext.port,
            username: serverContext.username,
            stats_summary: latestStatsSummary,
          }
        : {}),
      ...(includeContext || hasTerminalMention
        ? {
            terminal_tail: getTerminalTail(),
          }
        : {}),
    };

    try {
      await startAiChatStream({
        streamId,
        profileId: selectedProfileId || null,
        messages: nextMessages.slice(-MAX_HISTORY_MESSAGES),
        context: ctx,
        onEvent: (ev) => {
          if (streamIdRef.current !== streamId) return;
          if (ev.event === "delta") {
            pendingDeltaRef.current += ev.data;
            if (deltaRafRef.current === null) {
              deltaRafRef.current = window.requestAnimationFrame(() => {
                deltaRafRef.current = null;
                flushPendingDelta();
              });
            }
          } else if (ev.event === "done") {
            flushPendingDelta();
            setStreaming(false);
            streamIdRef.current = null;
          } else if (ev.event === "error") {
            flushPendingDelta();
            setStreaming(false);
            streamIdRef.current = null;
            dropEmptyTrailingAssistant();
            setErrorText(ev.data);
          }
        },
      });
    } catch (err) {
      if (streamIdRef.current !== streamId) return;
      flushPendingDelta();
      setStreaming(false);
      streamIdRef.current = null;
      dropEmptyTrailingAssistant();
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setErrorText(msg);
    }
  };

  const handleSubmitInput = () => {
    if (streaming) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const prefix =
      composerMode === "排障"
        ? "[排障模式] "
        : composerMode === "问答"
          ? "[仅解答不改机] "
          : "";
    setInput("");
    void sendMessage(prefix ? `${prefix}${trimmed}` : trimmed);
  };

  const handleStop = () => {
    flushPendingDelta();
    if (streamIdRef.current) {
      void cancelAiChatStream(streamIdRef.current).catch(() => {});
      streamIdRef.current = null;
    }
    setStreaming(false);
    dropEmptyTrailingAssistant();
  };

  const handleClearMessages = () => {
    if (deltaRafRef.current !== null) {
      window.cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    pendingDeltaRef.current = "";
    if (streamIdRef.current) {
      void cancelAiChatStream(streamIdRef.current).catch(() => {});
      streamIdRef.current = null;
    }
    setStreaming(false);
    setMessages([]);
    setErrorText(null);
  };

  return (
    <aside className="motion-drawer-right flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-card/95 backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Bot className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-xs font-semibold">AI 运维助手</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClearMessages}
              title="清空对话"
              className="rounded-md p-1 opacity-60 transition hover:bg-muted hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              title="配置 AI 模型"
              className="rounded-md p-1 opacity-60 transition hover:bg-muted hover:opacity-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="关闭 AI 面板"
            className="rounded-md p-1 opacity-60 transition hover:bg-muted hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          isNearBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
        }}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-xs"
      >
        {messages.length === 0 ? (
          <div className="space-y-3 pt-2">
            <div className="rounded-xl bg-muted/50 p-3 text-[11px] leading-relaxed opacity-80">
              输入自然语言即可生成 Linux/Docker/Nginx 命令，或分析当前终端报错。所有高危命令在执行前都会要求二次确认。
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium opacity-55">快捷提问</div>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => void sendMessage(q.prompt)}
                    className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] transition hover:border-primary/50 hover:text-primary"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div
              key={idx}
              className={`motion-msg-enter flex flex-col ${
                msg.role === "user" ? "items-end" : "items-start"
              }`}
            >
              <div
                className={`max-w-[94%] rounded-2xl px-3 py-2 leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 text-foreground"
                }`}
              >
                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                ) : (
                  <div>
                    {msg.content ? (
                      splitMarkdownSegments(msg.content).map((seg, sIdx) =>
                        seg.type === "code" ? (
                          isShellLanguage(seg.lang) ? (
                            <CommandBlock
                              key={sIdx}
                              command={seg.content}
                              onInsert={onInsertCommand}
                              onRun={onRunCommand}
                            />
                          ) : (
                            <CodeBlock
                              key={sIdx}
                              lang={seg.lang}
                              code={seg.content}
                            />
                          )
                        ) : (
                          <MarkdownText key={sIdx} content={seg.content} />
                        )
                      )
                    ) : streaming && idx === messages.length - 1 ? (
                      <span className="inline-flex items-center gap-1.5 py-0.5 text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <span
                            className="motion-typing-dot h-1.5 w-1.5 rounded-full bg-primary/80"
                            style={{ animationDelay: "0ms" }}
                          />
                          <span
                            className="motion-typing-dot h-1.5 w-1.5 rounded-full bg-primary/80"
                            style={{ animationDelay: "160ms" }}
                          />
                          <span
                            className="motion-typing-dot h-1.5 w-1.5 rounded-full bg-primary/80"
                            style={{ animationDelay: "320ms" }}
                          />
                        </span>
                        <span className="text-[11px]">正在思考</span>
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {errorText && (
          <div className="motion-banner-enter motion-shake rounded-xl bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {errorText}
          </div>
        )}
      </div>

      {/* Modern AI Composer Card */}
      <div className="p-2.5 pt-1.5">
        <section className="relative rounded-[20px] border border-border/80 bg-background/90 p-3 shadow-[0_8px_24px_rgb(0_0_0/0.08)] transition-colors focus-within:border-primary/60">
          {/* @ Context Mention Popover */}
          {contextMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="motion-popover-up origin-bottom-left absolute bottom-[calc(100%+6px)] left-3 z-40 w-52 rounded-[16px] border border-border bg-card/95 p-1.5 shadow-xl backdrop-blur-xl"
            >
              <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                插入上下文
              </div>
              {[
                { tag: "@terminal", desc: "最近终端输出" },
                { tag: "@server", desc: serverContext.server_name || "当前主机" },
              ].map((item) => (
                <button
                  key={item.tag}
                  type="button"
                  onClick={() => {
                    if (item.tag === "@terminal") setIncludeContext(true);
                    const range = mentionRangeRef.current;
                    mentionRangeRef.current = null;
                    setContextMenuOpen(false);
                    let next = "";
                    let nextCursor: number | null = null;
                    if (
                      range &&
                      range.start >= 0 &&
                      range.end <= input.length &&
                      input.slice(range.start, range.end) === "@"
                    ) {
                      next = `${input.slice(0, range.start)}${item.tag} ${input.slice(range.end)}`;
                      nextCursor = range.start + item.tag.length + 1;
                    } else {
                      next = input.replace(/@$/, `${item.tag} `);
                    }
                    setInput(next);
                    window.setTimeout(() => {
                      const el = inputRef.current;
                      if (!el) return;
                      el.focus();
                      if (nextCursor !== null) {
                        el.setSelectionRange(nextCursor, nextCursor);
                      }
                    }, 0);
                  }}
                  className="flex w-full items-center justify-between rounded-[10px] px-2.5 py-1.5 text-left text-[12px] transition hover:bg-muted"
                >
                  <span className="font-medium text-foreground">{item.tag}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {item.desc}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Prompt Textarea */}
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => {
              const val = e.target.value;
              setInput(val);
              const cursor = e.target.selectionStart ?? val.length;
              const beforeCursor = val.slice(0, cursor);
              if (/(?:^|\s)@$/.test(beforeCursor)) {
                mentionRangeRef.current = { start: cursor - 1, end: cursor };
                setContextMenuOpen(true);
              } else {
                mentionRangeRef.current = null;
                setContextMenuOpen(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmitInput();
              }
            }}
            placeholder="输入需求，例如：查 8080 端口占用（@ 插入上下文）"
            className="mb-2.5 max-h-28 w-full resize-none bg-transparent text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/75"
          />

          {/* Bottom Controls Bar */}
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {/* 1. Terminal Context Toggle Pill */}
              <button
                type="button"
                onClick={() => setIncludeContext((v) => !v)}
                title={includeContext ? "已附带终端输出上下文" : "点击附带终端输出"}
                className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition ${
                  includeContext
                    ? "border-primary/40 bg-primary/12 text-primary"
                    : "border-border/70 bg-muted/70 text-muted-foreground hover:text-foreground"
                }`}
              >
                <Terminal className="h-3 w-3" />
                <span>终端</span>
              </button>

              {/* 2. Mode Selector Pill */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setModelMenuOpen(false);
                    setContextMenuOpen(false);
                    setModeMenuOpen((v) => !v);
                  }}
                  className="motion-press inline-flex h-7 items-center gap-1 rounded-full border border-border/70 bg-muted/70 px-2.5 text-[11px] font-medium text-foreground hover:bg-muted"
                >
                  <span>{composerMode}</span>
                  <ChevronDown
                    className={`h-3 w-3 opacity-65 transition-transform duration-200 [transition-timing-function:var(--ease-apple)] ${
                      modeMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {modeMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="motion-popover-up origin-bottom-left absolute bottom-[calc(100%+6px)] left-0 z-40 w-32 rounded-[14px] border border-border bg-card/95 p-1 shadow-xl backdrop-blur-xl"
                  >
                    {(["运维", "排障", "问答"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setComposerMode(m);
                          setModeMenuOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-[9px] px-2.5 py-1.5 text-[12px] font-medium transition hover:bg-muted"
                      >
                        <span>{m}</span>
                        {composerMode === m && <Check className="h-3.5 w-3.5 text-primary" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Model Selector Trigger & Popover */}
              <div className="relative min-w-0 flex-1">
                {config.profiles.length > 0 && activeProfile ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setModeMenuOpen(false);
                      setContextMenuOpen(false);
                      setModelSearch("");
                      setModelMenuOpen((v) => !v);
                    }}
                    title={`${activeProfile.name} (${activeProfile.model})`}
                    className="inline-flex h-7 max-w-full items-center gap-1 rounded-full px-2 text-[11px] font-medium text-foreground transition hover:bg-muted/80"
                  >
                    <Sparkles className="h-3 w-3 shrink-0 text-primary" />
                    <span className="truncate">{activeProfile.model || activeProfile.name}</span>
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 opacity-60 transition-transform duration-200 [transition-timing-function:var(--ease-apple)] ${
                        modelMenuOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="motion-press inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-primary hover:bg-primary/10"
                  >
                    <span>+ 添加模型</span>
                  </button>
                )}

                {modelMenuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="motion-popover-up origin-bottom-right absolute bottom-[calc(100%+6px)] right-0 z-40 w-60 rounded-[16px] border border-border bg-card/95 p-2 shadow-2xl backdrop-blur-xl"
                  >
                    <div className="mb-1.5 flex items-center gap-1.5 rounded-[10px] bg-muted/70 px-2.5 h-7">
                      <Search className="h-3 w-3 shrink-0 opacity-55" />
                      <input
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder="搜索模型..."
                        className="w-full bg-transparent text-[11.5px] outline-none placeholder:text-muted-foreground"
                      />
                    </div>

                    <div className="mb-1.5 grid grid-cols-2 rounded-full bg-muted/70 p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setModelFilterTab("fav")}
                        className={`flex items-center justify-center gap-1 rounded-full py-0.5 font-medium transition ${
                          modelFilterTab === "fav"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Star className="h-2.5 w-2.5" />
                        <span>收藏 ({validFavProfileIds.length})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setModelFilterTab("all")}
                        className={`flex items-center justify-center gap-1 rounded-full py-0.5 font-medium transition ${
                          modelFilterTab === "all"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <span>全部 ({config.profiles.length})</span>
                      </button>
                    </div>

                    <div className="max-h-44 space-y-0.5 overflow-y-auto">
                      {visibleProfiles.length === 0 ? (
                        <div className="py-3 text-center text-[11px] text-muted-foreground">
                          {modelFilterTab === "fav"
                            ? "暂无收藏模型，可切换到「全部」点星标"
                            : "无匹配模型"}
                        </div>
                      ) : (
                        visibleProfiles.map((p) => {
                          const selected = p.id === activeProfile?.id;
                          const starred = favProfileIds.includes(p.id);
                          return (
                            <div
                              key={p.id}
                              onClick={() => {
                                setSelectedProfileId(p.id);
                                setModelMenuOpen(false);
                              }}
                              className="flex cursor-pointer items-center justify-between gap-1.5 rounded-[10px] px-2 py-1.5 text-[11.5px] transition hover:bg-muted"
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={(e) => toggleFavProfile(e, p.id)}
                                  className={`shrink-0 transition ${
                                    starred
                                      ? "text-amber-400"
                                      : "text-muted-foreground/50 hover:text-amber-400"
                                  }`}
                                  title={starred ? "取消收藏" : "收藏模型"}
                                >
                                  <Star
                                    className="h-3 w-3"
                                    fill={starred ? "currentColor" : "none"}
                                  />
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium text-foreground">
                                    {p.name}
                                  </div>
                                  <div className="truncate text-[10px] text-muted-foreground">
                                    {p.model}
                                  </div>
                                </div>
                              </div>
                              {selected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                            </div>
                          );
                        })
                      )}
                    </div>

                    {onOpenSettings && (
                      <button
                        type="button"
                        onClick={() => {
                          setModelMenuOpen(false);
                          onOpenSettings();
                        }}
                        className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-[10px] border border-border/70 py-1 text-[11px] font-medium text-primary transition hover:bg-muted"
                      >
                        <Settings className="h-3 w-3" />
                        <span>管理 / 添加模型</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 4. Submit / Stop Round Pill Button */}
            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                title="停止生成"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive transition hover:bg-destructive/25"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!input.trim()}
                onClick={handleSubmitInput}
                title="发送"
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full transition ${
                  input.trim()
                    ? "bg-primary text-primary-foreground shadow-sm hover:opacity-90 active:scale-95"
                    : "bg-muted text-muted-foreground opacity-50"
                }`}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}
