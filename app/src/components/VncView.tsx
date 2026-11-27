import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RFB from "@novnc/novnc";
import {
  Keyboard,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { parseCmdError, type CmdError, type Server, type TabStatus, type TerminalTab } from "../types";

interface VncViewProps {
  tab: TerminalTab;
  active: boolean;
  onStatusChange: (
    tabId: string,
    status: TabStatus,
    sessionId?: string | null,
    errorMessage?: string,
    errorKind?: CmdError["kind"]
  ) => void;
  onNeedPassword: (tabId: string, server: Server) => void;
  onReconnect: (tabId: string) => void;
}

export const VncView = memo(function VncView({
  tab,
  active,
  onStatusChange,
  onNeedPassword,
  onReconnect,
}: VncViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const bridgeIdRef = useRef<string | null>(null);
  const authFailedRef = useRef(false);
  const [scaleViewport, setScaleViewport] = useState(true);

  const closeBridge = () => {
    const id = bridgeIdRef.current;
    if (id) {
      bridgeIdRef.current = null;
      void invoke("bridge_close", { bridgeId: id }).catch(() => {});
    }
  };

  useEffect(() => {
    let cancelled = false;
    authFailedRef.current = false;

    const connect = async () => {
      if (!containerRef.current) return;

      let password = tab.password;
      if (password === undefined && tab.server.auth.type !== "ask") {
        const secretKey =
          tab.server.auth.type === "credential" && tab.server.auth.credential_id
            ? `cred:${tab.server.auth.credential_id}`
            : tab.server.id;
        try {
          const saved = await invoke<string | null>("secret_get", {
            id: secretKey,
          });
          if (saved) password = saved;
        } catch {
          // Keyring lookup failed; continue without saved password
        }
      }

      if (cancelled || !containerRef.current) return;

      try {
        const { bridge_id, ws_url } = await invoke<{
          bridge_id: string;
          ws_url: string;
        }>("bridge_open", {
          host: tab.server.host,
          port: tab.server.port,
          protocol: "vnc",
        });

        if (cancelled || !containerRef.current) {
          void invoke("bridge_close", { bridgeId: bridge_id }).catch(() => {});
          return;
        }

        bridgeIdRef.current = bridge_id;

        const rfb = new RFB(containerRef.current, ws_url, {
          credentials: password
            ? {
                username: tab.server.username || "",
                password,
                target: "",
              }
            : undefined,
        });
        rfb.scaleViewport = scaleViewport;
        rfb.resizeSession = false;
        rfbRef.current = rfb;

        rfb.addEventListener("connect", () => {
          if (!cancelled) {
            onStatusChange(tab.tabId, "connected", bridge_id);
            rfb.focus();
          }
        });

        rfb.addEventListener("disconnect", (e: CustomEvent<{ clean: boolean }>) => {
          closeBridge();
          if (!cancelled) {
            if (authFailedRef.current) {
              return;
            }
            if (e.detail.clean) {
              onStatusChange(tab.tabId, "closed", null);
            } else {
              onStatusChange(
                tab.tabId,
                "error",
                null,
                "VNC 连接已断开",
                "connect"
              );
            }
          }
        });

        rfb.addEventListener("credentialsrequired", () => {
          authFailedRef.current = true;
          if (rfbRef.current === rfb) {
            rfbRef.current = null;
          }
          try {
            rfb.disconnect();
          } catch {
            // Ignore disconnect errors
          }
          closeBridge();
          if (!cancelled) {
            onNeedPassword(tab.tabId, tab.server);
            onStatusChange(
              tab.tabId,
              "error",
              null,
              "需要输入 VNC 密码",
              "auth"
            );
          }
        });

        rfb.addEventListener(
          "securityfailure",
          (e: CustomEvent<{ status: number; reason?: string }>) => {
            authFailedRef.current = true;
            if (rfbRef.current === rfb) {
              rfbRef.current = null;
            }
            try {
              rfb.disconnect();
            } catch {
              // Ignore disconnect errors
            }
            closeBridge();
            if (!cancelled) {
              onStatusChange(
                tab.tabId,
                "error",
                null,
                e.detail.reason || `VNC 认证失败 (code ${e.detail.status})`,
                "auth"
              );
              onNeedPassword(tab.tabId, tab.server);
            }
          }
        );
      } catch (err) {
        closeBridge();
        if (!cancelled) {
          const parsed = parseCmdError(err);
          onStatusChange(
            tab.tabId,
            "error",
            null,
            parsed.message,
            parsed.kind
          );
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch {
          // Ignore disconnect errors during teardown
        }
        rfbRef.current = null;
      }
      closeBridge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId, tab.connectNonce]);

  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.scaleViewport = scaleViewport;
      rfbRef.current.resizeSession = false;
    }
  }, [scaleViewport]);

  useEffect(() => {
    if (!active) return;
    const rafId = window.requestAnimationFrame(() => {
      rfbRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [active]);

  return (
    <div
      data-remote-canvas="true"
      className={`relative flex h-full w-full flex-col bg-[#0e1015] ${
        active ? "motion-view-enter flex" : "hidden"
      }`}
    >
      {/* Slim VNC toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 bg-card/80 px-3 text-xs text-muted-foreground">
        <span className="truncate font-mono">
          VNC · {tab.server.host}:{tab.server.port}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setScaleViewport((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground transition hover:opacity-80"
            title={scaleViewport ? "切换为原始分辨率 (1:1)" : "自适应窗口缩放"}
          >
            {scaleViewport ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
            <span>{scaleViewport ? "自适应" : "1:1"}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              rfbRef.current?.sendCtrlAltDel();
              rfbRef.current?.focus();
            }}
            disabled={tab.status !== "connected"}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground transition hover:opacity-80 disabled:opacity-40"
            title="发送 Ctrl+Alt+Del"
          >
            <Keyboard className="h-3 w-3" />
            <span>Ctrl+Alt+Del</span>
          </button>
        </div>
      </div>

      {/* Canvas mount container */}
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-auto"
      />

      {tab.status === "connecting" && (
        <div className="pointer-events-none absolute inset-0 top-9 grid place-items-center bg-black/50 text-sm text-white/80">
          正在连接 VNC {tab.server.host}:{tab.server.port}…
        </div>
      )}

      {(tab.status === "error" || tab.status === "closed") && (
        <div className="absolute inset-0 top-9 grid place-items-center bg-black/70 p-6">
          <div className="max-w-md rounded-2xl border border-border bg-card p-5 text-center shadow-xl">
            <div className="mb-1 text-sm font-semibold text-card-foreground">
              {tab.status === "closed" ? "VNC 会话已结束" : "VNC 连接失败"}
            </div>
            {tab.errorMessage && (
              <div className="mb-4 text-xs text-muted-foreground">
                {tab.errorMessage}
              </div>
            )}
            <button
              type="button"
              onClick={() => onReconnect(tab.tabId)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重新连接
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
