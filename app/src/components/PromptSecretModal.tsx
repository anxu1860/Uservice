import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, X } from "lucide-react";
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
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setPassword("");
    setShowPassword(false);
  }, [server?.id]);

  useEffect(() => {
    if (!server) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPassword("");
        setShowPassword(false);
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [server, onCancel]);

  if (!server) return null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const val = password;
    setPassword("");
    setShowPassword(false);
    onConfirm(val);
  };

  const authType = server.auth.type;
  const titleText =
    authType === "ask"
      ? "每次询问 · 输入凭证"
      : authType === "keyboard_interactive"
        ? "交互式认证 (PAM / 2FA)"
        : authType === "credential"
          ? "输入登录凭证密码"
          : authType === "key"
            ? "输入私钥口令或密码"
            : "输入登录密码";

  const placeholderText =
    authType === "ask"
      ? server.auth.key_path
        ? "输入本次私钥口令或登录密码"
        : "输入本次 SSH 登录密码"
      : authType === "keyboard_interactive"
        ? "输入认证密码或动态口令 (OTP)"
        : authType === "key"
          ? "输入 SSH 私钥口令"
          : "SSH 登录密码";

  return (
    <div className="motion-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="motion-modal w-full max-w-[400px] rounded-[28px] bg-card px-5 pb-5 pt-[22px] shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h2 className="text-[20px] font-bold tracking-tight text-card-foreground">
              {titleText}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => {
              setPassword("");
              onCancel();
            }}
            aria-label="关闭"
            className="motion-press grid h-[30px] w-[30px] place-items-center rounded-full bg-muted text-muted-foreground hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mb-3 text-[13px] text-muted-foreground">
          连接{" "}
          <span className="font-mono font-medium text-card-foreground">
            {server.username ? `${server.username}@` : ""}
            {server.host}:{server.port}
          </span>
        </p>

        {authType === "ask" && (
          <div className="mb-3 rounded-[10px] bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-600 dark:text-amber-400">
            当前服务器已开启「每次询问」模式，本次输入的密码仅用于当前会话，不会保存至本地密钥库。
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={placeholderText}
              className="h-11 w-full rounded-[12px] bg-muted pl-3.5 pr-10 text-[15px] text-foreground outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              className="absolute right-2.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition hover:bg-background/60 hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => {
                setPassword("");
                onCancel();
              }}
              className="motion-press h-11 rounded-[12px] bg-muted px-5 text-[15px] font-semibold text-foreground hover:bg-muted/85"
            >
              取消
            </button>
            <button
              type="submit"
              className="motion-press h-11 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground hover:opacity-92"
            >
              连接
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
