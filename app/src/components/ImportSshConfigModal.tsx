import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileInput, Loader2, X } from "lucide-react";
import type { Server } from "../types";

interface ImportSshConfigModalProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

export function ImportSshConfigModal({
  open,
  onClose,
  onImported,
}: ImportSshConfigModalProps) {
  const [candidates, setCandidates] = useState<Server[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    invoke<Server[]>("ssh_config_preview")
      .then((list) => {
        setCandidates(list);
        setSelected(new Set(list.map((s) => s.id)));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    const toImport = candidates.filter((c) => selected.has(c.id));
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-[440px] rounded-[28px] bg-card px-5 pb-5 pt-[22px] shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileInput className="h-5 w-5 text-primary" />
            <h2 className="text-[20px] font-bold text-card-foreground">
              导入 ~/.ssh/config
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-muted text-muted-foreground transition hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在解析 ~/.ssh/config…</span>
          </div>
        ) : error ? (
          <div className="rounded-[14px] bg-destructive/10 p-3.5 text-[13px] text-destructive">
            {error}
          </div>
        ) : candidates.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-muted-foreground">
            未在 ~/.ssh/config 中发现可导入的主机配置。
          </div>
        ) : (
          <>
            <div className="mb-2.5 flex items-center justify-between text-[13px] text-muted-foreground">
              <span>共解析到 {candidates.length} 台主机（自动跳过重复项）</span>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === candidates.length
                      ? new Set()
                      : new Set(candidates.map((c) => c.id))
                  )
                }
                className="font-medium text-primary hover:underline"
              >
                {selected.size === candidates.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-[14px] bg-muted px-3.5 py-0.5">
              {candidates.map((srv, idx) => (
                <label
                  key={srv.id}
                  className={`flex cursor-pointer items-center gap-3 py-2.5 ${
                    idx > 0 ? "border-t-[0.5px] border-border" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(srv.id)}
                    onChange={() => toggle(srv.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium text-card-foreground">
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

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-[12px] bg-muted px-5 text-[15px] font-semibold text-foreground transition active:scale-[.97]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading || importing || selected.size === 0}
            onClick={handleImport}
            className="h-11 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition active:scale-[.97] disabled:opacity-40"
          >
            {importing ? "导入中…" : `导入 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
