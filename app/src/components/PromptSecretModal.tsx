import { useState, type FormEvent } from "react";
import { KeyRound, X } from "lucide-react";
import type { Server } from "../types";

interface PromptSecretModalProps {
  server: Server | null;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}

export function PromptSecretModal({
  server,
  onCancel,
  onConfirm,
}: PromptSecretModalProps) {
  const [password, setPassword] = useState("");

  if (!server) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const val = password;
    setPassword("");
    onConfirm(val);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        className="card-glass w-full max-w-sm rounded-2xl border p-5 shadow-2xl"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold">输入登录密码</h2>
          </div>
          <button
            type="button"
            onClick={() => {
              setPassword("");
              onCancel();
            }}
            className="rounded-md p-1 opacity-70 transition hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 text-xs opacity-70">
          连接{" "}
          <span className="font-mono font-medium">
            {server.username}@{server.host}:{server.port}
          </span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="SSH 密码"
            className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500"
            style={{ borderColor: "var(--border-subtle)" }}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setPassword("");
                onCancel();
              }}
              className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-500 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
            >
              连接
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
