import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Palette,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_PRESETS,
  type AppSettings,
  type CursorStyle,
} from "@/lib/settings";
import {
  SAMPLE_PREVIEW_LINES,
  getDefaultHighlightRules,
  highlightPreviewLine,
  validateHighlightPattern,
  type TerminalHighlightRule,
} from "@/lib/terminalHighlight";
import {
  DEFAULT_CUSTOM_TERMINAL_THEME,
  TERMINAL_THEME_PRESETS,
  isLightHexColor,
  resolveTerminalTheme,
  toSixDigitHex,
  type TerminalColorScheme,
} from "@/lib/terminalTheme";
import { isDark } from "@/lib/theme";
import { DropdownSelect } from "./ui/dropdown-select";

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-1 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const INPUT_CLS =
  "rounded-lg bg-muted px-2.5 py-1.5 text-xs outline-none ring-1 ring-black/10 focus:ring-primary/50 dark:ring-white/10";

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

const CORE_COLOR_FIELDS: { key: keyof TerminalColorScheme; label: string }[] = [
  { key: "background", label: "背景色" },
  { key: "foreground", label: "前景色" },
  { key: "cursor", label: "光标色" },
  { key: "selectionBackground", label: "选区背景" },
];

const ANSI_COLOR_FIELDS: { key: keyof TerminalColorScheme; label: string }[] = [
  { key: "black", label: "黑" },
  { key: "red", label: "红" },
  { key: "green", label: "绿" },
  { key: "yellow", label: "黄" },
  { key: "blue", label: "蓝" },
  { key: "magenta", label: "紫" },
  { key: "cyan", label: "青" },
  { key: "white", label: "白" },
  { key: "brightBlack", label: "亮黑" },
  { key: "brightRed", label: "亮红" },
  { key: "brightGreen", label: "亮绿" },
  { key: "brightYellow", label: "亮黄" },
  { key: "brightBlue", label: "亮蓝" },
  { key: "brightMagenta", label: "亮紫" },
  { key: "brightCyan", label: "亮青" },
  { key: "brightWhite", label: "亮白" },
];

interface TerminalSettingsSectionProps {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}

export function TerminalSettingsSection({
  settings,
  onUpdate,
}: TerminalSettingsSectionProps) {
  const [showAnsiEditor, setShowAnsiEditor] = useState(false);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [darkPreview, setDarkPreview] = useState(() => isDark());

  useEffect(() => {
    const syncDark = () => setDarkPreview(isDark());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", syncDark);
    const observer = new MutationObserver(syncDark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      mq.removeEventListener("change", syncDark);
      observer.disconnect();
    };
  }, []);

  const activeScheme = useMemo(
    () =>
      resolveTerminalTheme(
        settings.terminalThemeId,
        settings.terminalCustomTheme,
        darkPreview
      ),
    [settings.terminalThemeId, settings.terminalCustomTheme, darkPreview]
  );

  const previewIsLight = isLightHexColor(activeScheme.background);
  const zebraBg = previewIsLight
    ? "rgba(0, 0, 0, 0.042)"
    : "rgba(255, 255, 255, 0.048)";

  const updateCustomColor = (key: keyof TerminalColorScheme, hex: string) => {
    const value = key === "selectionBackground" ? `${hex}55` : hex;
    onUpdate({
      terminalThemeId: "custom",
      terminalCustomTheme: {
        ...settings.terminalCustomTheme,
        [key]: value,
        ...(key === "background" ? { cursorAccent: hex } : {}),
      },
    });
  };

  const copyPresetToCustom = (presetId: string) => {
    const preset = TERMINAL_THEME_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    onUpdate({
      terminalThemeId: "custom",
      terminalCustomTheme: { ...preset.theme },
    });
  };

  const resetCustomTheme = () => {
    onUpdate({
      terminalCustomTheme: { ...DEFAULT_CUSTOM_TERMINAL_THEME },
    });
  };

  const updateRule = (id: string, patch: Partial<TerminalHighlightRule>) => {
    onUpdate({
      terminalHighlightRules: settings.terminalHighlightRules.map((r) =>
        r.id === id ? { ...r, ...patch } : r
      ),
    });
  };

  const deleteRule = (id: string) => {
    onUpdate({
      terminalHighlightRules: settings.terminalHighlightRules.filter(
        (r) => r.id !== id
      ),
    });
    if (expandedRuleId === id) setExpandedRuleId(null);
  };

  const moveRule = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    const list = [...settings.terminalHighlightRules];
    if (nextIdx < 0 || nextIdx >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(nextIdx, 0, item);
    onUpdate({ terminalHighlightRules: list });
  };

  const addRule = () => {
    const id = `custom-${Date.now()}`;
    const newRule: TerminalHighlightRule = {
      id,
      name: "新高亮规则",
      pattern: "\\bTODO\\b",
      enabled: true,
      ignoreCase: true,
      foreground: "#f472b6",
      bold: true,
    };
    onUpdate({
      terminalHighlightEnabled: true,
      terminalHighlightRules: [newRule, ...settings.terminalHighlightRules],
    });
    setExpandedRuleId(id);
  };

  const resetHighlightRules = () => {
    onUpdate({
      terminalHighlightEnabled: true,
      terminalHighlightRules: getDefaultHighlightRules(),
    });
    setExpandedRuleId(null);
  };

  return (
    <>
      {/* Live Terminal Preview */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <span className="text-[11px] font-semibold tracking-wide uppercase opacity-55">
            实时效果预览
          </span>
          <span className="text-[11px] opacity-50">
            配色 · 斑马纹 · 高亮规则实时生效
          </span>
        </div>
        <div
          className="overflow-hidden rounded-[18px] border border-border/80 shadow-sm"
          style={{
            backgroundColor: activeScheme.background,
            color: activeScheme.foreground,
          }}
        >
          <div
            className="flex items-center justify-between border-b px-3.5 py-2 text-[11px]"
            style={{
              borderColor: previewIsLight
                ? "rgba(0,0,0,0.08)"
                : "rgba(255,255,255,0.08)",
            }}
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f56]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#27c93f]" />
              <span className="ml-2 font-mono text-[10px] opacity-60">
                deploy@prod-01 — zsh
              </span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[10px] opacity-55">
              <span>{settings.terminalFontSize}px</span>
              {settings.terminalZebraStripes && <span>· 斑马纹</span>}
              {settings.terminalHighlightEnabled && <span>· 高亮已开启</span>}
            </div>
          </div>
          <div
            className="py-2 font-mono"
            style={{
              fontFamily: settings.terminalFontFamily,
              fontSize: `${Math.min(14, Math.max(11, settings.terminalFontSize))}px`,
              lineHeight: settings.terminalLineHeight,
            }}
          >
            {SAMPLE_PREVIEW_LINES.map((line, idx) => {
              const segments = settings.terminalHighlightEnabled
                ? highlightPreviewLine(line, settings.terminalHighlightRules)
                : [{ text: line }];
              return (
                <div
                  key={idx}
                  className="truncate px-3.5"
                  style={{
                    backgroundColor:
                      settings.terminalZebraStripes && idx % 2 === 1
                        ? zebraBg
                        : "transparent",
                  }}
                >
                  {segments.map((seg, sIdx) =>
                    seg.rule ? (
                      <span
                        key={sIdx}
                        style={{
                          color: seg.rule.foreground,
                          backgroundColor: seg.rule.background,
                          fontWeight: seg.rule.bold ? 600 : undefined,
                          fontStyle: seg.rule.italic ? "italic" : undefined,
                          textDecoration: seg.rule.underline
                            ? "underline"
                            : undefined,
                          borderRadius: seg.rule.background ? "3px" : undefined,
                          padding: seg.rule.background ? "0 2px" : undefined,
                        }}
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={sIdx}>{seg.text}</span>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Color Scheme & Zebra Stripes */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          <Palette className="h-3.5 w-3.5" />
          <span>终端配色与斑马纹</span>
        </div>
        <div className={CARD_CLS}>
          <div className="space-y-3 py-3.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium">配色方案</div>
                <div className="text-[11px] opacity-55">
                  选择内置终端主题，或切换至「自定义配色」自由调整每一项颜色
                </div>
              </div>
              <button
                type="button"
                onClick={() => onUpdate({ terminalThemeId: "auto" })}
                className={`rounded-[8px] px-2.5 py-1 text-[11px] font-medium transition ${
                  settings.terminalThemeId === "auto"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                跟随应用外观
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TERMINAL_THEME_PRESETS.map((preset) => {
                const active = settings.terminalThemeId === preset.id;
                const t = preset.theme;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onUpdate({ terminalThemeId: preset.id })}
                    className={`motion-press group relative flex flex-col gap-2 rounded-xl border p-2.5 text-left transition ${
                      active
                        ? "border-primary bg-primary/8 ring-1 ring-primary/40"
                        : "border-border/70 bg-muted/35 hover:border-border hover:bg-muted/60"
                    }`}
                  >
                    <div
                      className="flex h-9 w-full flex-col justify-between rounded-lg border border-black/10 p-1.5 dark:border-white/10"
                      style={{ backgroundColor: t.background }}
                    >
                      <div className="flex items-center gap-1">
                        {[t.red, t.yellow, t.green, t.cyan, t.blue, t.magenta].map(
                          (c, i) => (
                            <span
                              key={i}
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: c }}
                            />
                          )
                        )}
                      </div>
                      <div
                        className="truncate font-mono text-[9px] leading-none opacity-85"
                        style={{ color: t.foreground }}
                      >
                        $ ssh prod-01
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium">
                          {preset.name}
                        </div>
                        <div className="truncate text-[10px] opacity-55">
                          {preset.description}
                        </div>
                      </div>
                      {active && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                    </div>
                  </button>
                );
              })}

              {/* Custom Scheme Card */}
              <button
                type="button"
                onClick={() => onUpdate({ terminalThemeId: "custom" })}
                className={`motion-press relative flex flex-col gap-2 rounded-xl border p-2.5 text-left transition ${
                  settings.terminalThemeId === "custom"
                    ? "border-primary bg-primary/8 ring-1 ring-primary/40"
                    : "border-dashed border-border bg-muted/25 hover:bg-muted/50"
                }`}
              >
                <div
                  className="flex h-9 w-full flex-col justify-between rounded-lg border border-black/10 p-1.5 dark:border-white/10"
                  style={{
                    backgroundColor: settings.terminalCustomTheme.background,
                  }}
                >
                  <div className="flex items-center gap-1">
                    {[
                      settings.terminalCustomTheme.red,
                      settings.terminalCustomTheme.yellow,
                      settings.terminalCustomTheme.green,
                      settings.terminalCustomTheme.cyan,
                      settings.terminalCustomTheme.blue,
                      settings.terminalCustomTheme.magenta,
                    ].map((c, i) => (
                      <span
                        key={i}
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                  <div
                    className="truncate font-mono text-[9px] leading-none opacity-85"
                    style={{ color: settings.terminalCustomTheme.foreground }}
                  >
                    $ custom palette
                  </div>
                </div>
                <div className="flex items-center justify-between gap-1">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">
                      自定义配色
                    </div>
                    <div className="truncate text-[10px] opacity-55">
                      自由编辑终端调色板
                    </div>
                  </div>
                  {settings.terminalThemeId === "custom" && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </div>
              </button>
            </div>

            {/* Custom Theme Editor */}
            {settings.terminalThemeId === "custom" && (
              <div className="space-y-3 rounded-2xl border border-border/80 bg-muted/35 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold">自定义调色板</div>
                  <div className="flex items-center gap-1.5">
                    <DropdownSelect
                      variant="compact"
                      align="right"
                      value=""
                      placeholder="从预设复制..."
                      onChange={(presetId) => {
                        if (presetId) {
                          copyPresetToCustom(presetId);
                        }
                      }}
                      options={TERMINAL_THEME_PRESETS.map((p) => ({
                        value: p.id,
                        label: p.name,
                      }))}
                      className="px-2.5 py-1 text-[11px]"
                      menuClassName="w-48"
                    />
                    <button
                      type="button"
                      onClick={resetCustomTheme}
                      className="inline-flex h-7 items-center gap-1 rounded-lg bg-muted px-2 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>恢复默认</span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {CORE_COLOR_FIELDS.map(({ key, label }) => {
                    const hex = toSixDigitHex(settings.terminalCustomTheme[key]);
                    return (
                      <label
                        key={key}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-xl bg-background/80 px-2.5 py-2 text-xs ring-1 ring-border/70"
                      >
                        <div>
                          <div className="text-[11px] font-medium">{label}</div>
                          <div className="font-mono text-[10px] opacity-55">
                            {hex}
                          </div>
                        </div>
                        <input
                          type="color"
                          value={hex}
                          onChange={(e) =>
                            updateCustomColor(key, e.target.value)
                          }
                          className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                        />
                      </label>
                    );
                  })}
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowAnsiEditor((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                  >
                    {showAnsiEditor ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" />
                        <span>收起 ANSI 16 色调色板</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" />
                        <span>展开编辑 ANSI 16 色</span>
                      </>
                    )}
                  </button>
                  {showAnsiEditor && (
                    <div className="mt-2.5 grid grid-cols-4 gap-2 sm:grid-cols-8">
                      {ANSI_COLOR_FIELDS.map(({ key, label }) => {
                        const hex = toSixDigitHex(
                          settings.terminalCustomTheme[key]
                        );
                        return (
                          <label
                            key={key}
                            className="flex cursor-pointer flex-col items-center gap-1 rounded-lg bg-background/80 p-1.5 text-[10px] ring-1 ring-border/60"
                          >
                            <input
                              type="color"
                              value={hex}
                              onChange={(e) =>
                                updateCustomColor(key, e.target.value)
                              }
                              className="h-5 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                            />
                            <span className="opacity-70">{label}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">行间斑马纹</div>
              <div className="text-[11px] opacity-55">
                为终端奇偶行叠加柔和交替底纹，长日志横向阅读更轻松
              </div>
            </div>
            <Toggle
              checked={settings.terminalZebraStripes}
              onChange={(v) => onUpdate({ terminalZebraStripes: v })}
            />
          </div>
        </div>
      </section>

      {/* Custom Output Highlighting */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase opacity-55">
            <Sparkles className="h-3.5 w-3.5" />
            <span>自定义输出高亮</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={resetHighlightRules}
              title="恢复内置运维高亮方案"
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="h-3 w-3" />
              <span>恢复默认</span>
            </button>
            <button
              type="button"
              onClick={addRule}
              className="inline-flex items-center gap-1 rounded-md bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/20"
            >
              <Plus className="h-3 w-3" />
              <span>新增规则</span>
            </button>
          </div>
        </div>

        <div className={CARD_CLS}>
          <div className="flex items-center justify-between py-3.5 text-[13px]">
            <div>
              <div className="font-medium">启用终端输出高亮</div>
              <div className="text-[11px] opacity-55">
                自动高亮日志级别、IP、URL、时间戳与路径；进入 vim / htop 等全屏程序时自动跳过
              </div>
            </div>
            <Toggle
              checked={settings.terminalHighlightEnabled}
              onChange={(v) => onUpdate({ terminalHighlightEnabled: v })}
            />
          </div>

          <div
            className="divide-y border-t py-1"
            style={{ borderColor: "var(--separator)" }}
          >
            {settings.terminalHighlightRules.length === 0 ? (
              <div className="py-6 text-center text-xs opacity-55">
                暂无高亮规则，点击右上角「新增规则」或「恢复默认」
              </div>
            ) : (
              settings.terminalHighlightRules.map((rule, idx) => {
                const regexErr = validateHighlightPattern(rule.pattern);
                const expanded = expandedRuleId === rule.id;
                return (
                  <div key={rule.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRuleId(expanded ? null : rule.id)
                        }
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/15 dark:ring-white/20"
                          style={{
                            backgroundColor: rule.foreground,
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`truncate text-xs font-medium ${
                                !rule.enabled ? "opacity-45 line-through" : ""
                              }`}
                            >
                              {rule.name || "未命名规则"}
                            </span>
                            {rule.bold && (
                              <span className="rounded bg-muted px-1 text-[9px] font-bold opacity-70">
                                B
                              </span>
                            )}
                            {rule.italic && (
                              <span className="rounded bg-muted px-1 text-[9px] italic opacity-70">
                                I
                              </span>
                            )}
                            {rule.underline && (
                              <span className="rounded bg-muted px-1 text-[9px] underline opacity-70">
                                U
                              </span>
                            )}
                            {regexErr && (
                              <span
                                title={regexErr}
                                className="inline-flex items-center gap-0.5 text-[10px] text-destructive"
                              >
                                <AlertCircle className="h-3 w-3" />
                                正则错误
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[10px] opacity-50">
                            {rule.pattern}
                          </div>
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveRule(idx, -1)}
                          title="上移优先级"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={
                            idx === settings.terminalHighlightRules.length - 1
                          }
                          onClick={() => moveRule(idx, 1)}
                          title="下移优先级"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-25"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRule(rule.id)}
                          title="删除规则"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                        <div className="ml-1">
                          <Toggle
                            checked={rule.enabled}
                            onChange={(v) => updateRule(rule.id, { enabled: v })}
                          />
                        </div>
                      </div>
                    </div>

                    {expanded && (
                      <div className="mt-2.5 space-y-2.5 rounded-xl bg-muted/45 p-3 text-xs">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="space-y-1">
                            <div className="text-[11px] opacity-65">规则名称</div>
                            <input
                              type="text"
                              value={rule.name}
                              onChange={(e) =>
                                updateRule(rule.id, { name: e.target.value })
                              }
                              className={`w-full ${INPUT_CLS}`}
                            />
                          </label>
                          <label className="space-y-1">
                            <div className="text-[11px] opacity-65">
                              正则表达式 (JavaScript RegExp)
                            </div>
                            <input
                              type="text"
                              value={rule.pattern}
                              onChange={(e) =>
                                updateRule(rule.id, { pattern: e.target.value })
                              }
                              placeholder="例如: \bERROR\b"
                              className={`w-full font-mono ${INPUT_CLS} ${
                                regexErr ? "ring-destructive/70" : ""
                              }`}
                            />
                          </label>
                        </div>

                        {regexErr && (
                          <div className="flex items-center gap-1 text-[11px] text-destructive">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>{regexErr}</span>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-background/80 px-2 py-1 ring-1 ring-border/70">
                              <span className="text-[11px] opacity-70">前景</span>
                              <input
                                type="color"
                                value={toSixDigitHex(rule.foreground, "#38bdf8")}
                                onChange={(e) =>
                                  updateRule(rule.id, {
                                    foreground: e.target.value,
                                  })
                                }
                                className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
                              />
                            </label>

                            <div className="inline-flex items-center gap-1.5 rounded-lg bg-background/80 px-2 py-1 ring-1 ring-border/70">
                              <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] opacity-70">
                                <input
                                  type="checkbox"
                                  checked={Boolean(rule.background)}
                                  onChange={(e) =>
                                    updateRule(rule.id, {
                                      background: e.target.checked
                                        ? "#3b2f2f"
                                        : undefined,
                                    })
                                  }
                                  className="accent-primary"
                                />
                                <span>背景</span>
                              </label>
                              {rule.background && (
                                <input
                                  type="color"
                                  value={toSixDigitHex(
                                    rule.background,
                                    "#3b2f2f"
                                  )}
                                  onChange={(e) =>
                                    updateRule(rule.id, {
                                      background: e.target.value,
                                    })
                                  }
                                  className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
                                />
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                updateRule(rule.id, {
                                  ignoreCase: !rule.ignoreCase,
                                })
                              }
                              title="忽略大小写"
                              className={`rounded-md px-2 py-1 font-mono text-[11px] font-medium transition ${
                                rule.ignoreCase
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-background/80 text-muted-foreground ring-1 ring-border/70"
                              }`}
                            >
                              Aa
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateRule(rule.id, { bold: !rule.bold })
                              }
                              title="加粗"
                              className={`rounded-md px-2 py-1 text-[11px] font-bold transition ${
                                rule.bold
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-background/80 text-muted-foreground ring-1 ring-border/70"
                              }`}
                            >
                              B
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateRule(rule.id, { italic: !rule.italic })
                              }
                              title="斜体"
                              className={`rounded-md px-2 py-1 text-[11px] italic transition ${
                                rule.italic
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-background/80 text-muted-foreground ring-1 ring-border/70"
                              }`}
                            >
                              I
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                updateRule(rule.id, {
                                  underline: !rule.underline,
                                })
                              }
                              title="下划线"
                              className={`rounded-md px-2 py-1 text-[11px] underline transition ${
                                rule.underline
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-background/80 text-muted-foreground ring-1 ring-border/70"
                              }`}
                            >
                              U
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Typography */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          字体与排版
        </div>
        <div className={CARD_CLS}>
          <div className="space-y-2.5 py-3.5 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">终端字体</div>
                <div className="text-[11px] opacity-55">
                  选择常用等宽/Nerd Font 预设，或填写本机已安装的自定义字体栈
                </div>
              </div>
              <DropdownSelect
                variant="compact"
                align="right"
                value={
                  TERMINAL_FONT_PRESETS.some(
                    (p) => p.value === settings.terminalFontFamily
                  )
                    ? settings.terminalFontFamily
                    : "__custom__"
                }
                onChange={(val) => {
                  if (val !== "__custom__") {
                    onUpdate({ terminalFontFamily: val });
                  }
                }}
                options={[
                  ...TERMINAL_FONT_PRESETS.map((p) => ({
                    value: p.value,
                    label: p.label,
                  })),
                  ...(TERMINAL_FONT_PRESETS.some(
                    (p) => p.value === settings.terminalFontFamily
                  )
                    ? []
                    : [{ value: "__custom__", label: "自定义字体栈" }]),
                ]}
                menuClassName="w-48"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.terminalFontFamily}
                onChange={(e) =>
                  onUpdate({ terminalFontFamily: e.target.value })
                }
                placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
                className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[11px]`}
              />
              {settings.terminalFontFamily !== DEFAULT_TERMINAL_FONT_FAMILY && (
                <button
                  type="button"
                  onClick={() =>
                    onUpdate({
                      terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
                    })
                  }
                  title="恢复默认等宽字体"
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-muted px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>默认</span>
                </button>
              )}
            </div>
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">字体大小</div>
              <div className="text-[11px] opacity-55">
                实时调整终端字体尺寸（10px – 22px）
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <input
                type="range"
                min={10}
                max={22}
                step={1}
                value={settings.terminalFontSize}
                onChange={(e) =>
                  onUpdate({ terminalFontSize: Number(e.target.value) })
                }
                className="w-32 accent-primary"
              />
              <span className="w-10 text-right text-xs tabular-nums">
                {settings.terminalFontSize}px
              </span>
            </div>
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div className="font-medium">行高</div>
            <DropdownSelect
              variant="compact"
              align="right"
              value={settings.terminalLineHeight}
              onChange={(terminalLineHeight) =>
                onUpdate({ terminalLineHeight })
              }
              options={[
                { value: 1.2, label: "1.2（紧凑）" },
                { value: 1.35, label: "1.35（默认）" },
                { value: 1.5, label: "1.5（宽松）" },
              ]}
              menuClassName="w-36"
            />
          </div>
        </div>
      </section>

      {/* Cursor & Scrollback */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          光标与缓冲区
        </div>
        <div className={CARD_CLS}>
          <div className="flex items-center justify-between py-3.5 text-[13px]">
            <div className="font-medium">光标样式</div>
            <DropdownSelect
              variant="compact"
              align="right"
              value={settings.terminalCursorStyle}
              onChange={(terminalCursorStyle) =>
                onUpdate({
                  terminalCursorStyle: terminalCursorStyle as CursorStyle,
                })
              }
              options={[
                { value: "block", label: "方块 (Block)" },
                { value: "underline", label: "下划线 (Underline)" },
                { value: "bar", label: "竖线 (Bar)" },
              ]}
              menuClassName="w-44"
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div className="font-medium">光标闪烁</div>
            <Toggle
              checked={settings.terminalCursorBlink}
              onChange={(v) => onUpdate({ terminalCursorBlink: v })}
            />
          </div>
          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">历史回滚行数</div>
              <div className="text-[11px] opacity-55">
                终端保留的最大输出缓冲区行数
              </div>
            </div>
            <DropdownSelect
              variant="compact"
              align="right"
              value={settings.terminalScrollback}
              onChange={(terminalScrollback) =>
                onUpdate({ terminalScrollback })
              }
              options={[
                { value: 1000, label: "1,000 行" },
                { value: 3000, label: "3,000 行" },
                { value: 5000, label: "5,000 行" },
                { value: 10000, label: "10,000 行" },
              ]}
              menuClassName="w-36"
            />
          </div>
        </div>
      </section>
    </>
  );
}
