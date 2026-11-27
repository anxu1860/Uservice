import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ChevronDown,
  CopyPlus,
  KeyRound,
  Layers,
  Trash2,
} from "lucide-react";
import { copyToClipboard, formatServerConnectionInfo } from "@/lib/utils";
import type { Credential, Server } from "../types";

interface ServerMoreMenuProps {
  server: Server;
  compact?: boolean;
  onOpenConcurrent: (server: Server) => void;
  onDuplicate: (server: Server) => void;
  onDelete: (server: Server) => void;
}

export function ServerMoreMenu({
  server,
  compact = false,
  onOpenConcurrent,
  onDuplicate,
  onDelete,
}: ServerMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(true);
  const [alignRight, setAlignRight] = useState(true);
  const [copied, setCopied] = useState(false);
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
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleCopyWithSecret = async () => {
    let secret: string | null = null;
    let credentialName: string | null = null;
    let effectiveServer: Server = server;
    let isKeyBased =
      server.auth.type === "key" ||
      (server.auth.type === "ask" && Boolean(server.auth.key_path));

    try {
      if (server.auth.type === "credential" && server.auth.credential_id) {
        const cid = server.auth.credential_id.trim();
        let credKey = `cred:${cid}`;
        try {
          const creds = await invoke<Credential[]>("credentials_list");
          const matched = creds.find((c) => c.id === cid || c.name === cid);
          if (matched) {
            credKey = `cred:${matched.id}`;
            credentialName = matched.name;
            isKeyBased = matched.kind === "key";
            if (matched.username?.trim()) {
              effectiveServer = {
                ...server,
                username: matched.username.trim(),
              };
            }
          }
        } catch {
          // Ignore credential metadata lookup error and fall back to raw id
        }
        secret = await invoke<string | null>("secret_get", { id: credKey });
        if (!secret) {
          secret = await invoke<string | null>("secret_get", { id: server.id });
        }
      } else {
        secret = await invoke<string | null>("secret_get", { id: server.id });
      }
    } catch {
      secret = null;
    }

    const baseInfo = formatServerConnectionInfo(effectiveServer, {
      credentialName,
    });
    const secretLine = secret
      ? `${isKeyBased ? "私钥口令" : "密码"}: ${secret}`
      : server.auth.type === "ask"
        ? "密码: (每次询问)"
        : server.auth.type === "password" ||
            server.auth.type === "keyboard_interactive" ||
            (server.auth.type === "credential" && !isKeyBased)
          ? "密码: (未保存)"
          : null;

    const fullText = secretLine ? `${baseInfo}\n${secretLine}` : baseInfo;
    const ok = await copyToClipboard(fullText);
    if (ok) {
      setCopied(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    }
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          if (!open && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const menuHeight = 200;
            const menuWidth = 264;
            setOpenUp(
              rect.top >= menuHeight ||
                rect.top > window.innerHeight - rect.bottom
            );
            setAlignRight(rect.right >= menuWidth);
          }
          setOpen((v) => !v);
        }}
        className={
          compact
            ? "motion-press inline-flex h-[30px] items-center gap-1 rounded-[8px] bg-muted px-2.5 text-[12px] font-medium text-foreground hover:bg-foreground/10"
            : "motion-press inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-muted px-3 text-[13px] font-medium text-foreground hover:bg-foreground/10"
        }
      >
        {copied ? (
          <>
            <Check className="motion-pop h-3.5 w-3.5 text-emerald-500" />
            <span>已复制</span>
          </>
        ) : (
          <>
            <span>更多</span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 [transition-timing-function:var(--ease-apple)] ${
                open ? "rotate-180" : ""
              }`}
            />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-40 w-64 overflow-hidden rounded-[14px] border border-border bg-card/95 p-1 shadow-xl backdrop-blur-xl ${
            openUp
              ? "motion-popover-up bottom-full mb-1.5"
              : "top-full mt-1.5"
          } ${alignRight ? "right-0" : "left-0"} ${
            openUp
              ? alignRight
                ? "origin-bottom-right"
                : "origin-bottom-left"
              : alignRight
                ? "origin-top-right"
                : "origin-top-left"
          }`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenConcurrent(server);
            }}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-card-foreground transition hover:bg-muted"
          >
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            <span>打开并发会话</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDuplicate(server);
            }}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-card-foreground transition hover:bg-muted"
          >
            <CopyPlus className="h-3.5 w-3.5 text-muted-foreground" />
            <span>创建副本</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopyWithSecret()}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-card-foreground transition hover:bg-muted"
          >
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            <span>复制链接信息（含密码）</span>
          </button>

          <div className="my-1 border-t border-border" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete(server);
            }}
            className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>删除</span>
          </button>
        </div>
      )}
    </div>
  );
}
