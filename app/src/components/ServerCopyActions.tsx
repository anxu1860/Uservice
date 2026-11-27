import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import {
  cn,
  copyToClipboard,
  formatServerConnectionInfo,
  formatSshCommand,
} from "@/lib/utils";
import type { Server } from "../types";

interface ServerCopyActionsProps {
  server: Server;
}

interface CopyOption {
  id: string;
  label: string;
  preview: string;
  getValue: (server: Server) => string;
}

const COPY_OPTIONS: CopyOption[] = [
  {
    id: "ssh",
    label: "复制 SSH 命令",
    preview: "ssh user@host",
    getValue: (s) => formatSshCommand(s),
  },
  {
    id: "endpoint",
    label: "复制连接地址",
    preview: "user@host:port",
    getValue: (s) => `${s.username ? `${s.username}@` : ""}${s.host}:${s.port}`,
  },
  {
    id: "host",
    label: "复制主机地址",
    preview: "host",
    getValue: (s) => s.host,
  },
  {
    id: "full",
    label: "复制完整信息",
    preview: "名称 / 主机 / 认证 / SSH",
    getValue: (s) => formatServerConnectionInfo(s),
  },
];

export function ServerCopyActions({ server }: ServerCopyActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openUp, setOpenUp] = useState(true);
  const [alignRight, setAlignRight] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const triggerCopy = async (option: CopyOption) => {
    const ok = await copyToClipboard(option.getValue(server));
    if (!ok) return;
    setCopiedId(option.id);
    setMenuOpen(false);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setCopiedId(null);
      timerRef.current = null;
    }, 1800);
  };

  const isCopied = copiedId !== null;

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <div className="inline-flex h-9 items-center overflow-hidden rounded-[10px] bg-muted text-[13px] font-medium text-foreground">
        <button
          type="button"
          onClick={() => void triggerCopy(COPY_OPTIONS[0])}
          title={`快捷复制: ${formatSshCommand(server)}`}
          className="inline-flex h-full items-center gap-1.5 pl-3 pr-2 transition hover:bg-foreground/5 active:scale-[.98]"
        >
          {isCopied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className={cn(isCopied && "text-emerald-500")}>
            {isCopied ? "已复制" : "复制链接"}
          </span>
        </button>

        <span className="h-4 w-[0.5px] bg-border" aria-hidden="true" />

        <button
          type="button"
          onClick={() => {
            if (!menuOpen && containerRef.current) {
              const rect = containerRef.current.getBoundingClientRect();
              const menuHeight = 230;
              const menuWidth = 248;
              setOpenUp(
                rect.top >= menuHeight ||
                  rect.top > window.innerHeight - rect.bottom
              );
              setAlignRight(rect.right >= menuWidth);
            }
            setMenuOpen((v) => !v);
          }}
          aria-label="更多复制选项"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="inline-flex h-full items-center px-1.5 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-150",
              menuOpen && "rotate-180"
            )}
          />
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className={cn(
            "absolute z-40 w-60 rounded-[14px] bg-card p-1.5 shadow-[0_0_0_0.5px_var(--color-border),0_12px_32px_rgb(0_0_0/0.14)]",
            openUp ? "bottom-full mb-1.5" : "top-full mt-1.5",
            alignRight ? "right-0" : "left-0"
          )}
        >
          {COPY_OPTIONS.map((opt) => {
            const value = opt.getValue(server);
            const active = copiedId === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                onClick={() => void triggerCopy(opt)}
                className="flex w-full items-start justify-between gap-2 rounded-[10px] px-2.5 py-2 text-left transition hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-card-foreground">
                    {opt.label}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {opt.id === "full" ? opt.preview : value}
                  </div>
                </div>
                {active ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
