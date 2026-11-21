import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader2, X } from "lucide-react";
import type { Server } from "../types";

interface AddServerModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (server: Server, secret: string) => void;
}

type TestResult = { ok: true; ms: number } | { ok: false; error: string } | null;

export function AddServerModal({ open, onClose, onAdd }: AddServerModalProps) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [group, setGroup] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>(null);

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
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !username.trim()) return;

    const server: Server = {
      id: crypto.randomUUID(),
      name: name.trim() || `${username.trim()}@${host.trim()}`,
      host: host.trim(),
      port: effectivePort,
      username: username.trim(),
      auth:
        authType === "password"
          ? { type: "password" }
          : { type: "key", path: keyPath.trim() || "~/.ssh/id_ed25519" },
      group: group.trim() || undefined,
      tags: [],
      updated_at: Math.floor(Date.now() / 1000),
    };

    onAdd(server, password);
    setName("");
    setHost("");
    setPort("22");
    setGroup("");
    setPassword("");
    setShowPassword(false);
    setTestResult(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
      <div className="popover w-full max-w-md p-5">
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
              style={{ borderColor: "var(--separator)" }}
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
                style={{ borderColor: "var(--separator)" }}
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
                style={{ borderColor: "var(--separator)" }}
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
                style={{ borderColor: "var(--separator)" }}
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
                style={{ borderColor: "var(--separator)" }}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs opacity-70">认证方式</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setAuthType("password");
                  setTestResult(null);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  authType === "password"
                    ? "border-blue-500 bg-blue-500/15 text-blue-500"
                    : "opacity-75"
                }`}
                style={
                  authType === "password"
                    ? undefined
                    : { borderColor: "var(--separator)" }
                }
              >
                密码认证
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthType("key");
                  setTestResult(null);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                  authType === "key"
                    ? "border-blue-500 bg-blue-500/15 text-blue-500"
                    : "opacity-75"
                }`}
                style={
                  authType === "key"
                    ? undefined
                    : { borderColor: "var(--separator)" }
                }
              >
                SSH 私钥
              </button>
            </div>
          </div>

          {authType === "password" ? (
            <div>
              <label className="mb-1 block text-xs opacity-70">密码</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入 SSH 登录密码（保存后自动连接）"
                  className="w-full rounded-lg border bg-transparent py-1.5 pr-9 pl-3 outline-none focus:border-blue-500"
                  style={{ borderColor: "var(--separator)" }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-2 flex items-center opacity-60 hover:opacity-100"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs opacity-70">私钥路径</label>
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                  className="w-full rounded-lg border bg-transparent px-3 py-1.5 font-mono text-xs outline-none focus:border-blue-500"
                  style={{ borderColor: "var(--separator)" }}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-70">
                  私钥口令（可选）
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="如私钥有口令请填写"
                    className="w-full rounded-lg border bg-transparent py-1.5 pr-9 pl-3 outline-none focus:border-blue-500"
                    style={{ borderColor: "var(--separator)" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-2 flex items-center opacity-60 hover:opacity-100"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {testResult && (
            <div
              className={`rounded-lg px-3 py-1.5 text-xs ${
                testResult.ok
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-red-500/10 text-red-500"
              }`}
            >
              {testResult.ok
                ? `✓ 连接成功 · ${testResult.ms} ms`
                : `✗ ${testResult.error}`}
            </div>
          )}

          <p className="text-[11px] opacity-60">
            密码/私钥口令保存在系统钥匙串（Keychain）中，不会以明文写入磁盘。
          </p>

          <div className="flex items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !host.trim() || !username.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium opacity-85 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--separator)" }}
            >
              {testing && <Loader2 className="h-3 w-3 animate-spin" />}
              <span>{testing ? "测试中…" : "测试连接"}</span>
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border px-3 py-1.5 text-xs font-medium opacity-80 transition hover:opacity-100"
                style={{ borderColor: "var(--separator)" }}
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
          </div>
        </form>
      </div>
    </div>
  );
}
