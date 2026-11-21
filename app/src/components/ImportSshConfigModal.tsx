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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
      <div className="popover w-full max-w-lg p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileInput className="h-4 w-4 text-blue-500" />
            <h2 className="text-base font-semibold">导入 ~/.ssh/config</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 opacity-70 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs opacity-70">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>正在解析 ~/.ssh/config…</span>
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-500/10 p-3 text-xs text-red-500">
            {error}
          </div>
        ) : candidates.length === 0 ? (
          <div className="py-10 text-center text-xs opacity-65">
            未在 ~/.ssh/config 中发现可导入的主机配置。
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between text-xs opacity-70">
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
                className="text-blue-500 hover:underline"
              >
                {selected.size === candidates.length ? "取消全选" : "全选"}
              </button>
            </div>
            <div
              className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2"
              style={{ borderColor: "var(--separator)" }}
            >
              {candidates.map((srv) => (
                <label
                  key={srv.id}
                  className="sidebar-item flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(srv.id)}
                    onChange={() => toggle(srv.id)}
                    className="accent-blue-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{srv.name}</div>
                    <div className="truncate font-mono text-[11px] opacity-60">
                      {srv.username}@{srv.host}:{srv.port}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80"
            style={{ borderColor: "var(--separator)" }}
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading || importing || selected.size === 0}
            onClick={handleImport}
            className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600 disabled:opacity-40"
          >
            {importing ? "导入中…" : `导入 (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
