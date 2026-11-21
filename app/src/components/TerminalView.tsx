import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import {
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
  onStatusChange: (
    tabId: string,
    status: TabStatus,
    sessionId?: string | null,
    errorMessage?: string,
    errorKind?: CmdError["kind"]
  ) => void;
  onHostKeyUnknown: (tabId: string, hostPort: string, fingerprint: string) => void;
  onNeedPassword: (tabId: string, server: Server) => void;
}

export function TerminalView({
  tab,
  active,
  onStatusChange,
  onHostKeyUnknown,
  onNeedPassword,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const getTheme = (dark: boolean) =>
      dark
        ? {
            background: "#1e1e1e",
            foreground: "#f2f2f7",
            cursor: "#0a84ff",
            selectionBackground: "rgba(10, 132, 255, 0.35)",
          }
        : {
            background: "#ffffff",
            foreground: "#1c1c1e",
            cursor: "#007aff",
            selectionBackground: "rgba(0, 122, 255, 0.25)",
          };

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      theme: getTheme(mediaQuery.matches),
    });

    const onThemeChange = (e: MediaQueryListEvent) => {
      term.options.theme = getTheme(e.matches);
    };
    mediaQuery.addEventListener("change", onThemeChange);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // Fallback to canvas/dom renderer silently
    }

    fitAddon.fit();
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln(
      `\x1b[90m正在连接 ${tab.server.username}@${tab.server.host}:${tab.server.port}...\x1b[0m`
    );

    const onEvent = new Channel<TermEvent>();
    onEvent.onmessage = (msg) => {
      if (cancelled) return;
      if (msg.event === "data") {
        term.write(new Uint8Array(msg.data));
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

    const auth =
      tab.server.auth.type === "password"
        ? { type: "password", password: tab.password ?? null }
        : {
            type: "key",
            path: tab.server.auth.path,
            passphrase: tab.passphrase || null,
          };

    invoke<string>("ssh_open", {
      cfg: {
        server_id: tab.server.id,
        host: tab.server.host,
        port: tab.server.port,
        username: tab.server.username,
        auth,
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
        fitAddon.fit();
        invoke("ssh_resize", {
          id: sid,
          cols: term.cols || 80,
          rows: term.rows || 24,
        }).catch(() => {});
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
            `${tab.server.host}:${tab.server.port}`,
            err.fingerprint
          );
          return;
        }
        if (err.kind === "auth" && tab.server.auth.type === "password") {
          term.writeln(`\r\n\x1b[33m[需要输入登录密码]\x1b[0m`);
          onStatusChange(tab.tabId, "error", null, err.message, err.kind);
          onNeedPassword(tab.tabId, tab.server);
          return;
        }
        const msg = formatCmdError(err);
        term.writeln(`\r\n\x1b[31m[连接失败] ${msg}\x1b[0m`);
        onStatusChange(tab.tabId, "error", null, msg, err.kind);
      });

    const observer = new ResizeObserver(() => {
      if (cancelled) return;
      fitAddon.fit();
      const sid = sessionIdRef.current;
      if (sid && term.cols > 0 && term.rows > 0) {
        invoke("ssh_resize", {
          id: sid,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      mediaQuery.removeEventListener("change", onThemeChange);
      observer.disconnect();
      dataDisposable.dispose();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) {
        invoke("ssh_close", { id: sid }).catch(() => {});
      }
      term.dispose();
    };
    // Intentionally keyed by tabId and connectNonce so status updates do not recreate the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId, tab.connectNonce]);

  useEffect(() => {
    if (active && fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit();
      termRef.current.focus();
      const sid = sessionIdRef.current;
      if (sid && termRef.current.cols > 0 && termRef.current.rows > 0) {
        invoke("ssh_resize", {
          id: sid,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }).catch(() => {});
      }
    }
  }, [active]);

  return (
    <div
      className={`h-full w-full p-3 ${active ? "flex flex-col" : "hidden"}`}
    >
      {tab.status === "error" && tab.errorMessage && (
        <div
          className={`mb-2 rounded-lg border px-3 py-2 text-xs ${
            tab.errorKind === "host_key_mismatch"
              ? "border-red-500/50 bg-red-500/15 text-red-500"
              : "border-red-500/30 bg-red-500/10 text-red-400"
          }`}
        >
          {tab.errorKind === "host_key_mismatch"
            ? `${tab.errorMessage}。如确认服务器已重装，请手动编辑或删除应用数据目录下的 known_hosts.json 后重试。`
            : tab.errorMessage}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

function formatCmdError(err: CmdError): string {
  if (err.kind === "host_key_mismatch") {
    return `${err.message}（预期: ${err.expected ?? "?"}，实际: ${err.fingerprint ?? "?"}）`;
  }
  if (err.kind === "auth") {
    return `认证失败，请检查用户名、密码或私钥：${err.message}`;
  }
  return err.message;
}
