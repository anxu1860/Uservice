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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-[400px] rounded-[28px] bg-card px-5 pb-5 pt-[22px] shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h2 className="text-[20px] font-bold text-card-foreground">
              输入登录密码
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              setPassword("");
              onCancel();
            }}
            aria-label="关闭"
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-muted text-muted-foreground transition hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mb-4 text-[13px] text-muted-foreground">
          连接{" "}
          <span className="font-mono font-medium text-card-foreground">
            {server.username}@{server.host}:{server.port}
          </span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="SSH 密码"
            className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                setPassword("");
                onCancel();
              }}
              className="h-11 rounded-[12px] bg-muted px-5 text-[15px] font-semibold text-foreground transition active:scale-[.97]"
            >
              取消
            </button>
            <button
              type="submit"
              className="h-11 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition active:scale-[.97]"
            >
              连接
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
