import { memo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import init, {
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  IronErrorKind,
  RotationUnit,
  Session,
  SessionBuilder,
} from "ironrdp-wasm";
import { Keyboard, RefreshCw } from "lucide-react";
import { codeToScancode } from "../lib/scancodes";
import {
  parseCmdError,
  type CmdError,
  type Server,
  type TabStatus,
  type TerminalTab,
} from "../types";

interface RdpViewProps {
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

let wasmInitPromise: Promise<unknown> | null = null;
function ensureWasmInit() {
  if (!wasmInitPromise) {
    wasmInitPromise = init().catch((err) => {
      wasmInitPromise = null;
      throw err;
    });
  }
  return wasmInitPromise;
}

function mapMouseButton(button: number): number {
  // DOM: 0=left, 1=middle, 2=right -> IronRDP: 0=left, 1=middle, 2=right
  return button;
}

export const RdpView = memo(function RdpView({
  tab,
  active,
  onStatusChange,
  onNeedPassword,
  onReconnect,
}: RdpViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const bridgeIdRef = useRef<string | null>(null);
  const connectedRef = useRef(tab.status === "connected");
  connectedRef.current = tab.status === "connected";
  const lastDesktopSizeRef = useRef<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const pressedButtonsRef = useRef<Set<number>>(new Set());
  const pendingMousePosRef = useRef<{ x: number; y: number } | null>(null);
  const mouseMoveRafRef = useRef<number | null>(null);

  const cancelPendingMouseMove = () => {
    pendingMousePosRef.current = null;
    if (mouseMoveRafRef.current !== null) {
      window.cancelAnimationFrame(mouseMoveRafRef.current);
      mouseMoveRafRef.current = null;
    }
  };

  const closeBridge = () => {
    const id = bridgeIdRef.current;
    if (id) {
      bridgeIdRef.current = null;
      void invoke("bridge_close", { bridgeId: id }).catch(() => {});
    }
  };

  const syncDesktopSize = () => {
    const session = sessionRef.current;
    const wrap = wrapRef.current;
    if (!session || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) return;
    const width = Math.max(640, Math.floor(rect.width) & ~1);
    const height = Math.max(480, Math.floor(rect.height));
    if (
      width === lastDesktopSizeRef.current.width &&
      height === lastDesktopSizeRef.current.height
    ) {
      return;
    }
    try {
      session.resize(width, height);
      lastDesktopSizeRef.current = { width, height };
    } catch {
      // Ignore resize errors if session is closing
    }
  };

  const releaseAllInputs = () => {
    pressedButtonsRef.current.clear();
    const session = sessionRef.current;
    if (!session) return;
    try {
      session.releaseAllInputs();
    } catch {
      // Ignore if session is already closed
    }
  };

  useEffect(() => {
    let cancelled = false;

    const connect = async () => {
      if (!canvasRef.current || !wrapRef.current) return;

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
          // Ignore keyring errors
        }
      }

      if (cancelled || !canvasRef.current || !wrapRef.current) return;

      if (password === undefined) {
        onNeedPassword(tab.tabId, tab.server);
        onStatusChange(
          tab.tabId,
          "error",
          null,
          "需要输入 RDP 登录密码",
          "auth"
        );
        return;
      }

      try {
        await ensureWasmInit();
        if (cancelled || !canvasRef.current || !wrapRef.current) return;

        const { bridge_id, ws_url } = await invoke<{
          bridge_id: string;
          ws_url: string;
        }>("bridge_open", {
          host: tab.server.host,
          port: tab.server.port,
          protocol: "rdp",
        });

        if (cancelled || !canvasRef.current || !wrapRef.current) {
          void invoke("bridge_close", { bridgeId: bridge_id }).catch(() => {});
          return;
        }

        bridgeIdRef.current = bridge_id;

        const rect = wrapRef.current.getBoundingClientRect();
        const hasVisibleRect = rect.width >= 100 && rect.height >= 100;
        const width = hasVisibleRect
          ? Math.max(640, Math.floor(rect.width) & ~1)
          : 1280;
        const height = hasVisibleRect
          ? Math.max(480, Math.floor(rect.height))
          : 720;
        lastDesktopSizeRef.current = hasVisibleRect
          ? { width, height }
          : { width: 0, height: 0 };

        const builder = new SessionBuilder();
        builder.username(tab.server.username);
        builder.password(password);
        if (tab.server.domain) {
          builder.serverDomain(tab.server.domain);
        }
        builder.destination(`${tab.server.host}:${tab.server.port}`);
        builder.proxyAddress(ws_url);
        builder.desktopSize(new DesktopSize(width, height));
        builder.renderCanvas(canvasRef.current);
        builder.extension(new Extension("enable_credssp", true));

        const session = await builder.connect();
        if (cancelled) {
          session.shutdown();
          closeBridge();
          return;
        }

        sessionRef.current = session;
        onStatusChange(tab.tabId, "connected", bridge_id);
        canvasRef.current.focus();

        const info = await session.run();
        sessionRef.current = null;
        pressedButtonsRef.current.clear();
        cancelPendingMouseMove();
        closeBridge();
        if (!cancelled) {
          onStatusChange(
            tab.tabId,
            "closed",
            null,
            info?.reason?.() || undefined
          );
        }
      } catch (err) {
        sessionRef.current = null;
        pressedButtonsRef.current.clear();
        cancelPendingMouseMove();
        closeBridge();
        if (!cancelled) {
          const parsed = parseCmdError(err);
          let message = parsed.message;
          let kind: CmdError["kind"] = parsed.kind || "connect";
          let isAuthFailure = false;
          if (typeof err === "object" && err !== null && "kind" in err) {
            const ironErr = err as {
              kind?: unknown;
              backtrace?: unknown;
            };
            if (typeof ironErr.kind === "function") {
              const errKind = (ironErr.kind as () => IronErrorKind)();
              if (
                errKind === IronErrorKind.WrongPassword ||
                errKind === IronErrorKind.LogonFailure ||
                errKind === IronErrorKind.AccessDenied
              ) {
                kind = "auth";
                isAuthFailure = true;
                message = "RDP 认证失败，请检查用户名、域名或密码";
              } else if (typeof ironErr.backtrace === "function") {
                const trace = (ironErr.backtrace as () => string)();
                message = trace.split("\n")[0] || message;
              }
            }
          }
          onStatusChange(tab.tabId, "error", null, message, kind);
          if (isAuthFailure) {
            onNeedPassword(tab.tabId, tab.server);
          }
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      pressedButtonsRef.current.clear();
      cancelPendingMouseMove();
      if (sessionRef.current) {
        try {
          sessionRef.current.shutdown();
        } catch {
          // Ignore shutdown errors
        }
        sessionRef.current = null;
      }
      closeBridge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId, tab.connectNonce]);

  const sendInputs = (events: DeviceEvent[]) => {
    const session = sessionRef.current;
    if (!session || !connectedRef.current) return;
    const tx = new InputTransaction();
    for (const ev of events) {
      tx.addEvent(ev);
    }
    try {
      session.applyInputs(tx);
    } catch {
      // Ignore input errors if session is closing
    }
  };

  // Dynamic resolution sync via ResizeObserver (debounced)
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        syncDesktopSize();
      }, 200);
    });
    observer.observe(wrap);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  // Auto-focus canvas and sync resolution when tab becomes active
  useEffect(() => {
    if (!active) return;
    const rafId = window.requestAnimationFrame(() => {
      syncDesktopSize();
      canvasRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [active]);

  // Native non-passive wheel listener (vertical + horizontal + DOM_DELTA_LINE/PAGE/PIXEL)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!sessionRef.current || !connectedRef.current) return;
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? RotationUnit.Line
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? RotationUnit.Page
            : RotationUnit.Pixel;
      const events: DeviceEvent[] = [];
      if (e.deltaY !== 0) {
        const amount = Math.round(-e.deltaY) || Math.sign(-e.deltaY);
        events.push(DeviceEvent.wheelRotations(true, amount, unit));
      }
      if (e.deltaX !== 0) {
        const amount = Math.round(e.deltaX) || Math.sign(e.deltaX);
        events.push(DeviceEvent.wheelRotations(false, amount, unit));
      }
      if (events.length > 0) {
        sendInputs(events);
      }
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release stuck modifier keys / mouse buttons on window blur or mouseup outside canvas
  useEffect(() => {
    const onWindowBlur = () => {
      releaseAllInputs();
    };
    const onWindowMouseUp = (e: MouseEvent) => {
      if (
        pressedButtonsRef.current.has(e.button) &&
        e.target !== canvasRef.current
      ) {
        pressedButtonsRef.current.delete(e.button);
        sendInputs([DeviceEvent.mouseButtonReleased(mapMouseButton(e.button))]);
      }
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: Math.max(0, Math.round((e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.round((e.clientY - rect.top) * scaleY)),
    };
  };

  const sendCtrlAltDel = () => {
    const ctrl = 0x1d;
    const alt = 0x38;
    const del = 0xe053;
    sendInputs([
      DeviceEvent.keyPressed(ctrl),
      DeviceEvent.keyPressed(alt),
      DeviceEvent.keyPressed(del),
      DeviceEvent.keyReleased(del),
      DeviceEvent.keyReleased(alt),
      DeviceEvent.keyReleased(ctrl),
    ]);
    canvasRef.current?.focus();
  };

  return (
    <div
      data-remote-canvas="true"
      className={`relative flex h-full w-full flex-col bg-[#0e1015] ${
        active ? "motion-view-enter flex" : "hidden"
      }`}
    >
      {/* Slim RDP toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 bg-card/80 px-3 text-xs text-muted-foreground">
        <span className="truncate font-mono">
          RDP · {tab.server.username}@{tab.server.host}:{tab.server.port}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={sendCtrlAltDel}
            disabled={tab.status !== "connected"}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-foreground transition hover:opacity-80 disabled:opacity-40"
            title="发送 Ctrl+Alt+Del"
          >
            <Keyboard className="h-3 w-3" />
            <span>Ctrl+Alt+Del</span>
          </button>
        </div>
      </div>

      {/* Canvas wrapper */}
      <div
        ref={wrapRef}
        className="relative grid min-h-0 flex-1 place-items-center overflow-auto bg-black"
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="max-h-full max-w-full outline-none"
          onBlur={() => {
            cancelPendingMouseMove();
            releaseAllInputs();
          }}
          onMouseMove={(e) => {
            if (!connectedRef.current) return;
            pendingMousePosRef.current = toCanvasCoords(e);
            if (mouseMoveRafRef.current === null) {
              mouseMoveRafRef.current = window.requestAnimationFrame(() => {
                mouseMoveRafRef.current = null;
                const pos = pendingMousePosRef.current;
                pendingMousePosRef.current = null;
                if (pos) {
                  sendInputs([DeviceEvent.mouseMove(pos.x, pos.y)]);
                }
              });
            }
          }}
          onMouseDown={(e) => {
            e.currentTarget.focus();
            cancelPendingMouseMove();
            pressedButtonsRef.current.add(e.button);
            const { x, y } = toCanvasCoords(e);
            sendInputs([
              DeviceEvent.mouseMove(x, y),
              DeviceEvent.mouseButtonPressed(mapMouseButton(e.button)),
            ]);
          }}
          onMouseUp={(e) => {
            cancelPendingMouseMove();
            pressedButtonsRef.current.delete(e.button);
            const { x, y } = toCanvasCoords(e);
            sendInputs([
              DeviceEvent.mouseMove(x, y),
              DeviceEvent.mouseButtonReleased(mapMouseButton(e.button)),
            ]);
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            e.stopPropagation();
            const sc = codeToScancode(e.code);
            if (sc !== undefined) {
              sendInputs([DeviceEvent.keyPressed(sc)]);
            }
          }}
          onKeyUp={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            e.stopPropagation();
            const sc = codeToScancode(e.code);
            if (sc !== undefined) {
              sendInputs([DeviceEvent.keyReleased(sc)]);
            }
          }}
        />
      </div>

      {tab.status === "connecting" && (
        <div className="pointer-events-none absolute inset-0 top-9 grid place-items-center bg-black/50 text-sm text-white/80">
          正在连接 RDP {tab.server.host}:{tab.server.port}…
        </div>
      )}

      {(tab.status === "error" || tab.status === "closed") && (
        <div className="absolute inset-0 top-9 grid place-items-center bg-black/70 p-6">
          <div className="max-w-md rounded-2xl border border-border bg-card p-5 text-center shadow-xl">
            <div className="mb-1 text-sm font-semibold text-card-foreground">
              {tab.status === "closed" ? "RDP 会话已结束" : "RDP 连接失败"}
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
