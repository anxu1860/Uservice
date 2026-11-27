import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import {
  siClaude,
  siDeepseek,
  siGooglegemini,
  siOllama,
  siOpenrouter,
  type SimpleIcon,
} from "simple-icons";
import {
  AI_PRESETS,
  deleteAiProfile,
  fetchAiModels,
  listAiProfiles,
  setDefaultAiProfile,
  testAiConnection,
  upsertAiProfile,
  type AiConfigData,
  type AiProfile,
  type AiProtocol,
} from "@/lib/ai";
import { DropdownSelect, type DropdownOption } from "./ui/dropdown-select";

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-4 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const INPUT_CLS =
  "w-full rounded-xl border border-border bg-background/80 px-3 py-2 text-xs outline-none transition focus:border-primary";

const PROTOCOL_LABELS: Record<AiProtocol, string> = {
  open_ai_compatible: "OpenAI 兼容",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
};

const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

const PRESET_ICON_MAP: Record<string, { icon?: SimpleIcon; path?: string; color: string }> = {
  OpenAI: { path: OPENAI_PATH, color: "currentColor" },
  DeepSeek: { icon: siDeepseek, color: `#${siDeepseek.hex}` },
  "Anthropic Claude": { icon: siClaude, color: `#${siClaude.hex}` },
  "Google Gemini": { icon: siGooglegemini, color: `#${siGooglegemini.hex}` },
  "Ollama (本地)": { icon: siOllama, color: "currentColor" },
  OpenRouter: { icon: siOpenrouter, color: "currentColor" },
};

function AiPresetLogo({ label }: { label: string }) {
  const entry = PRESET_ICON_MAP[label];
  const path = entry?.icon?.path ?? entry?.path;
  if (!path) {
    return <Bot className="h-3.5 w-3.5 shrink-0 opacity-70" />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0"
      fill={entry.color}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const PROTOCOL_OPTIONS: DropdownOption<AiProtocol>[] = [
  {
    value: "open_ai_compatible",
    label: "OpenAI 兼容（DeepSeek / Qwen / Ollama / 中转）",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 shrink-0"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={OPENAI_PATH} />
      </svg>
    ),
  },
  {
    value: "anthropic",
    label: "Anthropic Messages（Claude）",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 shrink-0"
        fill={`#${siClaude.hex}`}
        aria-hidden="true"
      >
        <path d={siClaude.path} />
      </svg>
    ),
  },
  {
    value: "gemini",
    label: "Google Gemini",
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5 shrink-0"
        fill={`#${siGooglegemini.hex}`}
        aria-hidden="true"
      >
        <path d={siGooglegemini.path} />
      </svg>
    ),
  },
];

interface DraftProfile {
  id: string;
  name: string;
  protocol: AiProtocol;
  base_url: string;
  model: string;
  api_key: string;
  has_api_key: boolean;
  clear_api_key: boolean;
  headers_text: string;
  temperature: string;
  max_tokens: string;
  system_prompt: string;
}

function emptyDraft(): DraftProfile {
  return {
    id: "",
    name: "",
    protocol: "open_ai_compatible",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    api_key: "",
    has_api_key: false,
    clear_api_key: false,
    headers_text: "",
    temperature: "",
    max_tokens: "",
    system_prompt: "",
  };
}

function profileToDraft(p: AiProfile): DraftProfile {
  const headers_text = Object.entries(p.custom_headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    base_url: p.base_url,
    model: p.model,
    api_key: "",
    has_api_key: p.has_api_key,
    clear_api_key: false,
    headers_text,
    temperature: p.temperature != null ? String(p.temperature) : "",
    max_tokens: p.max_tokens != null ? String(p.max_tokens) : "",
    system_prompt: p.system_prompt ?? "",
  };
}

function parseHeadersText(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

function draftToProfile(d: DraftProfile): AiProfile {
  const temp = Number.parseFloat(d.temperature);
  const maxTok = Number.parseInt(d.max_tokens, 10);
  return {
    id: d.id,
    name: d.name.trim() || d.model.trim() || "未命名模型",
    protocol: d.protocol,
    base_url: d.base_url.trim(),
    model: d.model.trim(),
    custom_headers: parseHeadersText(d.headers_text),
    temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : null,
    max_tokens: Number.isFinite(maxTok) && maxTok > 0 ? maxTok : null,
    system_prompt: d.system_prompt.trim() || null,
    has_api_key: d.has_api_key,
    updated_at: 0,
  };
}

export function AiSettingsSection() {
  const [config, setConfig] = useState<AiConfigData>({
    default_profile_id: null,
    profiles: [],
  });
  const [editing, setEditing] = useState<DraftProfile | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const reload = async () => {
    try {
      const data = await listAiProfiles();
      setConfig(data);
    } catch (err) {
      console.error("Failed to load AI profiles:", err);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.base_url.trim() || !editing.model.trim()) {
      setFeedback({ ok: false, text: "请填写 Base URL 和模型名称" });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const next = await upsertAiProfile({
        profile: draftToProfile(editing),
        apiKey: editing.api_key.trim() || undefined,
        clearApiKey: editing.clear_api_key,
        setDefault: config.profiles.length === 0,
      });
      setConfig(next);
      setEditing(null);
      setModelOptions([]);
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!editing) return;
    setTesting(true);
    setFeedback(null);
    try {
      const baseProfile = draftToProfile(editing);
      const trimmedKey = editing.api_key.trim();
      const effectiveProfile =
        editing.clear_api_key && !trimmedKey
          ? { ...baseProfile, id: "", has_api_key: false }
          : baseProfile;
      const res = await testAiConnection(
        effectiveProfile,
        trimmedKey || (editing.clear_api_key ? "" : undefined)
      );
      setFeedback({ ok: res.ok, text: res.message });
    } catch (err) {
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setFeedback({ ok: false, text: msg });
    } finally {
      setTesting(false);
    }
  };

  const handleFetchModels = async () => {
    if (!editing) return;
    setLoadingModels(true);
    setFeedback(null);
    try {
      const baseProfile = draftToProfile(editing);
      const trimmedKey = editing.api_key.trim();
      const effectiveProfile =
        editing.clear_api_key && !trimmedKey
          ? { ...baseProfile, id: "", has_api_key: false }
          : baseProfile;
      const list = await fetchAiModels(
        effectiveProfile,
        trimmedKey || (editing.clear_api_key ? "" : undefined)
      );
      setModelOptions(list);
      if (list.length > 0) {
        setEditing((prev) =>
          prev && !prev.model.trim() ? { ...prev, model: list[0] } : prev
        );
      }
      setFeedback({
        ok: true,
        text: `已获取 ${list.length} 个可用模型`,
      });
    } catch (err) {
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setFeedback({ ok: false, text: `拉取模型失败：${msg}` });
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <Bot className="h-3.5 w-3.5" />
          <span>AI 运维助手与 API 配置</span>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(emptyDraft());
              setFeedback(null);
              setModelOptions([]);
              setShowAdvanced(false);
            }}
            className="flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/20"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>添加 API</span>
          </button>
        )}
      </div>

      <div className={CARD_CLS}>
        {editing ? (
          <div className="motion-stagger space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold">
                {editing.id ? "编辑 API 配置" : "新建 API 配置"}
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setFeedback(null);
                }}
                className="text-xs opacity-60 hover:opacity-100"
              >
                取消
              </button>
            </div>

            {/* Quick Presets */}
            <div className="space-y-1.5">
              <div className="text-[11px] opacity-60">快速填充预设</div>
              <div className="flex flex-wrap gap-1.5">
                {AI_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        name: editing.name || preset.label,
                        protocol: preset.protocol,
                        base_url: preset.base_url,
                        model: preset.model,
                      })
                    }
                    className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium transition hover:bg-primary/15 hover:text-primary"
                  >
                    <AiPresetLogo label={preset.label} />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-[11px] opacity-70">配置名称</span>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="例如：DeepSeek 生产排错"
                  className={INPUT_CLS}
                />
              </label>

              <div className="space-y-1">
                <span className="block text-[11px] opacity-70">接口协议</span>
                <DropdownSelect
                  value={editing.protocol}
                  onChange={(protocol) =>
                    setEditing({
                      ...editing,
                      protocol,
                    })
                  }
                  options={PROTOCOL_OPTIONS}
                  ariaLabel="接口协议"
                />
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] opacity-70">Base URL</span>
              <input
                type="text"
                value={editing.base_url}
                onChange={(e) =>
                  setEditing({ ...editing, base_url: e.target.value })
                }
                placeholder="https://api.openai.com/v1"
                className={`${INPUT_CLS} font-mono`}
              />
            </label>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] opacity-70">API Key（安全存储于系统密钥链）</span>
                {editing.has_api_key && !editing.clear_api_key && (
                  <button
                    type="button"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        api_key: "",
                        clear_api_key: true,
                      })
                    }
                    className="text-[11px] text-destructive hover:underline"
                  >
                    清除已存 Key
                  </button>
                )}
              </div>
              <input
                type="password"
                value={editing.api_key}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    api_key: e.target.value,
                    clear_api_key: false,
                  })
                }
                placeholder={
                  editing.has_api_key && !editing.clear_api_key
                    ? "已保存密钥（留空则保持不变）"
                    : "sk-...（本地 Ollama 可留空）"
                }
                className={`${INPUT_CLS} font-mono`}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] opacity-70">模型名称</span>
                <button
                  type="button"
                  disabled={loadingModels}
                  onClick={() => void handleFetchModels()}
                  className="flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                >
                  {loadingModels ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span>拉取模型列表</span>
                </button>
              </div>
              <input
                type="text"
                list="ai-model-options"
                value={editing.model}
                onChange={(e) =>
                  setEditing({ ...editing, model: e.target.value })
                }
                placeholder="例如：deepseek-chat / claude-sonnet-4-20250514"
                className={`${INPUT_CLS} font-mono`}
              />
              {modelOptions.length > 0 && (
                <datalist id="ai-model-options">
                  {modelOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-[11px] font-medium opacity-65 hover:opacity-100"
              >
                {showAdvanced ? "▼ 收起高级参数" : "▶ 展开高级参数（自定义请求头 / 温度 / 系统提示词）"}
              </button>
              {showAdvanced && (
                <div className="mt-2.5 space-y-2.5 rounded-xl bg-muted/40 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1">
                      <span className="text-[11px] opacity-70">Temperature</span>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={editing.temperature}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            temperature: e.target.value,
                          })
                        }
                        placeholder="默认"
                        className={INPUT_CLS}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] opacity-70">Max Tokens</span>
                      <input
                        type="number"
                        min="1"
                        value={editing.max_tokens}
                        onChange={(e) =>
                          setEditing({ ...editing, max_tokens: e.target.value })
                        }
                        placeholder="默认"
                        className={INPUT_CLS}
                      />
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[11px] opacity-70">
                      自定义请求头（每行一个，格式 Key: Value）
                    </span>
                    <textarea
                      rows={2}
                      value={editing.headers_text}
                      onChange={(e) =>
                        setEditing({ ...editing, headers_text: e.target.value })
                      }
                      placeholder="X-Proxy-Token: xxx"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] opacity-70">
                      自定义系统提示词（留空使用内置运维提示词）
                    </span>
                    <textarea
                      rows={2}
                      value={editing.system_prompt}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          system_prompt: e.target.value,
                        })
                      }
                      placeholder="例如：所有命令默认适配 Ubuntu 22.04 + Docker 环境"
                      className={INPUT_CLS}
                    />
                  </label>
                </div>
              )}
            </div>

            {feedback && (
              <div
                className={`motion-banner-enter rounded-xl px-3 py-2 text-xs ${
                  feedback.ok
                    ? "bg-emerald-500/10 text-emerald-500"
                    : "motion-shake bg-destructive/10 text-destructive"
                }`}
              >
                {feedback.text}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={testing}
                onClick={() => void handleTest()}
                className="flex items-center gap-1.5 rounded-xl bg-muted px-3 py-1.5 text-xs font-medium transition hover:bg-muted/80 disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span>测试连接</span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span>保存配置</span>
              </button>
            </div>
          </div>
        ) : config.profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
            <Bot className="h-7 w-7 opacity-35" />
            <div className="text-[13px] font-medium">尚未配置 AI 模型</div>
            <p className="max-w-md text-xs opacity-55">
              支持 OpenAI、DeepSeek、Claude、Gemini、本地 Ollama 及任意 OpenAI 兼容中转接口，用于在终端中辅助生成命令与排查故障。
            </p>
            <button
              type="button"
              onClick={() => setEditing(emptyDraft())}
              className="mt-1 flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>立即配置</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {config.profiles.map((p) => {
              const isDefault = config.default_profile_id === p.id;
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] opacity-75">
                        {PROTOCOL_LABELS[p.protocol]}
                      </span>
                      {isDefault && (
                        <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          默认
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] opacity-55">
                      {p.model} · {p.base_url}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!isDefault && (
                      <button
                        type="button"
                        title="设为默认"
                        onClick={() =>
                          void setDefaultAiProfile(p.id)
                            .then((next) => {
                              setConfig(next);
                              setFeedback(null);
                            })
                            .catch((err) =>
                              setFeedback({
                                ok: false,
                                text: `设置默认模型失败：${err instanceof Error ? err.message : String(err)}`,
                              })
                            )
                        }
                        className="rounded-lg p-1.5 opacity-60 transition hover:bg-muted hover:opacity-100"
                      >
                        <Star className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setEditing(profileToDraft(p));
                        setFeedback(null);
                        setModelOptions([]);
                        setShowAdvanced(
                          Boolean(
                            p.system_prompt ||
                              p.temperature != null ||
                              p.max_tokens != null ||
                              Object.keys(p.custom_headers ?? {}).length > 0
                          )
                        );
                      }}
                      className="rounded-lg px-2 py-1 text-xs opacity-75 transition hover:bg-muted hover:opacity-100"
                    >
                      编辑
                    </button>
                    {confirmDeleteId === p.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            void deleteAiProfile(p.id)
                              .then((next) => {
                                setConfig(next);
                                setFeedback(null);
                              })
                              .catch((err) =>
                                setFeedback({
                                  ok: false,
                                  text: `删除配置失败：${err instanceof Error ? err.message : String(err)}`,
                                })
                              );
                          }}
                          className="rounded-lg bg-destructive px-2 py-1 text-[11px] font-medium text-destructive-foreground transition hover:opacity-90"
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-lg bg-muted px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        title="删除配置"
                        onClick={() => setConfirmDeleteId(p.id)}
                        className="rounded-lg p-1.5 text-destructive/75 transition hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!editing && feedback && (
          <div
            className={`mt-2 rounded-lg px-3 py-2 text-xs ${
              feedback.ok
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {feedback.text}
          </div>
        )}
      </div>
    </section>
  );
}
