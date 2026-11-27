import { memo, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Keyboard,
  RotateCw,
  X,
} from "lucide-react";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/settings";
import { formatShortcutLabel, matchesShortcut } from "@/lib/shortcuts";
import { TerminalStreamHighlighter } from "@/lib/terminalHighlight";
import {
  isLightHexColor,
  resolveTerminalTheme,
  toXtermTheme,
} from "@/lib/terminalTheme";
import { isDark } from "@/lib/theme";
import { copyToClipboard } from "@/lib/utils";
import { AiAssistantPanel } from "./AiAssistantPanel";
import {
  buildSshAuthPayload,
  parseCmdError,
  type CmdError,
  type Server,
  type TabStatus,
  type TerminalTab,
} from "../types";

type TermEvent =
  | { event: "data"; data: number[] }
  | { event: "exit"; data: number | null }
  | { event: "closed" };

interface TerminalViewProps {
  tab: TerminalTab;
  active: boolean;
  settings?: AppSettings;
  getStatsSummary?: (serverId: string) => string | undefined;
  onStatusChange: (
    tabId: string,
    status: TabStatus,
    sessionId?: string | null,
    errorMessage?: string,
    errorKind?: CmdError["kind"]
  ) => void;
  onHostKeyUnknown: (tabId: string, hostPort: string, fingerprint: string) => void;
  onNeedPassword: (tabId: string, server: Server) => void;
  onReconnect: (tabId: string) => void;
  onOpenSettings?: () => void;
}

function sanitizeForTerminalBanner(text: string): string {
  return text
    .replace(
      /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g,
      ""
    )
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function collapseMultilineForPlainPaste(command: string): string {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      out = line;
      continue;
    }
    if (out.endsWith("\\")) {
      out = `${out.slice(0, -1).trimEnd()} ${line}`;
    } else if (/(?:^|\s)(?:then|do|else|\{|\(|&&|\|\||\|)|;$/.test(out)) {
      out = `${out} ${line}`;
    } else {
      out = `${out}; ${line}`;
    }
  }
  return out;
}

export const TerminalView = memo(function TerminalView({
  tab,
  active,
  settings = DEFAULT_SETTINGS,
  getStatsSummary,
  onStatusChange,
  onHostKeyUnknown,
  onNeedPassword,
  onReconnect,
  onOpenSettings,
}: TerminalViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const zebraOverlayRef = useRef<HTMLDivElement | null>(null);
  const highlighterRef = useRef<TerminalStreamHighlighter>(
    new TerminalStreamHighlighter(settings.terminalHighlightRules)
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const highlightEnabledRef = useRef(settings.terminalHighlightEnabled);
  highlightEnabledRef.current = settings.terminalHighlightEnabled;
  const zebraEnabledRef = useRef(settings.terminalZebraStripes);
  zebraEnabledRef.current = settings.terminalZebraStripes;
  const themeConfigRef = useRef({
    themeId: settings.terminalThemeId,
    customTheme: settings.terminalCustomTheme,
  });
  themeConfigRef.current = {
    themeId: settings.terminalThemeId,
    customTheme: settings.terminalCustomTheme,
  };
  const shortcutsRef = useRef(settings.terminalShortcuts);
  shortcutsRef.current = settings.terminalShortcuts;
  const defaultFontSizeRef = useRef(settings.terminalFontSize);
  defaultFontSizeRef.current = settings.terminalFontSize;
  const prevGlobalFontSizeRef = useRef(settings.terminalFontSize);

  const [resolvedBg, setResolvedBg] = useState<string>(
    () =>
      resolveTerminalTheme(
        settings.terminalThemeId,
        settings.terminalCustomTheme,
        isDark()
      ).background
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [quickInputOpen, setQuickInputOpen] = useState(false);
  const [quickInputValue, setQuickInputValue] = useState("");
  const [quickHistory, setQuickHistory] = useState<string[]>([]);
  const [quickHistoryIdx, setQuickHistoryIdx] = useState(-1);
  const [resettingHostKey, setResettingHostKey] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    highlighterRef.current.reset();
    prevGlobalFontSizeRef.current = defaultFontSizeRef.current;
    const getResolvedScheme = (dark: boolean) =>
      resolveTerminalTheme(
        themeConfigRef.current.themeId,
        themeConfigRef.current.customTheme,
        dark
      );

    const initialScheme = getResolvedScheme(isDark());
    setResolvedBg(initialScheme.background);

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.terminalCursorBlink,
      cursorStyle: settings.terminalCursorStyle,
      scrollback: settings.terminalScrollback,
      macOptionIsMeta: true,
      altClickMovesCursor: true,
      smoothScrollDuration: 100,
      scrollSensitivity: 1.5,
      fontFamily: settings.terminalFontFamily,
      fontSize: settings.terminalFontSize,
      lineHeight: settings.terminalLineHeight,
      theme: toXtermTheme(initialScheme),
    });

    let cachedScreenEl: HTMLElement | null = null;
    let zebraRafId: number | null = null;
    const syncZebraMetricsNow = () => {
      zebraRafId = null;
      if (cancelled || !zebraEnabledRef.current) return;
      const overlay = zebraOverlayRef.current;
      if (!overlay) return;
      if (!cachedScreenEl || !cachedScreenEl.isConnected) {
        cachedScreenEl = container.querySelector<HTMLElement>(".xterm-screen");
      }
      if (!cachedScreenEl || term.rows <= 0) return;
      const rowH = cachedScreenEl.clientHeight / term.rows;
      if (!Number.isFinite(rowH) || rowH <= 0) return;
      const viewportY = term.buffer.active.viewportY;
      const offsetY = -((viewportY % 2) * rowH);
      overlay.style.top = `${cachedScreenEl.offsetTop}px`;
      overlay.style.left = `${cachedScreenEl.offsetLeft}px`;
      overlay.style.width = `${cachedScreenEl.clientWidth}px`;
      overlay.style.height = `${cachedScreenEl.clientHeight}px`;
      overlay.style.backgroundSize = `100% ${(rowH * 2).toFixed(3)}px`;
      overlay.style.backgroundPosition = `0px ${offsetY.toFixed(3)}px`;
    };
    const syncZebraMetrics = () => {
      if (!zebraEnabledRef.current || zebraRafId !== null) return;
      zebraRafId = window.requestAnimationFrame(syncZebraMetricsNow);
    };

    const themeObserver = new MutationObserver(() => {
      const next = getResolvedScheme(isDark());
      term.options.theme = toXtermTheme(next);
      setResolvedBg(next.background);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        void openUrl(parsed.toString()).catch(() => {});
      } catch {
        // Ignore malformed URIs
      }
    });

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    // Compensate xterm.js mouse/selection coordinates if CSS zoom/transform scaling is active
    // (when native WebView zoom is active, rect.width === offsetWidth so scale === 1 and this is a no-op).
    const coreMouse = (
      term as unknown as {
        _core?: {
          _mouseService?: {
            getCoords?: (
              event: MouseEvent,
              element: HTMLElement,
              colCount: number,
              rowCount: number,
              isSelection?: boolean
            ) => [number, number] | undefined;
            getMouseReportCoords?: (
              event: MouseEvent,
              element: HTMLElement
            ) => { col: number; row: number; x: number; y: number } | undefined;
          };
        };
      }
    )._core?._mouseService;

    if (coreMouse) {
      const adjustMouseEvent = (ev: MouseEvent, el: HTMLElement): MouseEvent => {
        if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return ev;
        const rect = el.getBoundingClientRect();
        const scaleX = rect.width / el.offsetWidth;
        const scaleY = rect.height / el.offsetHeight;
        if (Math.abs(scaleX - 1) <= 0.005 && Math.abs(scaleY - 1) <= 0.005) {
          return ev;
        }
        const adjX = rect.left + (ev.clientX - rect.left) / scaleX;
        const adjY = rect.top + (ev.clientY - rect.top) / scaleY;
        return new Proxy(ev, {
          get(target, prop, receiver) {
            if (prop === "clientX") return adjX;
            if (prop === "clientY") return adjY;
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      };

      if (typeof coreMouse.getCoords === "function") {
        const origGetCoords = coreMouse.getCoords.bind(coreMouse);
        coreMouse.getCoords = (ev, el, colCount, rowCount, isSelection) =>
          origGetCoords(adjustMouseEvent(ev, el), el, colCount, rowCount, isSelection);
      }
      if (typeof coreMouse.getMouseReportCoords === "function") {
        const origGetReport = coreMouse.getMouseReportCoords.bind(coreMouse);
        coreMouse.getMouseReportCoords = (ev, el) =>
          origGetReport(adjustMouseEvent(ev, el), el);
      }
    }

    fitAddon.fit();
    syncZebraMetrics();
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const scrollDisposable = term.onScroll(() => {
      syncZebraMetrics();
    });

    let resizeRafId: number | null = null;
    let resizeIpcTimer: number | null = null;
    lastSentSizeRef.current = { cols: 0, rows: 0 };

    const sendRemoteResize = () => {
      resizeIpcTimer = null;
      const sid = sessionIdRef.current;
      if (sid && term.cols > 0 && term.rows > 0) {
        if (
          term.cols === lastSentSizeRef.current.cols &&
          term.rows === lastSentSizeRef.current.rows
        ) {
          return;
        }
        lastSentSizeRef.current = { cols: term.cols, rows: term.rows };
        invoke("ssh_resize", {
          id: sid,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      }
    };

    const resizeRemote = (immediateIpc = false) => {
      fitAddon.fit();
      syncZebraMetrics();
      if (immediateIpc) {
        if (resizeIpcTimer !== null) {
          window.clearTimeout(resizeIpcTimer);
          resizeIpcTimer = null;
        }
        sendRemoteResize();
      } else {
        if (resizeIpcTimer !== null) {
          window.clearTimeout(resizeIpcTimer);
        }
        resizeIpcTimer = window.setTimeout(sendRemoteResize, 60);
      }
    };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.isComposing || ev.keyCode === 229) return true;
      const sc = shortcutsRef.current;

      if (matchesShortcut(ev, sc.clearScreen)) {
        ev.preventDefault();
        ev.stopPropagation();
        term.clear();
        return false;
      }
      if (matchesShortcut(ev, sc.copySelection)) {
        if (term.hasSelection()) {
          ev.preventDefault();
          ev.stopPropagation();
          void copyToClipboard(term.getSelection());
          return false;
        }
        return true;
      }
      if (matchesShortcut(ev, sc.pasteClipboard)) {
        if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
          ev.preventDefault();
          ev.stopPropagation();
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => {});
          return false;
        }
        return true;
      }
      if (matchesShortcut(ev, sc.selectAll)) {
        ev.preventDefault();
        ev.stopPropagation();
        term.selectAll();
        return false;
      }
      if (matchesShortcut(ev, sc.toggleQuickInput)) {
        ev.preventDefault();
        ev.stopPropagation();
        setQuickInputOpen((prev) => {
          const next = !prev;
          window.setTimeout(() => {
            if (next) quickInputRef.current?.focus();
            else term.focus();
          }, 0);
          return next;
        });
        return false;
      }
      if (matchesShortcut(ev, sc.findInTerminal)) {
        ev.preventDefault();
        ev.stopPropagation();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
        return false;
      }
      if (matchesShortcut(ev, sc.toggleAiAssistant)) {
        ev.preventDefault();
        ev.stopPropagation();
        setAiOpen((prev) => !prev);
        return false;
      }
      if (matchesShortcut(ev, sc.zoomIn)) {
        ev.preventDefault();
        ev.stopPropagation();
        const next = Math.min(24, (term.options.fontSize ?? 13) + 1);
        term.options.fontSize = next;
        resizeRemote();
        return false;
      }
      if (matchesShortcut(ev, sc.zoomOut)) {
        ev.preventDefault();
        ev.stopPropagation();
        const next = Math.max(10, (term.options.fontSize ?? 13) - 1);
        term.options.fontSize = next;
        resizeRemote();
        return false;
      }
      if (matchesShortcut(ev, sc.zoomReset)) {
        ev.preventDefault();
        ev.stopPropagation();
        term.options.fontSize = defaultFontSizeRef.current;
        resizeRemote();
        return false;
      }
      return true;
    });

    term.writeln(
      `\x1b[90m正在连接 ${sanitizeForTerminalBanner(tab.server.username)}@${sanitizeForTerminalBanner(tab.server.host)}:${tab.server.port}...\x1b[0m`
    );

    let wasHighlightEnabled = highlightEnabledRef.current;
    const onEvent = new Channel<TermEvent>();
    onEvent.onmessage = (msg) => {
      if (cancelled) return;
      if (msg.event === "data") {
        const bytes = new Uint8Array(msg.data);
        if (highlightEnabledRef.current) {
          wasHighlightEnabled = true;
          const transformed = highlighterRef.current.processChunk(bytes);
          if (transformed) {
            term.write(transformed);
          }
        } else {
          if (wasHighlightEnabled) {
            highlighterRef.current.reset();
            wasHighlightEnabled = false;
          }
          term.write(bytes);
        }
      } else if (msg.event === "exit") {
        term.writeln(
          `\r\n\x1b[33m[远端进程退出，退出码: ${msg.data ?? "未知"}]\x1b[0m`
        );
      } else if (msg.event === "closed") {
        term.writeln("\r\n\x1b[90m[SSH 会话已关闭]\x1b[0m");
        sessionIdRef.current = null;
        onStatusChange(tab.tabId, "closed", null);
      }
    };

    const dataDisposable = term.onData((data) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      invoke("ssh_write", { id: sid, data }).catch(() => {});
    });

    const auth = buildSshAuthPayload(tab.server.auth, {
      password: tab.password,
      passphrase: tab.passphrase,
    });

    invoke<string>("ssh_open", {
      cfg: {
        server_id: tab.server.id,
        host: tab.server.host,
        port: tab.server.port,
        username: tab.server.username,
        auth,
        auth_priority:
          tab.server.auth_priority && tab.server.auth_priority.length > 0
            ? tab.server.auth_priority
            : settings.defaultAuthPriority,
        timeout_secs: tab.server.timeout_secs ?? settings.defaultTimeoutSecs,
        keepalive_secs:
          tab.server.keepalive_secs ?? settings.defaultKeepaliveSecs,
        jump_hosts: tab.server.jump_hosts ?? [],
        term_type:
          tab.server.term_type || settings.defaultTermType || "xterm-256color",
        accept_host_key: tab.acceptHostKey ?? null,
      },
      cols: term.cols || 80,
      rows: term.rows || 24,
      onEvent,
    })
      .then((sid) => {
        if (cancelled) {
          invoke("ssh_close", { id: sid }).catch(() => {});
          return;
        }
        sessionIdRef.current = sid;
        onStatusChange(tab.tabId, "connected", sid);
        resizeRemote(true);
        term.focus();
      })
      .catch((rawErr) => {
        if (cancelled) return;
        const err = parseCmdError(rawErr);
        if (err.kind === "host_key_unknown" && err.fingerprint) {
          term.writeln(`\r\n\x1b[33m[等待确认服务器公钥指纹]\x1b[0m`);
          onStatusChange(tab.tabId, "error", null, err.message, err.kind);
          onHostKeyUnknown(
            tab.tabId,
            err.host || `${tab.server.host}:${tab.server.port}`,
            err.fingerprint
          );
          return;
        }
        if (err.kind === "auth") {
          const promptHint =
            tab.server.auth.type === "ask"
              ? "[每次询问 · 请输入本次登录凭证]"
              : tab.server.auth.type === "keyboard_interactive"
                ? "[需要输入交互式认证密码 / 动态口令]"
                : "[需要输入登录密码或私钥口令]";
          term.writeln(`\r\n\x1b[33m${promptHint}\x1b[0m`);
          onStatusChange(tab.tabId, "error", null, err.message, err.kind);
          onNeedPassword(tab.tabId, tab.server);
          return;
        }
        const msg = formatCmdError(err);
        term.writeln(`\r\n\x1b[31m[连接失败] ${sanitizeForTerminalBanner(msg)}\x1b[0m`);
        onStatusChange(tab.tabId, "error", null, msg, err.kind);
      });

    const observer = new ResizeObserver(() => {
      if (cancelled || resizeRafId !== null) return;
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        if (cancelled) return;
        resizeRemote(false);
      });
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      if (zebraRafId !== null) window.cancelAnimationFrame(zebraRafId);
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      if (resizeIpcTimer !== null) window.clearTimeout(resizeIpcTimer);
      themeObserver.disconnect();
      observer.disconnect();
      scrollDisposable.dispose();
      dataDisposable.dispose();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) {
        invoke("ssh_close", { id: sid }).catch(() => {});
      }
      if (webglAddonRef.current) {
        const addon = webglAddonRef.current;
        webglAddonRef.current = null;
        try {
          addon.dispose();
        } catch {
          // Ignore addon disposal errors during teardown
        }
      }
      term.dispose();
      termRef.current = null;
    };
    // Intentionally keyed by tabId and connectNonce so status updates do not recreate the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId, tab.connectNonce]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (!active) {
      if (webglAddonRef.current) {
        const addon = webglAddonRef.current;
        webglAddonRef.current = null;
        try {
          addon.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
      return;
    }

    if (!webglAddonRef.current) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          if (webglAddonRef.current === webgl) {
            webglAddonRef.current = null;
          }
          try {
            webgl.dispose();
          } catch {
            // Ignore disposal errors
          }
        });
        term.loadAddon(webgl);
        webglAddonRef.current = webgl;
      } catch {
        // Fallback to canvas/DOM renderer silently
      }
    }

    return () => {
      if (webglAddonRef.current) {
        const addon = webglAddonRef.current;
        webglAddonRef.current = null;
        try {
          addon.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
    };
  }, [active, tab.tabId, tab.connectNonce]);

  useEffect(() => {
    highlighterRef.current.setRules(settings.terminalHighlightRules);
  }, [settings.terminalHighlightRules]);

  useEffect(() => {
    const term = termRef.current;
    const scheme = resolveTerminalTheme(
      settings.terminalThemeId,
      settings.terminalCustomTheme,
      isDark()
    );
    setResolvedBg(scheme.background);
    if (term) {
      term.options.theme = toXtermTheme(scheme);
    }
  }, [settings.terminalThemeId, settings.terminalCustomTheme]);

  const syncZebraOverlay = () => {
    const overlay = zebraOverlayRef.current;
    const term = termRef.current;
    const screenEl =
      containerRef.current?.querySelector<HTMLElement>(".xterm-screen");
    if (!overlay || !screenEl || !term || term.rows <= 0) return;
    const rowH = screenEl.clientHeight / term.rows;
    if (!Number.isFinite(rowH) || rowH <= 0) return;
    const offsetY = -((term.buffer.active.viewportY % 2) * rowH);
    overlay.style.top = `${screenEl.offsetTop}px`;
    overlay.style.left = `${screenEl.offsetLeft}px`;
    overlay.style.width = `${screenEl.clientWidth}px`;
    overlay.style.height = `${screenEl.clientHeight}px`;
    overlay.style.backgroundSize = `100% ${(rowH * 2).toFixed(3)}px`;
    overlay.style.backgroundPosition = `0px ${offsetY.toFixed(3)}px`;
  };

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.terminalFontFamily;
    if (settings.terminalFontSize !== prevGlobalFontSizeRef.current) {
      term.options.fontSize = settings.terminalFontSize;
      prevGlobalFontSizeRef.current = settings.terminalFontSize;
    }
    term.options.lineHeight = settings.terminalLineHeight;
    term.options.cursorStyle = settings.terminalCursorStyle;
    term.options.cursorBlink = settings.terminalCursorBlink;
    term.options.scrollback = settings.terminalScrollback;

    if (!activeRef.current || !fitAddonRef.current) return;
    const rafId = window.requestAnimationFrame(() => {
      if (!fitAddonRef.current || !termRef.current) return;
      termRef.current.clearTextureAtlas();
      fitAddonRef.current.fit();
      syncZebraOverlay();
      const sid = sessionIdRef.current;
      const { cols, rows } = termRef.current;
      if (
        sid &&
        cols > 0 &&
        rows > 0 &&
        (cols !== lastSentSizeRef.current.cols ||
          rows !== lastSentSizeRef.current.rows)
      ) {
        lastSentSizeRef.current = { cols, rows };
        invoke("ssh_resize", { id: sid, cols, rows }).catch(() => {});
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [
    settings.uiScale,
    settings.terminalFontFamily,
    settings.terminalFontSize,
    settings.terminalLineHeight,
    settings.terminalCursorStyle,
    settings.terminalCursorBlink,
    settings.terminalScrollback,
    settings.terminalZebraStripes,
  ]);

  useEffect(() => {
    if (!active || !fitAddonRef.current || !termRef.current) return;
    const rafId = window.requestAnimationFrame(() => {
      if (!fitAddonRef.current || !termRef.current) return;
      termRef.current.clearTextureAtlas();
      fitAddonRef.current.fit();
      syncZebraOverlay();
      termRef.current.focus();
      const sid = sessionIdRef.current;
      const { cols, rows } = termRef.current;
      if (
        sid &&
        cols > 0 &&
        rows > 0 &&
        (cols !== lastSentSizeRef.current.cols ||
          rows !== lastSentSizeRef.current.rows)
      ) {
        lastSentSizeRef.current = { cols, rows };
        invoke("ssh_resize", { id: sid, cols, rows }).catch(() => {});
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [active]);

  const closeSearch = () => {
    setSearchOpen(false);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.closest(".fixed.inset-0")) return;
        const isEditable =
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable;
        if (isEditable && !rootRef.current?.contains(target)) {
          return;
        }
      }

      const sc = shortcutsRef.current;
      if (matchesShortcut(e, sc.toggleAiAssistant)) {
        e.preventDefault();
        setAiOpen((prev) => !prev);
        return;
      }
      if (matchesShortcut(e, sc.toggleQuickInput)) {
        e.preventDefault();
        setQuickInputOpen((prev) => {
          const next = !prev;
          window.setTimeout(() => {
            if (next) quickInputRef.current?.focus();
            else termRef.current?.focus();
          }, 0);
          return next;
        });
        return;
      }
      if (matchesShortcut(e, sc.findInTerminal)) {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const closeQuickInput = () => {
    setQuickInputOpen(false);
    setQuickHistoryIdx(-1);
    termRef.current?.focus();
  };

  const submitQuickInput = (execute: boolean) => {
    if (!quickInputValue) return;
    if (tab.status !== "connected" || !sessionIdRef.current) return;
    const text = quickInputValue;
    writeToPty(execute ? `${text}\r` : text);
    setQuickHistory((prev) =>
      prev[0] === text ? prev : [text, ...prev.slice(0, 49)]
    );
    setQuickHistoryIdx(-1);
    setQuickInputValue("");
    if (execute) {
      window.setTimeout(() => quickInputRef.current?.focus(), 0);
    }
  };

  const getTerminalTail = () => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const total = buf.length;
    const start = Math.max(0, total - 80);
    const lines: string[] = [];
    for (let i = start; i < total; i++) {
      const line = buf.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    while (lines.length > 0 && !lines[lines.length - 1].trim()) {
      lines.pop();
    }
    return lines.join("\n");
  };

  const writeToPty = (data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void invoke("ssh_write", { id: sid, data }).catch(console.error);
    termRef.current?.focus();
  };

  const insertCommandIntoTerminal = (cmd: string) => {
    const cleaned = cmd.replace(/[\r\n]+$/, "");
    if (!cleaned) return;
    const term = termRef.current;
    if (term) {
      if (term.modes?.bracketedPasteMode || !/[\r\n]/.test(cleaned)) {
        term.paste(cleaned);
      } else {
        term.paste(collapseMultilineForPlainPaste(cleaned));
      }
      term.focus();
      return;
    }
    writeToPty(collapseMultilineForPlainPaste(cleaned));
  };

  const aiShortcutLabel = formatShortcutLabel(
    settings.terminalShortcuts.toggleAiAssistant
  );
  const quickInputShortcutLabel = formatShortcutLabel(
    settings.terminalShortcuts.toggleQuickInput
  );

  const zebraStripeColor = isLightHexColor(resolvedBg)
    ? "rgba(0, 0, 0, 0.036)"
    : "rgba(255, 255, 255, 0.042)";

  const handleResetHostKeyAndReconnect = async () => {
    if (resettingHostKey) return;
    setResettingHostKey(true);
    try {
      await invoke("known_hosts_remove", {
        hostPort: `${tab.server.host}:${tab.server.port}`,
      });
      onReconnect(tab.tabId);
    } catch (err) {
      const parsed = parseCmdError(err);
      onStatusChange(
        tab.tabId,
        "error",
        null,
        `清除旧指纹失败：${parsed.message}`,
        tab.errorKind
      );
    } finally {
      setResettingHostKey(false);
    }
  };

  return (
    <div
      ref={rootRef}
      style={{ backgroundColor: resolvedBg }}
      className={`relative h-full w-full ${active ? "motion-view-enter flex flex-row" : "hidden"}`}
    >
      <div className="relative flex min-w-0 flex-1 flex-col p-3">
        {(!quickInputOpen || !aiOpen) && (
          <div
            className={`absolute right-4 z-10 flex items-center gap-2 ${
              quickInputOpen ? "bottom-16" : "bottom-4"
            }`}
          >
            {!quickInputOpen && (
              <button
                type="button"
                onClick={() => {
                  setQuickInputOpen(true);
                  window.setTimeout(() => quickInputRef.current?.focus(), 0);
                }}
                title={
                  quickInputShortcutLabel
                    ? `打开快捷输入 (${quickInputShortcutLabel})`
                    : "打开快捷输入"
                }
                className="motion-popover-up motion-press flex items-center gap-1.5 rounded-full border border-border/80 bg-card/90 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:border-primary/60 hover:text-primary hover:shadow-lg"
              >
                <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
                <span>快捷输入</span>
              </button>
            )}
            {!aiOpen && (
              <button
                type="button"
                onClick={() => setAiOpen(true)}
                title={
                  aiShortcutLabel
                    ? `打开 AI 运维助手 (${aiShortcutLabel})`
                    : "打开 AI 运维助手"
                }
                className="motion-popover-up motion-press flex items-center gap-1.5 rounded-full border border-border/80 bg-card/90 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:border-primary/60 hover:text-primary hover:shadow-lg"
              >
                <Bot className="h-3.5 w-3.5 text-primary" />
                <span>AI 助手</span>
              </button>
            )}
          </div>
        )}
      {(tab.status === "error" || tab.status === "closed") && (
        <div
          className={`motion-banner-enter mb-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${
            tab.errorKind === "host_key_mismatch"
              ? "border-red-500/50 bg-red-500/15 text-red-500"
              : tab.status === "error"
                ? "border-red-500/30 bg-red-500/10 text-red-400"
                : "border-zinc-500/30 bg-zinc-500/10 opacity-85"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">
            {tab.errorKind === "host_key_mismatch"
              ? `${tab.errorMessage}。如确认服务器已重装或更换密钥，可点击右侧按钮清除旧指纹并重连。`
              : tab.status === "error"
                ? tab.errorMessage
                : "SSH 连接已断开"}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {tab.status === "error" && tab.errorKind === "host_key_mismatch" && (
              <button
                type="button"
                disabled={resettingHostKey}
                onClick={() => void handleResetHostKeyAndReconnect()}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-red-500 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                <span>{resettingHostKey ? "正在清除..." : "清除旧指纹并重连"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onReconnect(tab.tabId)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-blue-600"
            >
              <RotateCw className="h-3 w-3" />
              <span>重新连接</span>
            </button>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="popover motion-popover-down absolute top-4 right-5 z-20 flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const val = e.target.value;
              setSearchQuery(val);
              if (val) {
                searchAddonRef.current?.findNext(val);
              } else {
                searchAddonRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                closeSearch();
              } else if (e.key === "Enter") {
                if (e.shiftKey) {
                  searchAddonRef.current?.findPrevious(searchQuery);
                } else {
                  searchAddonRef.current?.findNext(searchQuery);
                }
              }
            }}
            placeholder="搜索终端输出..."
            className="w-44 bg-transparent outline-none"
          />
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            title="上一个"
            className="rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            title="下一个"
            className="rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            title="关闭 (Esc)"
            className="rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
        <div
          ref={zebraOverlayRef}
          aria-hidden="true"
          className={`pointer-events-none absolute z-[2] ${
            settings.terminalZebraStripes ? "block" : "hidden"
          }`}
          style={{
            backgroundImage: `linear-gradient(to bottom, transparent 50%, ${zebraStripeColor} 50%)`,
            backgroundRepeat: "repeat-y",
          }}
        />
      </div>

      {quickInputOpen && (
        <div className="motion-popover-up mt-2 flex items-center gap-2 rounded-[14px] border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-md">
          <Keyboard className="h-4 w-4 shrink-0 text-primary" />
          <input
            ref={quickInputRef}
            type="text"
            value={quickInputValue}
            onChange={(e) => {
              setQuickInputValue(e.target.value);
              setQuickHistoryIdx(-1);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape") {
                e.preventDefault();
                closeQuickInput();
              } else if (e.key === "Enter") {
                e.preventDefault();
                submitQuickInput(!e.shiftKey);
              } else if (e.key === "ArrowUp" && quickHistory.length > 0) {
                e.preventDefault();
                const nextIdx = Math.min(quickHistoryIdx + 1, quickHistory.length - 1);
                setQuickHistoryIdx(nextIdx);
                setQuickInputValue(quickHistory[nextIdx]);
              } else if (e.key === "ArrowDown" && quickHistoryIdx >= 0) {
                e.preventDefault();
                const nextIdx = quickHistoryIdx - 1;
                setQuickHistoryIdx(nextIdx);
                setQuickInputValue(nextIdx >= 0 ? quickHistory[nextIdx] : "");
              }
            }}
            placeholder={
              tab.status === "connected"
                ? "输入命令后按 Enter 执行，Shift+Enter 仅填入终端，↑/↓ 切换历史..."
                : "终端未连接，请先重新连接后再发送命令..."
            }
            className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => submitQuickInput(true)}
            disabled={!quickInputValue || tab.status !== "connected"}
            title={
              tab.status !== "connected"
                ? "终端未连接，无法发送"
                : "发送并执行 (Enter)"
            }
            className="motion-press inline-flex h-7 shrink-0 items-center gap-1 rounded-[8px] bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground hover:opacity-92 disabled:opacity-40"
          >
            <CornerDownLeft className="h-3 w-3" />
            <span>发送</span>
          </button>
          <button
            type="button"
            onClick={closeQuickInput}
            title="收起快捷输入 (Esc)"
            className="motion-press inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      </div>

      <AiAssistantPanel
        open={aiOpen}
        serverContext={{
          server_name: tab.server.name,
          host: tab.server.host,
          port: tab.server.port,
          username: tab.server.username,
          os: tab.server.os,
        }}
        getTerminalTail={getTerminalTail}
        getStatsSummary={
          getStatsSummary ? () => getStatsSummary(tab.server.id) : undefined
        }
        onInsertCommand={insertCommandIntoTerminal}
        onRunCommand={(cmd) => writeToPty(`${cmd}\r`)}
        onClose={() => setAiOpen(false)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
});

function formatCmdError(err: CmdError): string {
  if (err.kind === "host_key_mismatch") {
    return `${err.message}（预期: ${err.expected ?? "?"}，实际: ${err.fingerprint ?? "?"}）`;
  }
  if (err.kind === "auth") {
    return `认证失败，请检查用户名、密码或私钥：${err.message}`;
  }
  return err.message;
}
