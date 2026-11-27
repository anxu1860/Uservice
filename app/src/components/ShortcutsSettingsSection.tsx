import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import {
  SHORTCUT_DEFINITIONS,
  eventToShortcutCombo,
  formatShortcutParts,
  getDefaultTerminalShortcuts,
  type TerminalShortcutAction,
  type TerminalShortcuts,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

interface ShortcutsSettingsSectionProps {
  shortcuts: TerminalShortcuts;
  onChange: (next: TerminalShortcuts) => void;
}

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-1 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

export function ShortcutsSettingsSection({
  shortcuts,
  onChange,
}: ShortcutsSettingsSectionProps) {
  const [recordingId, setRecordingId] = useState<TerminalShortcutAction | null>(
    null
  );
  const [hintError, setHintError] = useState<string | null>(null);
  const defaults = useMemo(() => getDefaultTerminalShortcuts(), []);

  const conflicts = useMemo(() => {
    const comboMap = new Map<string, TerminalShortcutAction[]>();
    for (const def of SHORTCUT_DEFINITIONS) {
      const combo = shortcuts[def.id];
      if (!combo) continue;
      const list = comboMap.get(combo) ?? [];
      list.push(def.id);
      comboMap.set(combo, list);
    }
    const conflicted = new Set<TerminalShortcutAction>();
    for (const ids of comboMap.values()) {
      if (ids.length > 1) {
        ids.forEach((id) => conflicted.add(id));
      }
    }
    return conflicted;
  }, [shortcuts]);

  const hasCustomizations = useMemo(
    () => SHORTCUT_DEFINITIONS.some((def) => shortcuts[def.id] !== defaults[def.id]),
    [shortcuts, defaults]
  );

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (ev.key === "Escape" && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
        setRecordingId(null);
        setHintError(null);
        return;
      }

      if (
        (ev.key === "Backspace" || ev.key === "Delete") &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        !ev.shiftKey
      ) {
        onChange({ ...shortcuts, [recordingId]: "" });
        setRecordingId(null);
        setHintError(null);
        return;
      }

      const combo = eventToShortcutCombo(ev);
      if (!combo) {
        if (
          ev.key !== "Control" &&
          ev.key !== "Shift" &&
          ev.key !== "Alt" &&
          ev.key !== "Meta"
        ) {
          setHintError("请搭配 ⌘ / Ctrl / Alt 修饰键，或使用 F1–F12 功能键");
        }
        return;
      }

      onChange({ ...shortcuts, [recordingId]: combo });
      setRecordingId(null);
      setHintError(null);
    };

    const handlePointerDown = () => {
      setRecordingId(null);
      setHintError(null);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [recordingId, shortcuts, onChange]);

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 px-2">
        <div className="text-[11px] font-semibold tracking-wide uppercase opacity-55">
          终端快捷键自定义
        </div>
        {hasCustomizations && (
          <button
            type="button"
            onClick={() => {
              setRecordingId(null);
              setHintError(null);
              onChange(defaults);
            }}
            className="motion-press inline-flex items-center gap-1 rounded-[8px] bg-muted px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" />
            <span>恢复全部默认</span>
          </button>
        )}
      </div>

      <div className="px-2 text-[11.5px] text-muted-foreground">
        点击右侧快捷键即可录制新组合键；录制时按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">Esc</kbd> 取消，按 <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">Backspace</kbd> 清除绑定。修改后立即对所有终端生效。
      </div>

      {hintError && (
        <div className="motion-banner-enter flex items-center gap-1.5 rounded-[12px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{hintError}</span>
        </div>
      )}

      <div className={CARD_CLS}>
        {SHORTCUT_DEFINITIONS.map((def, idx) => {
          const combo = shortcuts[def.id];
          const isRecording = recordingId === def.id;
          const isModified = combo !== defaults[def.id];
          const isConflicted = conflicts.has(def.id);
          const parts = formatShortcutParts(combo);

          return (
            <div
              key={def.id}
              className={cn(
                "flex items-center justify-between gap-4 py-3.5 text-[13px]",
                idx > 0 && "border-t"
              )}
              style={idx > 0 ? { borderColor: "var(--separator)" } : undefined}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-card-foreground">
                    {def.label}
                  </span>
                  {isConflicted && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      快捷键冲突
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] opacity-55">
                  {def.description}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {isModified && !isRecording && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ ...shortcuts, [def.id]: defaults[def.id] })
                    }
                    title="恢复默认"
                    className="motion-press inline-flex h-7 w-7 items-center justify-center rounded-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setHintError(null);
                    setRecordingId(isRecording ? null : def.id);
                  }}
                  className={cn(
                    "motion-press inline-flex h-8 min-w-[116px] items-center justify-center gap-1 rounded-[10px] px-2.5 text-[12px] font-medium",
                    isRecording
                      ? "bg-primary/12 text-primary ring-2 ring-primary/50"
                      : isConflicted
                        ? "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/40 hover:bg-amber-500/15 dark:text-amber-400"
                        : "bg-muted text-foreground ring-1 ring-black/5 hover:bg-muted/80 dark:ring-white/10"
                  )}
                >
                  {isRecording ? (
                    <span className="animate-pulse text-[11.5px]">
                      请按下组合键…
                    </span>
                  ) : parts.length > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      {parts.map((part, i) => (
                        <kbd
                          key={`${part}-${i}`}
                          className="inline-flex min-w-[20px] items-center justify-center rounded-[5px] bg-card px-1.5 py-0.5 font-mono text-[11px] font-semibold text-card-foreground shadow-[0_1px_0_rgb(0_0_0/0.08)] ring-1 ring-border/70"
                        >
                          {part}
                        </kbd>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[11.5px] text-muted-foreground">
                      未设置
                    </span>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
