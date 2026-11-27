import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Cloud,
  Image as ImageIcon,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  Plug,
  RotateCcw,
  Sun,
  Terminal as TerminalIcon,
  Wifi,
  X,
} from "lucide-react";
import {
  ACCENT_PRESETS,
  sanitizeBackgroundImage,
  saveSettings,
  type AppSettings,
} from "@/lib/settings";
import type { ThemeMode } from "@/lib/theme";
import {
  AUTH_STAGE_META,
  DEFAULT_AUTH_PRIORITY,
  TERMINAL_TYPE_OPTIONS,
} from "../types";
import { AiSettingsSection } from "./AiSettingsSection";
import { McpSettingsSection } from "./McpSettingsSection";
import { ShortcutsSettingsSection } from "./ShortcutsSettingsSection";
import { SyncSettingsSection } from "./SyncSettingsSection";
import { TerminalSettingsSection } from "./TerminalSettingsSection";
import { DropdownSelect } from "./ui/dropdown-select";

interface SettingsPageProps {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onSyncPulled?: () => void;
}

type SettingsTab = "appearance" | "terminal" | "shortcuts" | "monitor" | "ai" | "mcp" | "sync";

const SETTINGS_TABS: {
  id: SettingsTab;
  label: string;
  Icon: typeof Palette;
}[] = [
  { id: "appearance", label: "外观与显示", Icon: Palette },
  { id: "terminal", label: "终端设置", Icon: TerminalIcon },
  { id: "shortcuts", label: "快捷键", Icon: Keyboard },
  { id: "monitor", label: "监控与连接", Icon: Wifi },
  { id: "ai", label: "AI 运维助手", Icon: Bot },
  { id: "mcp", label: "MCP 服务", Icon: Plug },
  { id: "sync", label: "同步设置", Icon: Cloud },
];

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-1 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`group/toggle relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ${
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

function NumericInput({
  value,
  min,
  max,
  onCommit,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (next: number) => void;
  className: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw.trim() === "") return;
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n >= min && n <= max) {
          onCommit(n);
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        const n = Number.parseInt(draft, 10);
        if (Number.isFinite(n)) {
          const clamped = Math.min(max, Math.max(min, n));
          setDraft(String(clamped));
          if (clamped !== value) {
            onCommit(clamped);
          }
        } else {
          setDraft(String(value));
        }
      }}
      className={className}
    />
  );
}

const MAX_BG_DATA_URL_LEN = 1_500_000;
const ALLOWED_BG_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

async function compressBackgroundImage(file: File): Promise<string> {
  const mime = (file.type || "").toLowerCase();
  if (
    mime === "image/svg+xml" ||
    file.name.toLowerCase().endsWith(".svg") ||
    (mime && !ALLOWED_BG_MIME_TYPES.has(mime))
  ) {
    throw new Error("仅支持 PNG、JPG、WebP、GIF、AVIF 等位图格式");
  }

  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

  const safeRaw = sanitizeBackgroundImage(rawDataUrl);
  if (safeRaw && safeRaw.length <= MAX_BG_DATA_URL_LEN) {
    return safeRaw;
  }

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("无法解析图片文件"));
    el.src = rawDataUrl;
  });

  const maxDim = 1920;
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const ratio = Math.min(maxDim / width, maxDim / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("当前环境不支持压缩图片，请选择小于 1.5MB 的图片");
  }
  ctx.drawImage(img, 0, 0, width, height);

  let compressed = canvas.toDataURL("image/jpeg", 0.82);
  if (compressed.length > MAX_BG_DATA_URL_LEN) {
    compressed = canvas.toDataURL("image/jpeg", 0.65);
  }
  const safeCompressed = sanitizeBackgroundImage(compressed);
  if (!safeCompressed || safeCompressed.length > MAX_BG_DATA_URL_LEN) {
    throw new Error("图片体积过大（超过 1.5MB 限制），请选择分辨率更低的图片");
  }
  return safeCompressed;
}

export function SettingsPage({
  settings,
  onUpdate,
  themeMode,
  onThemeChange,
  onSyncPulled,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [bgError, setBgError] = useState<string | null>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  const handleBgFile = async (file: File | undefined) => {
    if (!file) return;
    setBgError(null);
    if (file.size > 20 * 1024 * 1024) {
      setBgError("图片文件超过 20MB，请选择更小的图片");
      return;
    }
    try {
      const dataUrl = await compressBackgroundImage(file);
      const ok = saveSettings({ ...settings, backgroundImage: dataUrl });
      if (!ok) {
        setBgError("本地存储空间不足，无法保存该背景图片，请选择更小的图片");
        return;
      }
      onUpdate({ backgroundImage: dataUrl });
    } catch (err) {
      setBgError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Two-Pane Settings Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Category Sidebar */}
        <nav
          className="w-44 shrink-0 space-y-0.5 overflow-y-auto border-r p-2.5"
          style={{ borderColor: "var(--separator)" }}
        >
          {SETTINGS_TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`motion-press flex w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left ${
                  active
                    ? "bg-primary/12 text-primary"
                    : "text-foreground/80 hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    active ? "text-primary" : "opacity-60"
                  }`}
                />
                <span className={`truncate text-[13px] ${active ? "font-semibold" : "font-medium"}`}>
                  {label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Right Detail Pane */}
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div
            key={activeTab}
            className="motion-stagger w-full space-y-6 pb-6"
          >
            {activeTab === "appearance" && (
              <>
                <section className="space-y-2">
                  <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
                    主题与色彩
                  </div>
                  <div className={CARD_CLS}>
                    <div className="flex items-center justify-between py-3.5 text-[13px]">
                      <div>
                        <div className="font-medium">主题外观</div>
                        <div className="text-[11px] opacity-55">
                          切换浅色、深色或跟随系统外观
                        </div>
                      </div>
                      <div className="relative grid grid-cols-3 rounded-[10px] bg-muted p-0.5 text-xs">
                        <div
                          className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc((100%-4px)/3)] rounded-[8px] bg-background shadow-[0_2px_6px_rgb(0_0_0/.10)] transition-transform duration-300 [transition-timing-function:var(--ease-apple)]"
                          style={{
                            transform: `translateX(${
                              (themeMode === "light" ? 0 : themeMode === "dark" ? 1 : 2) * 100
                            }%)`,
                          }}
                        />
                        {(
                          [
                            { id: "light", label: "浅色", Icon: Sun },
                            { id: "dark", label: "深色", Icon: Moon },
                            { id: "system", label: "自动", Icon: Monitor },
                          ] as { id: ThemeMode; label: string; Icon: typeof Sun }[]
                        ).map(({ id, label, Icon }) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onThemeChange(id)}
                            className={`relative z-10 flex items-center justify-center gap-1 rounded-[8px] px-2.5 py-1 transition-opacity duration-150 ${
                              themeMode === id
                                ? "font-medium opacity-100"
                                : "opacity-65 hover:opacity-100"
                            }`}
                          >
                            <Icon className="h-3 w-3" />
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">主题色</div>
                        <div className="text-[11px] opacity-55">
                          选择预设强调色或自定义取色
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {ACCENT_PRESETS.map((preset) => {
                          const active =
                            settings.accentColor.toLowerCase() ===
                            preset.color.toLowerCase();
                          return (
                            <button
                              key={preset.color}
                              type="button"
                              title={preset.name}
                              onClick={() => onUpdate({ accentColor: preset.color })}
                              className={`h-5 w-5 rounded-full transition-[opacity,box-shadow,transform] duration-200 [transition-timing-function:var(--ease-decelerate)] hover:opacity-85 active:scale-95 ${
                                active
                                  ? "ring-2 ring-foreground ring-offset-2 ring-offset-card"
                                  : ""
                              }`}
                              style={{ backgroundColor: preset.color }}
                            />
                          );
                        })}
                        <label
                          title="自定义颜色"
                          className="relative ml-1 flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border"
                          style={{ backgroundColor: settings.accentColor }}
                        >
                          <input
                            type="color"
                            value={settings.accentColor}
                            onChange={(e) =>
                              onUpdate({ accentColor: e.target.value })
                            }
                            className="absolute inset-0 cursor-pointer opacity-0"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
                    背景与缩放
                  </div>
                  <div className={CARD_CLS}>
                    <div className="flex items-center justify-between gap-4 py-3.5 text-[13px]">
                      <div>
                        <div className="font-medium">自定义背景图片</div>
                        <div className="text-[11px] opacity-55">
                          选择本地图片作为窗口背景（建议搭配全局不透明度使用）
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          ref={bgInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            void handleBgFile(e.target.files?.[0]);
                            e.currentTarget.value = "";
                          }}
                        />
                        {settings.backgroundImage && (
                          <div className="h-7 w-12 overflow-hidden rounded-md border border-border bg-muted">
                            <img
                              src={settings.backgroundImage}
                              alt="背景预览"
                              className="h-full w-full object-cover"
                            />
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => bgInputRef.current?.click()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-muted px-3 text-xs font-medium transition hover:bg-muted/80"
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                          <span>
                            {settings.backgroundImage ? "更换图片" : "选择图片"}
                          </span>
                        </button>
                        {settings.backgroundImage && (
                          <button
                            type="button"
                            onClick={() => {
                              setBgError(null);
                              onUpdate({ backgroundImage: "" });
                            }}
                            title="清除背景图片"
                            className="inline-flex h-8 items-center gap-1 rounded-[10px] bg-muted px-2.5 text-xs text-muted-foreground transition hover:text-destructive"
                          >
                            <X className="h-3.5 w-3.5" />
                            <span>清除</span>
                          </button>
                        )}
                      </div>
                    </div>
                    {bgError && (
                      <div className="pb-3 text-[11.5px] text-destructive">
                        {bgError}
                      </div>
                    )}

                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">全局不透明度</div>
                        <div className="text-[11px] opacity-55">
                          调整窗口整体不透明度（30% – 100%）
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={30}
                          max={100}
                          step={5}
                          value={settings.globalOpacity}
                          onChange={(e) =>
                            onUpdate({ globalOpacity: Number(e.target.value) })
                          }
                          className="w-32 accent-primary"
                        />
                        <span className="w-11 text-right text-xs tabular-nums opacity-75">
                          {settings.globalOpacity}%
                        </span>
                      </div>
                    </div>

                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">界面缩放</div>
                        <div className="text-[11px] opacity-55">
                          调整全局界面缩放比例
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        {[75, 100, 125].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => onUpdate({ uiScale: preset })}
                            className={`rounded-[7px] px-2 py-0.5 text-[11px] font-medium transition ${
                              settings.uiScale === preset
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {preset}%
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
                    侧边栏与概览显示
                  </div>
                  <div className={CARD_CLS}>
                    <div className="flex items-center justify-between py-3.5 text-[13px]">
                      <div>
                        <div className="font-medium">侧边栏显示系统图标与版本</div>
                        <div className="text-[11px] opacity-55">
                          关闭后在服务器名称下方显示 username@host:port
                        </div>
                      </div>
                      <Toggle
                        checked={settings.showSidebarOs}
                        onChange={(v) => onUpdate({ showSidebarOs: v })}
                      />
                    </div>
                    <div
                      className="flex items-center justify-between border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">侧边栏显示网络延迟</div>
                        <div className="text-[11px] opacity-55">
                          在服务器名称右侧显示实时 Ping 延迟指示
                        </div>
                      </div>
                      <Toggle
                        checked={settings.showSidebarLatency}
                        onChange={(v) => onUpdate({ showSidebarLatency: v })}
                      />
                    </div>
                    <div
                      className="flex items-center justify-between border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">概览卡片隐藏 IP 地址</div>
                        <div className="text-[11px] opacity-55">
                          开启后在概览卡片中脱敏显示主机地址，点击复制时仍复制完整地址
                        </div>
                      </div>
                      <Toggle
                        checked={settings.hideDashboardIp}
                        onChange={(v) => onUpdate({ hideDashboardIp: v })}
                      />
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === "terminal" && (
              <TerminalSettingsSection settings={settings} onUpdate={onUpdate} />
            )}

            {activeTab === "shortcuts" && (
              <ShortcutsSettingsSection
                shortcuts={settings.terminalShortcuts}
                onChange={(terminalShortcuts) => onUpdate({ terminalShortcuts })}
              />
            )}

            {activeTab === "monitor" && (
              <>
                <section className="space-y-2">
                  <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
                    探针与延迟探测
                  </div>
                  <div className={CARD_CLS}>
                    <div className="flex flex-col gap-2.5 py-3.5 text-[13px]">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="font-medium">探针刷新速率</div>
                          <div className="text-[11px] opacity-55">
                            仪表盘 CPU / 内存 / 网络采集间隔（≥ 5 秒对本地与远端几乎零占用）
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <NumericInput
                            min={1}
                            max={300}
                            value={settings.monitorIntervalSec}
                            onCommit={(monitorIntervalSec) =>
                              onUpdate({ monitorIntervalSec })
                            }
                            className="h-8 w-16 rounded-lg bg-muted px-2 text-center text-xs tabular-nums outline-none ring-1 ring-black/10 focus:ring-primary/50 dark:ring-white/10"
                          />
                          <span className="text-xs opacity-65">秒</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[
                          { sec: 1, label: "1 秒 · 实时" },
                          { sec: 3, label: "3 秒 · 默认" },
                          { sec: 5, label: "5 秒 · 低占用" },
                          { sec: 10, label: "10 秒 · 节能" },
                          { sec: 30, label: "30 秒 · 极低占用" },
                          { sec: 60, label: "60 秒 · 静默巡检" },
                        ].map((opt) => {
                          const active = settings.monitorIntervalSec === opt.sec;
                          return (
                            <button
                              key={opt.sec}
                              type="button"
                              onClick={() =>
                                onUpdate({ monitorIntervalSec: opt.sec })
                              }
                              className={`rounded-[8px] px-2.5 py-1 text-[11px] font-medium transition ${
                                active
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted text-muted-foreground hover:text-foreground"
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div
                      className="flex items-center justify-between border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">侧边栏延迟探测间隔</div>
                        <div className="text-[11px] opacity-55">
                          定期探测服务器 TCP 端口响应时间
                        </div>
                      </div>
                      <DropdownSelect
                        variant="compact"
                        align="right"
                        value={settings.pingIntervalSec}
                        onChange={(pingIntervalSec) =>
                          onUpdate({ pingIntervalSec })
                        }
                        options={[
                          { value: 10, label: "10 秒" },
                          { value: 30, label: "30 秒（默认）" },
                          { value: 60, label: "60 秒" },
                          { value: 0, label: "关闭自动探测" },
                        ]}
                        menuClassName="w-36"
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
                    SSH 默认连接参数
                  </div>
                  <div className={CARD_CLS}>
                    <div className="flex items-center justify-between py-3.5 text-[13px]">
                      <div className="font-medium">新建服务器默认端口</div>
                      <NumericInput
                        min={1}
                        max={65535}
                        value={settings.defaultSshPort}
                        onCommit={(defaultSshPort) =>
                          onUpdate({ defaultSshPort })
                        }
                        className="w-24 rounded-lg bg-muted px-3 py-1.5 text-right text-xs tabular-nums outline-none ring-1 ring-black/10 dark:ring-white/10"
                      />
                    </div>
                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div className="shrink-0 font-medium">默认私钥路径</div>
                      <input
                        type="text"
                        value={settings.defaultKeyPath}
                        onChange={(e) =>
                          onUpdate({ defaultKeyPath: e.target.value })
                        }
                        placeholder="~/.ssh/id_ed25519"
                        className="w-56 rounded-lg bg-muted px-3 py-1.5 text-xs outline-none ring-1 ring-black/10 dark:ring-white/10"
                      />
                    </div>
                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">默认连接超时时间</div>
                        <div className="text-[11px] opacity-55">
                          SSH TCP 握手与认证阶段最大等待时长（1 – 300 秒）
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumericInput
                          min={1}
                          max={300}
                          value={settings.defaultTimeoutSecs}
                          onCommit={(defaultTimeoutSecs) =>
                            onUpdate({ defaultTimeoutSecs })
                          }
                          className="w-20 rounded-lg bg-muted px-3 py-1.5 text-right text-xs tabular-nums outline-none ring-1 ring-black/10 dark:ring-white/10"
                        />
                        <span className="text-xs opacity-65">秒</span>
                      </div>
                    </div>
                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">默认心跳间隔时间</div>
                        <div className="text-[11px] opacity-55">
                          定期发送 SSH Keepalive 保活包防止连接断开（0 表示关闭）
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumericInput
                          min={0}
                          max={3600}
                          value={settings.defaultKeepaliveSecs}
                          onCommit={(defaultKeepaliveSecs) =>
                            onUpdate({ defaultKeepaliveSecs })
                          }
                          className="w-20 rounded-lg bg-muted px-3 py-1.5 text-right text-xs tabular-nums outline-none ring-1 ring-black/10 dark:ring-white/10"
                        />
                        <span className="text-xs opacity-65">秒</span>
                      </div>
                    </div>
                    <div
                      className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div>
                        <div className="font-medium">默认终端类型 (TERM)</div>
                        <div className="text-[11px] opacity-55">
                          打开 SSH PTY 交互终端时声明的环境变量类型
                        </div>
                      </div>
                      <select
                        value={settings.defaultTermType}
                        onChange={(e) =>
                          onUpdate({ defaultTermType: e.target.value })
                        }
                        className="rounded-lg bg-muted px-3 py-1.5 font-mono text-xs outline-none ring-1 ring-black/10 dark:ring-white/10"
                      >
                        {TERMINAL_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div
                      className="space-y-2.5 border-t py-3.5 text-[13px]"
                      style={{ borderColor: "var(--separator)" }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">默认认证方式优先级</div>
                          <div className="text-[11px] opacity-55">
                            新建服务器及未单独配置顺序的主机将按以下优先级依次尝试握手
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onUpdate({
                              defaultAuthPriority: [...DEFAULT_AUTH_PRIORITY],
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>恢复默认</span>
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {settings.defaultAuthPriority.map((stage, idx) => {
                          const meta = AUTH_STAGE_META[stage];
                          return (
                            <div
                              key={stage}
                              className="flex items-center justify-between gap-1.5 rounded-xl bg-muted/65 px-2.5 py-2 text-xs ring-1 ring-border/70"
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] font-semibold text-primary">
                                  {idx + 1}
                                </span>
                                <span className="truncate font-medium">
                                  {meta.label}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => {
                                    const next = [
                                      ...settings.defaultAuthPriority,
                                    ];
                                    const [moved] = next.splice(idx, 1);
                                    next.splice(idx - 1, 0, moved);
                                    onUpdate({ defaultAuthPriority: next });
                                  }}
                                  title="前移优先级"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-25"
                                >
                                  <ArrowUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    idx ===
                                    settings.defaultAuthPriority.length - 1
                                  }
                                  onClick={() => {
                                    const next = [
                                      ...settings.defaultAuthPriority,
                                    ];
                                    const [moved] = next.splice(idx, 1);
                                    next.splice(idx + 1, 0, moved);
                                    onUpdate({ defaultAuthPriority: next });
                                  }}
                                  title="后移优先级"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-25"
                                >
                                  <ArrowDown className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === "ai" && <AiSettingsSection />}

            {activeTab === "mcp" && <McpSettingsSection />}

            {activeTab === "sync" && (
              <SyncSettingsSection
                settings={settings}
                onSyncPulled={onSyncPulled}
                onSettingsPulled={onUpdate}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
