import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderCog,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  MCP_TOOL_GROUPS,
  clearMcpLogs,
  getMcpState,
  regenerateMcpToken,
  saveMcpConfig,
  startMcpServer,
  stopMcpServer,
  type McpConfig,
  type McpStatePayload,
} from "@/lib/mcp";
import { copyToClipboard } from "@/lib/utils";
import type { Server } from "@/types";
import { DropdownSelect } from "./ui/dropdown-select";

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-1 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const INPUT_CLS =
  "rounded-lg bg-muted px-3 py-1.5 text-xs outline-none ring-1 ring-black/10 focus:ring-primary/50 dark:ring-white/10";

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group/toggle relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`motion-toggle-thumb inline-block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/.22)] ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

function formatTime(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function McpSettingsSection() {
  const [payload, setPayload] = useState<McpStatePayload | null>(null);
  const [draft, setDraft] = useState<McpConfig | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [rootsText, setRootsText] = useState("");
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [snippetTab, setSnippetTab] = useState<"http" | "sse">("http");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const loadAll = useCallback(async (syncDraft = false) => {
    try {
      const [mcpData, serverList] = await Promise.all([
        getMcpState(),
        invoke<Server[]>("servers_list").catch(() => [] as Server[]),
      ]);
      setPayload(mcpData);
      setServers(serverList);
      if (syncDraft) {
        setDraft(mcpData.config);
        setPortDraft(String(mcpData.config.port));
        setRootsText(mcpData.config.workspace.allowed_local_roots.join("\n"));
      }
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  // Keep status & logs updated while MCP page is open and window is visible
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return;
      void getMcpState()
        .then((next) => setPayload(next))
        .catch(() => {});
    };
    const timer = window.setInterval(refresh, 3000);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Sync if an MCP client modifies workspace settings remotely
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen("mcp:config-changed", () => {
      void loadAll(true);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadAll]);

  const copyText = (key: string, text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopiedKey(key);
        if (copiedTimerRef.current !== null) {
          window.clearTimeout(copiedTimerRef.current);
        }
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null;
          setCopiedKey((prev) => (prev === key ? null : prev));
        }, 1600);
      } else {
        setError("复制到剪贴板失败，请手动复制");
      }
    });
  };

  const handleToggleService = async (nextEnabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = nextEnabled ? await startMcpServer() : await stopMcpServer();
      setPayload(res);
      setDraft((prev) =>
        prev ? { ...prev, enabled: res.config.enabled } : res.config
      );
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveConfig = async (override?: McpConfig) => {
    const base = override ?? draft;
    if (!base) return;
    setSaving(true);
    setError(null);
    try {
      const toSave: McpConfig = {
        ...base,
        workspace: {
          ...base.workspace,
          allowed_local_roots: rootsText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };
      const res = await saveMcpConfig(toSave);
      setPayload(res);
      setDraft(res.config);
      setPortDraft(String(res.config.port));
      setRootsText(res.config.workspace.allowed_local_roots.join("\n"));
      setSavedHint(true);
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => {
        savedTimerRef.current = null;
        setSavedHint(false);
      }, 1800);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateToken = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await regenerateMcpToken();
      setPayload(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      const res = await clearMcpLogs();
      setPayload(res);
    } catch (err) {
      setError(String(err));
    }
  };

  const maskedToken = payload?.token
    ? `${payload.token.slice(0, 10)}${"•".repeat(16)}${payload.token.slice(-4)}`
    : "";

  const buildClientSnippet = useCallback(
    (tokenValue: string) => {
      if (!payload) return "";
      const url = snippetTab === "http" ? payload.status.bind_url : payload.status.sse_url;
      const headers: Record<string, string> = {};
      if (payload.config.require_auth) {
        headers.Authorization = `Bearer ${tokenValue}`;
      }
      const serverObj: Record<string, unknown> =
        snippetTab === "http"
          ? {
              type: "http",
              url,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            }
          : {
              type: "sse",
              url,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            };
      return JSON.stringify(
        {
          mcpServers: {
            serverhub: serverObj,
          },
        },
        null,
        2
      );
    },
    [payload, snippetTab]
  );

  const clientSnippet = useMemo(
    () => (payload ? buildClientSnippet(payload.token) : ""),
    [payload, buildClientSnippet]
  );

  const displayClientSnippet = useMemo(
    () =>
      payload
        ? buildClientSnippet(showToken ? payload.token : maskedToken)
        : "",
    [payload, buildClientSnippet, showToken, maskedToken]
  );

  if (loading || !payload || !draft) {
    return (
      <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载 MCP 服务配置...
      </div>
    );
  }

  const { status, token } = payload;
  const groups = Array.from(
    new Set(
      servers
        .map((s) => (s.group ?? "").trim())
        .filter((g) => g.length > 0)
    )
  ).sort();

  const updateDraft = (patch: Partial<McpConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateWorkspace = (patch: Partial<McpConfig["workspace"]>) => {
    setDraft((prev) =>
      prev ? { ...prev, workspace: { ...prev.workspace, ...patch } } : prev
    );
  };

  const togglePermission = (
    key:
      | "require_auth"
      | "allow_workspace_write"
      | "allow_ssh_exec"
      | "allow_remote_files"
      | "allow_file_transfer"
      | "auto_accept_unknown_host_keys",
    value: boolean
  ) => {
    if (saving || busy) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    void handleSaveConfig(next);
  };

  return (
    <div className="motion-stagger space-y-6">
      {/* Service Status & Master Toggle */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold tracking-wide uppercase opacity-55">
            MCP 服务状态
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
              status.running
                ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status.running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/50"
              }`}
            />
            {status.running ? "运行中" : "已停止"}
          </span>
        </div>

        <div className={CARD_CLS}>
          <div className="flex items-center justify-between gap-4 py-3.5 text-[13px]">
            <div className="flex items-center gap-3">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                  status.running
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <Plug className="h-4.5 w-4.5" />
              </div>
              <div>
                <div className="font-medium">启用本地 MCP 服务</div>
                <div className="text-[11px] opacity-55">
                  向 Cursor、Claude Desktop、Antigravity 等外部 AI 客户端暴露工作区、SSH 与远程文件能力
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />}
              <Toggle
                checked={status.running}
                disabled={busy}
                onChange={(v) => void handleToggleService(v)}
              />
            </div>
          </div>

          <div
            className="grid grid-cols-3 gap-3 border-t py-3 text-xs"
            style={{ borderColor: "var(--separator)" }}
          >
            <div className="rounded-xl bg-muted/60 px-3 py-2">
              <div className="text-[10px] opacity-55">活跃 SSE 连接</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">
                {status.active_clients}
              </div>
            </div>
            <div className="rounded-xl bg-muted/60 px-3 py-2">
              <div className="text-[10px] opacity-55">MCP SSH 会话</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">
                {status.active_ssh_sessions}
              </div>
            </div>
            <div className="rounded-xl bg-muted/60 px-3 py-2">
              <div className="text-[10px] opacity-55">累计请求次数</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">
                {status.total_requests}
              </div>
            </div>
          </div>

          {status.running && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t py-3 text-xs"
              style={{ borderColor: "var(--separator)" }}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    HTTP
                  </span>
                  <code className="truncate font-mono text-[11px] opacity-85">
                    {status.bind_url}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold opacity-70">
                    SSE
                  </span>
                  <code className="truncate font-mono text-[11px] opacity-75">
                    {status.sse_url}
                  </code>
                </div>
              </div>
              <button
                type="button"
                onClick={() => copyText("url", status.bind_url)}
                className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-muted px-2.5 text-[11px] font-medium transition hover:bg-muted/80"
              >
                {copiedKey === "url" ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-500" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>复制地址</span>
                  </>
                )}
              </button>
            </div>
          )}

          {(error || status.last_error) && (
            <div
              className="border-t py-2.5 text-xs text-destructive"
              style={{ borderColor: "var(--separator)" }}
            >
              {error ?? status.last_error}
            </div>
          )}
        </div>
      </section>

      {/* Network & Authentication */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <KeyRound className="h-3.5 w-3.5" />
          <span>监听地址与鉴权</span>
        </div>
        <div className={CARD_CLS}>
          <div className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-[13px]">
            <div>
              <div className="font-medium">监听主机与端口</div>
              <div className="text-[11px] opacity-55">
                默认仅监听本机回环地址 127.0.0.1，修改后点击保存自动重启服务
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.host}
                onChange={(e) => updateDraft({ host: e.target.value })}
                placeholder="127.0.0.1"
                className={`w-32 font-mono ${INPUT_CLS}`}
              />
              <span className="text-xs opacity-50">:</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={portDraft}
                onChange={(e) => {
                  const raw = e.target.value;
                  setPortDraft(raw);
                  if (raw.trim() === "") return;
                  const n = Number.parseInt(raw, 10);
                  if (Number.isFinite(n) && n >= 1 && n <= 65535) {
                    updateDraft({ port: n });
                  }
                }}
                onBlur={() => {
                  const n = Number.parseInt(portDraft, 10);
                  if (Number.isFinite(n)) {
                    const clamped = Math.min(65535, Math.max(1, n));
                    setPortDraft(String(clamped));
                    updateDraft({ port: clamped });
                  } else {
                    setPortDraft(String(draft.port));
                  }
                }}
                className={`w-20 text-right font-mono tabular-nums ${INPUT_CLS}`}
              />
            </div>
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">启用 Bearer Token 鉴权</div>
              <div className="text-[11px] opacity-55">
                强烈建议开启，防止本机其他进程未授权访问服务器与文件
              </div>
            </div>
            <Toggle
              checked={draft.require_auth}
              disabled={saving || busy}
              onChange={(v) => togglePermission("require_auth", v)}
            />
          </div>

          {draft.require_auth && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t py-3.5 text-[13px]"
              style={{ borderColor: "var(--separator)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">访问令牌 (Bearer Token)</div>
                <code className="mt-1 block truncate rounded-lg bg-muted/70 px-2.5 py-1 font-mono text-[11px] opacity-85">
                  {showToken ? token : maskedToken}
                </code>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  title={showToken ? "隐藏令牌" : "显示令牌"}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] bg-muted text-muted-foreground transition hover:text-foreground"
                >
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => copyText("token", token)}
                  className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-muted px-2.5 text-xs font-medium transition hover:bg-muted/80"
                >
                  {copiedKey === "token" ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-500" />
                      <span>已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>复制</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRegenerateToken()}
                  title="重新生成令牌（旧令牌将立即失效）"
                  className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-muted px-2.5 text-xs font-medium transition hover:bg-muted/80 disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>重置</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Workspace Settings */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <FolderCog className="h-3.5 w-3.5" />
          <span>工作区设置</span>
        </div>
        <div className={CARD_CLS}>
          <div className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-[13px]">
            <div>
              <div className="font-medium">本地工作区目录</div>
              <div className="text-[11px] opacity-55">
                文件上传/下载使用相对路径时的默认本地根目录
              </div>
            </div>
            <input
              type="text"
              value={draft.workspace.local_workspace_dir}
              onChange={(e) => updateWorkspace({ local_workspace_dir: e.target.value })}
              placeholder="~/workspace"
              className={`w-64 font-mono ${INPUT_CLS}`}
            />
          </div>

          <div
            className="flex flex-wrap items-center justify-between gap-3 border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">默认目标服务器</div>
              <div className="text-[11px] opacity-55">
                MCP 调用省略 server_id 时自动使用的默认 SSH 服务器
              </div>
            </div>
            <div className="w-56">
              <DropdownSelect
                value={draft.workspace.default_server_id ?? ""}
                onChange={(val) =>
                  updateWorkspace({
                    default_server_id: val || null,
                  })
                }
                options={[
                  { value: "", label: "不指定（每次显式传入）" },
                  ...servers
                    .filter((s) => !s.protocol || s.protocol === "ssh")
                    .map((s) => ({
                      value: s.id,
                      label: `${s.name} (${s.username}@${s.host})`,
                    })),
                ]}
                align="right"
                ariaLabel="默认目标服务器"
              />
            </div>
          </div>

          <div
            className="flex flex-wrap items-center justify-between gap-3 border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">默认服务器分组</div>
              <div className="text-[11px] opacity-55">
                工作区默认关注的服务器分组标签
              </div>
            </div>
            <div className="w-56">
              <DropdownSelect
                value={draft.workspace.default_group ?? ""}
                onChange={(val) =>
                  updateWorkspace({
                    default_group: val || null,
                  })
                }
                options={[
                  { value: "", label: "全部服务器" },
                  ...groups.map((g) => ({
                    value: g,
                    label: g,
                  })),
                ]}
                align="right"
                ariaLabel="默认服务器分组"
              />
            </div>
          </div>

          <div
            className="flex flex-wrap items-center justify-between gap-3 border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">默认远程工作目录</div>
              <div className="text-[11px] opacity-55">
                列目录或搜索省略 path 参数时的默认远端路径
              </div>
            </div>
            <input
              type="text"
              value={draft.workspace.default_remote_dir}
              onChange={(e) => updateWorkspace({ default_remote_dir: e.target.value })}
              placeholder="~"
              className={`w-56 font-mono ${INPUT_CLS}`}
            />
          </div>

          <div
            className="space-y-2 border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">本地文件传输白名单目录（可选）</div>
              <div className="text-[11px] opacity-55">
                每行一个目录路径；留空则不限制本地路径，填写后 file_upload / file_download 仅允许读写这些目录内的文件
              </div>
            </div>
            <textarea
              rows={2}
              value={rootsText}
              onChange={(e) => setRootsText(e.target.value)}
              placeholder={"例如：\n~/Projects\n~/Downloads"}
              className={`w-full resize-y font-mono ${INPUT_CLS}`}
            />
          </div>

          <div
            className="flex items-center justify-end gap-2 border-t py-3"
            style={{ borderColor: "var(--separator)" }}
          >
            {savedHint && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                已保存
              </span>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSaveConfig()}
              className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>保存配置</span>
            </button>
          </div>
        </div>
      </section>

      {/* Capability Permissions */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <Shield className="h-3.5 w-3.5" />
          <span>能力权限控制</span>
        </div>
        <div className={CARD_CLS}>
          <div className="flex items-center justify-between py-3.5 text-[13px]">
            <div>
              <div className="font-medium">工作区与服务器写入权限</div>
              <div className="text-[11px] opacity-55">
                允许通过 MCP 修改工作区设置以及新增、编辑、删除服务器记录
              </div>
            </div>
            <Toggle
              checked={draft.allow_workspace_write}
              disabled={saving || busy}
              onChange={(v) => togglePermission("allow_workspace_write", v)}
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">SSH 命令与交互式会话</div>
              <div className="text-[11px] opacity-55">
                允许执行远程命令 (ssh_exec)、开启持久化 PTY 终端会话与采集监控指标
              </div>
            </div>
            <Toggle
              checked={draft.allow_ssh_exec}
              disabled={saving || busy}
              onChange={(v) => togglePermission("allow_ssh_exec", v)}
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">远程文件读写与管理</div>
              <div className="text-[11px] opacity-55">
                允许列目录、读写文件、创建/移动/删除以及内容搜索
              </div>
            </div>
            <Toggle
              checked={draft.allow_remote_files}
              disabled={saving || busy}
              onChange={(v) => togglePermission("allow_remote_files", v)}
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">本地与跨服务器文件传输</div>
              <div className="text-[11px] opacity-55">
                允许本地文件上传 (file_upload)、远端下载 (file_download) 与跨机直传
              </div>
            </div>
            <Toggle
              checked={draft.allow_file_transfer}
              disabled={saving || busy}
              onChange={(v) => togglePermission("allow_file_transfer", v)}
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">自动信任首次连接的未知主机指纹</div>
              <div className="text-[11px] opacity-55">
                开启后对尚未记录的 SSH 主机自动信任（TOFU）；若已有指纹发生变化仍会严格拦截
              </div>
            </div>
            <Toggle
              checked={draft.auto_accept_unknown_host_keys}
              disabled={saving || busy}
              onChange={(v) => togglePermission("auto_accept_unknown_host_keys", v)}
            />
          </div>
        </div>
      </section>

      {/* Client Quick-Connect & Tools Reference */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <Terminal className="h-3.5 w-3.5" />
          <span>客户端接入配置</span>
        </div>
        <div className={CARD_CLS}>
          <div className="space-y-3 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-[9px] bg-muted p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setSnippetTab("http")}
                  className={`rounded-[7px] px-2.5 py-1 text-[11px] font-medium transition ${
                    snippetTab === "http"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Streamable HTTP (/mcp)
                </button>
                <button
                  type="button"
                  onClick={() => setSnippetTab("sse")}
                  className={`rounded-[7px] px-2.5 py-1 text-[11px] font-medium transition ${
                    snippetTab === "sse"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  传统 SSE (/sse)
                </button>
              </div>
              <button
                type="button"
                onClick={() => copyText("snippet", clientSnippet)}
                className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-muted px-2.5 text-[11px] font-medium transition hover:bg-muted/80"
              >
                {copiedKey === "snippet" ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-500" />
                    <span>已复制 JSON</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>复制配置</span>
                  </>
                )}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-xl bg-muted/70 p-3 font-mono text-[11px] leading-relaxed">
              {displayClientSnippet}
            </pre>
          </div>

          <div
            className="border-t py-3"
            style={{ borderColor: "var(--separator)" }}
          >
            <button
              type="button"
              onClick={() => setToolsExpanded((v) => !v)}
              className="flex w-full items-center justify-between text-left text-xs font-medium opacity-80 hover:opacity-100"
            >
              <span>
                查看全部已暴露 MCP 工具（
                {MCP_TOOL_GROUPS.reduce((sum, g) => sum + g.tools.length, 0)} 项）
              </span>
              {toolsExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {toolsExpanded && (
              <div className="mt-3 space-y-3">
                {MCP_TOOL_GROUPS.map((grp) => (
                  <div key={grp.title} className="space-y-1">
                    <div className="text-[11px] font-semibold opacity-60">
                      {grp.title}
                    </div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {grp.tools.map((t) => (
                        <div
                          key={t.name}
                          className="rounded-xl bg-muted/50 px-2.5 py-1.5 text-[11px]"
                        >
                          <code className="font-mono font-semibold text-primary">
                            {t.name}
                          </code>
                          <div className="mt-0.5 text-[10px] opacity-65">
                            {t.desc}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Recent Audit Logs */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold tracking-wide uppercase opacity-55">
            最近调用日志
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadAll(false)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              <span>刷新</span>
            </button>
            {status.recent_logs.length > 0 && (
              <button
                type="button"
                onClick={() => void handleClearLogs()}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
                <span>清空</span>
              </button>
            )}
          </div>
        </div>
        <div className={CARD_CLS}>
          {status.recent_logs.length === 0 ? (
            <div className="py-6 text-center text-xs opacity-50">
              暂无 MCP 工具调用记录
            </div>
          ) : (
            <div className="max-h-60 divide-y overflow-y-auto py-1 text-xs" style={{ borderColor: "var(--separator)" }}>
              {status.recent_logs.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        entry.ok ? "bg-emerald-500" : "bg-red-500"
                      }`}
                    />
                    <code className="shrink-0 font-mono text-[11px] font-semibold">
                      {entry.tool}
                    </code>
                    <span className="truncate text-[11px] opacity-65">
                      {entry.summary}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums opacity-55">
                    <span>{entry.duration_ms}ms</span>
                    <span>{formatTime(entry.timestamp)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
