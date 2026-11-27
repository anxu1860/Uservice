import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  FileInput,
  Loader2,
  X,
} from "lucide-react";
import {
  candidateToServer,
  parseServerText,
  type ParsedServerCandidate,
} from "@/lib/importParser";
import type { Server } from "../types";

interface ImportSshConfigModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

type ImportTab = "text" | "ssh_config";

export function ImportSshConfigModal({
  open,
  onClose,
  onImported,
}: ImportSshConfigModalProps) {
  const [tab, setTab] = useState<ImportTab>("text");

  // Text / Clipboard tab state
  const [rawText, setRawText] = useState("");
  const [textCandidates, setTextCandidates] = useState<ParsedServerCandidate[]>([]);
  const [textSelected, setTextSelected] = useState<Set<string>>(new Set());
  const [revealPasswords, setRevealPasswords] = useState(false);

  // ~/.ssh/config tab state
  const [sshCandidates, setSshCandidates] = useState<Server[]>([]);
  const [sshSelected, setSshSelected] = useState<Set<string>>(new Set());
  const [sshLoaded, setSshLoaded] = useState(false);

  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoReadClipboardDoneRef = useRef(false);
  const rawTextRef = useRef(rawText);
  rawTextRef.current = rawText;

  const applyRawText = useCallback((text: string) => {
    setRawText(text);
    const parsed = parseServerText(text);
    setTextCandidates(parsed);
    setTextSelected(new Set(parsed.map((p) => p.id)));
  }, []);

  const readClipboard = useCallback(async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && clip.trim()) {
        applyRawText(clip);
      }
    } catch {
      // Ignore clipboard permission denials when auto-reading
    }
  }, [applyRawText]);

  useEffect(() => {
    if (!open) {
      setSshLoaded(false);
      setError(null);
      setRawText("");
      setTextCandidates([]);
      setTextSelected(new Set());
      setRevealPasswords(false);
      autoReadClipboardDoneRef.current = false;
      return;
    }
    if (tab === "text" && !autoReadClipboardDoneRef.current) {
      autoReadClipboardDoneRef.current = true;
      if (!rawTextRef.current.trim()) {
        void readClipboard();
      }
    }
  }, [open, tab, readClipboard]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !importing) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, importing, onClose]);

  useEffect(() => {
    if (!open || tab !== "ssh_config" || sshLoaded) return;
    setLoading(true);
    setError(null);
    invoke<Server[]>("ssh_config_preview")
      .then((list) => {
        setSshCandidates(list);
        setSshSelected(new Set(list.map((s) => s.id)));
        setSshLoaded(true);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [open, tab, sshLoaded]);

  if (!open) return null;

  const toggleText = (id: string) => {
    setTextSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSsh = (id: string) => {
    setSshSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeCount =
    tab === "text" ? textSelected.size : sshSelected.size;

  const handleImport = async () => {
    setError(null);
    if (tab === "text") {
      const chosen = textCandidates.filter((c) => textSelected.has(c.id));
      if (chosen.length === 0) {
        onClose();
        return;
      }
      setImporting(true);
      try {
        const servers: Server[] = [];
        const secrets: Record<string, string> = {};
        for (const item of chosen) {
          const server = candidateToServer(item);
          servers.push(server);
          if (item.password) {
            secrets[server.id] = item.password;
          }
        }
        await invoke<number>("servers_import", {
          servers,
          secrets: Object.keys(secrets).length > 0 ? secrets : null,
        });
        setRawText("");
        setTextCandidates([]);
        setTextSelected(new Set());
        setRevealPasswords(false);
        onImported();
        onClose();
      } catch (err) {
        setError(String(err));
      } finally {
        setImporting(false);
      }
      return;
    }

    const toImport = sshCandidates.filter((c) => sshSelected.has(c.id));
    if (toImport.length === 0) {
      onClose();
      return;
    }
    setImporting(true);
    try {
      await invoke<number>("servers_import", { servers: toImport });
      onImported();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="motion-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="motion-modal max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-[28px] bg-card px-6 pb-5 pt-[22px] shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileInput className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold tracking-tight text-card-foreground">
              导入服务器
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="motion-press grid h-[30px] w-[30px] place-items-center rounded-full bg-muted text-muted-foreground hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="relative mb-3 grid grid-cols-2 rounded-[10px] bg-muted p-[3px] text-[13px] font-medium">
          <div
            className="pointer-events-none absolute bottom-[3px] left-[3px] top-[3px] w-[calc((100%-6px)/2)] rounded-[8px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.08)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
            style={{
              transform: `translateX(${tab === "text" ? 0 : 100}%)`,
            }}
          />
          <button
            type="button"
            onClick={() => setTab("text")}
            className={`relative z-10 rounded-[8px] py-1.5 transition-colors duration-150 ${
              tab === "text"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            剪贴板 / 文本识别
          </button>
          <button
            type="button"
            onClick={() => setTab("ssh_config")}
            className={`relative z-10 rounded-[8px] py-1.5 transition-colors duration-150 ${
              tab === "ssh_config"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            ~/.ssh/config
          </button>
        </div>

        {tab === "text" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">
                  粘贴服务器信息（支持中英字段、ssh 命令、多台批量识别）
                </span>
                <button
                  type="button"
                  onClick={() => void readClipboard()}
                  className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/20"
                >
                  <ClipboardPaste className="h-3 w-3" />
                  <span>读取剪贴板</span>
                </button>
              </div>
              <textarea
                rows={5}
                value={rawText}
                onChange={(e) => applyRawText(e.target.value)}
                placeholder={`例如：\n名称: 生产环境 API 节点\n地址: 203.0.113.10\n端口: 22\n用户: root\n密码: your_password`}
                className="w-full rounded-[12px] bg-muted px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 focus:ring-2 focus:ring-primary/40"
              />
            </div>

            {textCandidates.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                  <span>已自动识别 {textCandidates.length} 台服务器</span>
                  <button
                    type="button"
                    onClick={() => setRevealPasswords((v) => !v)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    {revealPasswords ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    <span>{revealPasswords ? "隐藏密码" : "显示密码"}</span>
                  </button>
                </div>

                <div className="max-h-56 space-y-2 overflow-y-auto rounded-[14px] bg-muted/60 p-2.5">
                  {textCandidates.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-2.5 rounded-[10px] bg-background/80 p-2.5 shadow-xs"
                    >
                      <input
                        type="checkbox"
                        checked={textSelected.has(item.id)}
                        onChange={() => toggleText(item.id)}
                        className="mt-1 h-4 w-4 accent-primary"
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="truncate text-[13px] font-semibold text-card-foreground">
                          {item.name}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[12px] text-muted-foreground">
                          <span>
                            {item.username ? `${item.username}@` : ""}
                            {item.host}:{item.port}
                          </span>
                          {item.password && (
                            <span>
                              密码:{" "}
                              {revealPasswords
                                ? item.password
                                : "•".repeat(Math.min(10, item.password.length))}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在解析 ~/.ssh/config…</span>
          </div>
        ) : sshCandidates.length === 0 && !error ? (
          <div className="py-10 text-center text-[13px] text-muted-foreground">
            未在 ~/.ssh/config 中发现可导入的主机配置。
          </div>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between text-[12px] text-muted-foreground">
              <span>共解析到 {sshCandidates.length} 台主机（自动跳过重复项）</span>
              <button
                type="button"
                onClick={() =>
                  setSshSelected(
                    sshSelected.size === sshCandidates.length
                      ? new Set()
                      : new Set(sshCandidates.map((c) => c.id))
                  )
                }
                className="font-medium text-primary hover:underline"
              >
                {sshSelected.size === sshCandidates.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-[14px] bg-muted px-3.5 py-0.5">
              {sshCandidates.map((srv, idx) => (
                <label
                  key={srv.id}
                  className={`flex cursor-pointer items-center gap-3 py-2.5 ${
                    idx > 0 ? "border-t-[0.5px] border-border" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={sshSelected.has(srv.id)}
                    onChange={() => toggleSsh(srv.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-card-foreground">
                      {srv.name}
                    </div>
                    <div className="truncate font-mono text-[12px] text-muted-foreground">
                      {srv.username}@{srv.host}:{srv.port}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        {error && (
          <div className="mt-3 rounded-[12px] bg-destructive/10 p-3 text-[12px] text-destructive">
            {error}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-[12px] bg-muted px-5 text-[13px] font-semibold text-foreground transition active:scale-[.97]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading || importing || activeCount === 0}
            onClick={() => void handleImport()}
            className="h-10 rounded-[12px] bg-primary px-5 text-[13px] font-semibold text-primary-foreground transition active:scale-[.97] disabled:opacity-40"
          >
            {importing ? "导入中…" : `导入 (${activeCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
