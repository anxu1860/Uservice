import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader2, X } from "lucide-react";
import { CLOUD_PROVIDERS } from "./ProviderIcon";
import type { Server } from "../types";

interface ServerFormModalProps {
  open: boolean;
  initial?: Server | null;
  onClose: () => void;
  onSave: (server: Server, secret: string) => void;
}

type TestResult = { ok: true; ms: number } | { ok: false; error: string } | null;

export function ServerFormModal({
  open,
  initial,
  onClose,
  onSave,
}: ServerFormModalProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [group, setGroup] = useState("");
  const [provider, setProvider] = useState("auto");
  const [authType, setAuthType] = useState<"password" | "key">("key");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setHost(initial.host);
      setPort(String(initial.port));
      setUsername(initial.username);
      setGroup(initial.group ?? "");
      setProvider(initial.provider ?? "auto");
      if (initial.auth.type === "password") {
        setAuthType("password");
        setKeyPath("~/.ssh/id_ed25519");
      } else {
        setAuthType("key");
        setKeyPath(initial.auth.path);
      }
    } else {
      setName("");
      setHost("");
      setPort("22");
      setUsername("root");
      setGroup("");
      setProvider("auto");
      setAuthType("key");
      setKeyPath("~/.ssh/id_ed25519");
    }
    setPassword("");
    setShowPassword(false);
    setTestResult(null);
  }, [open, initial]);

  if (!open) return null;

  const parsedPort = Number.parseInt(port, 10);
  const effectivePort =
    Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22;

  const handleTest = async () => {
    if (!host.trim() || !username.trim() || testing) return;
    setTesting(true);
    setTestResult(null);
    const auth =
      authType === "password"
        ? { type: "password", password }
        : {
            type: "key",
            path: keyPath.trim() || "~/.ssh/id_ed25519",
            passphrase: password || null,
          };
    try {
      const ms = await invoke<number>("ssh_test", {
        cfg: {
          host: host.trim(),
          port: effectivePort,
          username: username.trim(),
          auth,
        },
      });
      setTestResult({ ok: true, ms });
    } catch (err) {
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !username.trim()) return;

    const server: Server = {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: effectivePort,
      username: username.trim(),
      auth:
        authType === "password"
          ? { type: "password" }
          : { type: "key", path: keyPath.trim() || "~/.ssh/id_ed25519" },
      group: group.trim() || undefined,
      provider: provider === "auto" ? undefined : provider,
      tags: initial?.tags ?? [],
      updated_at: Math.floor(Date.now() / 1000),
    };

    onSave(server, password);
    setPassword("");
    setShowPassword(false);
    setTestResult(null);
    onClose();
  };

  const authIndex = authType === "password" ? 0 : 1;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-[400px] rounded-[28px] bg-card px-5 pb-5 pt-[22px] shadow-[0_0_0_1px_var(--color-border),0_24px_60px_rgb(0_0_0/.12)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[20px] font-bold text-card-foreground">
            {initial ? "编辑服务器" : "添加服务器"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-muted text-muted-foreground transition hover:opacity-80"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-[13px] text-muted-foreground">
              显示名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产 Web-01"
              className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="mb-1 block text-[13px] text-muted-foreground">
                主机 / IP *
              </label>
              <input
                type="text"
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-muted-foreground">
                端口
              </label>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[13px] text-muted-foreground">
                用户名 *
              </label>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="mb-1 block text-[13px] text-muted-foreground">
                分组
              </label>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="例如：Production"
                className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[13px] text-muted-foreground">
              云厂商 / 图标
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-11 w-full rounded-[12px] bg-muted px-3.5 text-[15px] text-foreground outline-none focus:ring-2 focus:ring-primary/40"
            >
              {CLOUD_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[13px] text-muted-foreground">
              认证方式
            </label>
            <div className="relative grid h-9 grid-cols-2 rounded-[9px] bg-muted p-[2px]">
              <div
                className="absolute bottom-[2px] left-[2px] top-[2px] w-[calc((100%-4px)/2)] rounded-[7px] bg-background shadow-[0_3px_8px_rgb(0_0_0/.12),0_3px_1px_rgb(0_0_0/.04)] transition-transform duration-300 [transition-timing-function:cubic-bezier(.2,.9,.25,1)]"
                style={{ transform: `translateX(${authIndex * 100}%)` }}
              />
              <button
                type="button"
                onClick={() => {
                  setAuthType("password");
                  setTestResult(null);
                }}
                className={`relative z-10 text-[13px] text-foreground ${
                  authType === "password" ? "font-semibold" : "font-medium"
                }`}
              >
                密码认证
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthType("key");
                  setTestResult(null);
                }}
                className={`relative z-10 text-[13px] text-foreground ${
                  authType === "key" ? "font-semibold" : "font-medium"
                }`}
              >
                SSH 私钥
              </button>
            </div>
          </div>

          {authType === "password" ? (
            <div>
              <label className="mb-1 block text-[13px] text-muted-foreground">
                密码{initial ? "（留空保持不变）" : "（可选，也可连接时输入）"}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入 SSH 登录密码"
                  className="h-11 w-full rounded-[12px] bg-muted py-1.5 pr-10 pl-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-3 flex items-center text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[13px] text-muted-foreground">
                  私钥路径
                </label>
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className="h-11 w-full rounded-[12px] bg-muted px-3.5 font-mono text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                />
              </div>
              <div>
                <label className="mb-1 block text-[13px] text-muted-foreground">
                  私钥口令（可选）
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="如私钥有口令请填写"
                    className="h-11 w-full rounded-[12px] bg-muted py-1.5 pr-10 pl-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-3 flex items-center text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {testResult && (
            <div
              className={`rounded-[12px] px-3.5 py-2 text-[13px] ${
                testResult.ok
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {testResult.ok
                ? `✓ 连接成功 · ${testResult.ms} ms`
                : `✗ ${testResult.error}`}
            </div>
          )}

          <p className="text-[12px] text-muted-foreground">
            密码/私钥口令保存在系统钥匙串（macOS Keychain / Windows 凭据管理器 /
            Linux Secret Service）中，不会以明文写入磁盘。
          </p>

          <div className="flex items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !host.trim() || !username.trim()}
              className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-muted px-4 text-[14px] font-semibold text-foreground transition active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{testing ? "测试中…" : "测试连接"}</span>
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-11 rounded-[12px] bg-muted px-4 text-[15px] font-semibold text-foreground transition active:scale-[.97]"
              >
                取消
              </button>
              <button
                type="submit"
                className="h-11 rounded-[12px] bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition active:scale-[.97]"
              >
                保存
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
