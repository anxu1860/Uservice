import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { Server } from "../types";

interface AddServerModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (server: Server) => void;
}

export function AddServerModal({ open, onClose, onAdd }: AddServerModalProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [group, setGroup] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("key");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");

  if (!open) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !username.trim()) return;

    const parsedPort = Number.parseInt(port, 10);
    const server: Server = {
      id: crypto.randomUUID(),
      name: name.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
      username: username.trim(),
      auth:
        authType === "password"
          ? { type: "password" }
          : { type: "key", path: keyPath.trim() || "~/.ssh/id_ed25519" },
      group: group.trim() || undefined,
      tags: [],
      updated_at: Math.floor(Date.now() / 1000),
    };

    onAdd(server);
    setName("");
    setHost("");
    setPort("22");
    setGroup("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        className="card-glass w-full max-w-md rounded-2xl border p-5 shadow-2xl"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">添加服务器</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 opacity-70 transition hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs opacity-70">显示名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产 Web-01"
              className="w-full rounded-lg border bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
              style={{ borderColor: "var(--border-subtle)" }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="mb-1 block text-xs opacity-70">主机 / IP *</label>
              <input
                type="text"
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                className="w-full rounded-lg border bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs opacity-70">端口</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full rounded-lg border bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs opacity-70">用户名 *</label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs opacity-70">分组</label>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="例如：Production"
                className="w-full rounded-lg border bg-transparent px-3 py-1.5 outline-none focus:border-blue-500"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs opacity-70">认证方式</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAuthType("key")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  authType === "key"
                    ? "border-blue-500 bg-blue-500/15 text-blue-500"
                    : "opacity-75"
                }`}
                style={
                  authType === "key"
                    ? undefined
                    : { borderColor: "var(--border-subtle)" }
                }
              >
                SSH 私钥
              </button>
              <button
                type="button"
                onClick={() => setAuthType("password")}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  authType === "password"
                    ? "border-blue-500 bg-blue-500/15 text-blue-500"
                    : "opacity-75"
                }`}
                style={
                  authType === "password"
                    ? undefined
                    : { borderColor: "var(--border-subtle)" }
                }
              >
                密码（连接时输入）
              </button>
            </div>
          </div>

          {authType === "key" && (
            <div>
              <label className="mb-1 block text-xs opacity-70">私钥路径</label>
              <input
                type="text"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
                className="w-full rounded-lg border bg-transparent px-3 py-1.5 font-mono text-xs outline-none focus:border-blue-500"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
          )}

          <p className="text-[11px] opacity-60">
            安全提示：密码和私钥口令仅在内存中使用，不会写入本地磁盘。
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80 transition hover:opacity-100"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
