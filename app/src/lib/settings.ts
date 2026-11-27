import { useCallback, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getDefaultTerminalShortcuts,
  sanitizeTerminalShortcuts,
  type TerminalShortcuts,
} from "./shortcuts";
import {
  getDefaultHighlightRules,
  sanitizeHighlightRules,
  type TerminalHighlightRule,
} from "./terminalHighlight";
import {
  DEFAULT_CUSTOM_TERMINAL_THEME,
  sanitizeTerminalColorScheme,
  type TerminalColorScheme,
} from "./terminalTheme";
import {
  DEFAULT_AUTH_PRIORITY,
  sanitizeAuthPriority,
  type AuthStage,
} from "../types";

export type CursorStyle = "block" | "underline" | "bar";

export interface AppSettings {
  showSidebarOs: boolean;
  showSidebarLatency: boolean;
  hideDashboardIp: boolean;
  accentColor: string;
  backgroundImage: string;
  globalOpacity: number;
  uiScale: number;
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: CursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalThemeId: string;
  terminalCustomTheme: TerminalColorScheme;
  terminalZebraStripes: boolean;
  terminalHighlightEnabled: boolean;
  terminalHighlightRules: TerminalHighlightRule[];
  terminalShortcuts: TerminalShortcuts;
  monitorIntervalSec: number;
  pingIntervalSec: number;
  defaultSshPort: number;
  defaultKeyPath: string;
  defaultTimeoutSecs: number;
  defaultKeepaliveSecs: number;
  defaultTermType: string;
  defaultAuthPriority: AuthStage[];
}

export const ACCENT_PRESETS: { name: string; color: string }[] = [
  { name: "经典蓝", color: "#007aff" },
  { name: "靛蓝", color: "#5856d6" },
  { name: "紫罗兰", color: "#af52de" },
  { name: "洋红", color: "#ff2d55" },
  { name: "珊瑚红", color: "#ff3b30" },
  { name: "活力橙", color: "#ff9500" },
  { name: "翡翠绿", color: "#34c759" },
  { name: "青碧", color: "#00c7be" },
];

export const DEFAULT_TERMINAL_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", "Consolas", monospace';

export const TERMINAL_FONT_PRESETS: { label: string; value: string }[] = [
  { label: "系统等宽 (默认)", value: DEFAULT_TERMINAL_FONT_FAMILY },
  {
    label: "JetBrains Mono",
    value: '"JetBrains Mono", "JetBrainsMono Nerd Font", ui-monospace, Menlo, monospace',
  },
  {
    label: "MesloLGS Nerd Font",
    value: '"MesloLGS NF", "MesloLGS Nerd Font", ui-monospace, Menlo, monospace',
  },
  {
    label: "Fira Code",
    value: '"Fira Code", "FiraCode Nerd Font", ui-monospace, Menlo, monospace',
  },
  {
    label: "Cascadia Mono",
    value: '"Cascadia Mono", "Cascadia Code", "Consolas", ui-monospace, monospace',
  },
  {
    label: "SF Mono / Menlo",
    value: '"SF Mono", Menlo, Monaco, ui-monospace, monospace',
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  showSidebarOs: true,
  showSidebarLatency: true,
  hideDashboardIp: true,
  accentColor: "#007aff",
  backgroundImage: "",
  globalOpacity: 100,
  uiScale: 100,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontSize: 13,
  terminalLineHeight: 1.35,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalScrollback: 3000,
  terminalThemeId: "auto",
  terminalCustomTheme: { ...DEFAULT_CUSTOM_TERMINAL_THEME },
  terminalZebraStripes: false,
  terminalHighlightEnabled: true,
  terminalHighlightRules: getDefaultHighlightRules(),
  terminalShortcuts: getDefaultTerminalShortcuts(),
  monitorIntervalSec: 3,
  pingIntervalSec: 30,
  defaultSshPort: 22,
  defaultKeyPath: "~/.ssh/id_ed25519",
  defaultTimeoutSecs: 10,
  defaultKeepaliveSecs: 20,
  defaultTermType: "xterm-256color",
  defaultAuthPriority: [...DEFAULT_AUTH_PRIORITY],
};

const SETTINGS_STORAGE_KEY = "serverhub.settings.v1";

const SAFE_DATA_IMAGE_RE =
  /^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/;

export function sanitizeBackgroundImage(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 3 * 1024 * 1024) return "";
  return SAFE_DATA_IMAGE_RE.test(trimmed) ? trimmed : "";
}

export function sanitizeTerminalFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_FONT_FAMILY;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n;{}]/.test(trimmed)) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  return trimmed;
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function sanitizeSettings(
  raw: Partial<AppSettings> | null | undefined,
  base: AppSettings = DEFAULT_SETTINGS
): AppSettings {
  const parsed = raw && typeof raw === "object" ? raw : {};
  return {
    showSidebarOs:
      typeof parsed.showSidebarOs === "boolean"
        ? parsed.showSidebarOs
        : base.showSidebarOs,
    showSidebarLatency:
      typeof parsed.showSidebarLatency === "boolean"
        ? parsed.showSidebarLatency
        : base.showSidebarLatency,
    hideDashboardIp:
      typeof parsed.hideDashboardIp === "boolean"
        ? parsed.hideDashboardIp
        : base.hideDashboardIp,
    accentColor:
      typeof parsed.accentColor === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(parsed.accentColor.trim())
        ? parsed.accentColor.trim()
        : base.accentColor,
    backgroundImage:
      "backgroundImage" in parsed
        ? sanitizeBackgroundImage(parsed.backgroundImage)
        : sanitizeBackgroundImage(base.backgroundImage),
    globalOpacity: clampNumber(parsed.globalOpacity, base.globalOpacity, 30, 100),
    uiScale: clampNumber(parsed.uiScale, base.uiScale, 50, 150),
    terminalFontFamily:
      "terminalFontFamily" in parsed
        ? sanitizeTerminalFontFamily(parsed.terminalFontFamily)
        : sanitizeTerminalFontFamily(base.terminalFontFamily),
    terminalFontSize: clampNumber(
      parsed.terminalFontSize,
      base.terminalFontSize,
      10,
      24
    ),
    terminalLineHeight: clampNumber(
      parsed.terminalLineHeight,
      base.terminalLineHeight,
      1.0,
      2.0
    ),
    terminalCursorStyle:
      parsed.terminalCursorStyle === "block" ||
      parsed.terminalCursorStyle === "underline" ||
      parsed.terminalCursorStyle === "bar"
        ? parsed.terminalCursorStyle
        : base.terminalCursorStyle,
    terminalCursorBlink:
      typeof parsed.terminalCursorBlink === "boolean"
        ? parsed.terminalCursorBlink
        : base.terminalCursorBlink,
    terminalScrollback: clampNumber(
      parsed.terminalScrollback,
      base.terminalScrollback,
      500,
      20000
    ),
    terminalThemeId:
      typeof parsed.terminalThemeId === "string" && parsed.terminalThemeId.trim()
        ? parsed.terminalThemeId.trim().slice(0, 64)
        : base.terminalThemeId,
    terminalCustomTheme:
      "terminalCustomTheme" in parsed
        ? sanitizeTerminalColorScheme(parsed.terminalCustomTheme)
        : base.terminalCustomTheme,
    terminalZebraStripes:
      typeof parsed.terminalZebraStripes === "boolean"
        ? parsed.terminalZebraStripes
        : base.terminalZebraStripes,
    terminalHighlightEnabled:
      typeof parsed.terminalHighlightEnabled === "boolean"
        ? parsed.terminalHighlightEnabled
        : base.terminalHighlightEnabled,
    terminalHighlightRules:
      "terminalHighlightRules" in parsed
        ? sanitizeHighlightRules(parsed.terminalHighlightRules)
        : base.terminalHighlightRules,
    terminalShortcuts:
      "terminalShortcuts" in parsed
        ? sanitizeTerminalShortcuts(parsed.terminalShortcuts)
        : base.terminalShortcuts,
    monitorIntervalSec: clampNumber(
      parsed.monitorIntervalSec,
      base.monitorIntervalSec,
      1,
      300
    ),
    pingIntervalSec: clampNumber(
      parsed.pingIntervalSec,
      base.pingIntervalSec,
      0,
      300
    ),
    defaultSshPort: Math.round(
      clampNumber(parsed.defaultSshPort, base.defaultSshPort, 1, 65535)
    ),
    defaultKeyPath:
      typeof parsed.defaultKeyPath === "string" && parsed.defaultKeyPath.trim()
        ? parsed.defaultKeyPath.trim().slice(0, 512)
        : base.defaultKeyPath,
    defaultTimeoutSecs: Math.round(
      clampNumber(parsed.defaultTimeoutSecs, base.defaultTimeoutSecs, 1, 300)
    ),
    defaultKeepaliveSecs: Math.round(
      clampNumber(parsed.defaultKeepaliveSecs, base.defaultKeepaliveSecs, 0, 3600)
    ),
    defaultTermType:
      typeof parsed.defaultTermType === "string" && parsed.defaultTermType.trim()
        ? parsed.defaultTermType.trim().slice(0, 64)
        : base.defaultTermType,
    defaultAuthPriority:
      "defaultAuthPriority" in parsed
        ? sanitizeAuthPriority(parsed.defaultAuthPriority)
        : base.defaultAuthPriority,
  };
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return sanitizeSettings(parsed, DEFAULT_SETTINGS);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error("Failed to save settings:", err);
    return false;
  }
}

function hexToHslComponents(hex: string): string | null {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
  if (!m) return null;
  const r = Number.parseInt(m[1], 16) / 255;
  const g = Number.parseInt(m[2], 16) / 255;
  const b = Number.parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
}

let lastAppliedNativeZoom: number | null = null;
let nativeZoomUnavailable = false;

export function applyAppearanceSettings(settings: AppSettings): void {
  const root = document.documentElement;
  const hsl = hexToHslComponents(settings.accentColor);
  if (hsl) {
    root.style.setProperty("--hu-primary", hsl);
    root.style.setProperty("--accent", settings.accentColor);
  }

  const scalePct = clampNumber(settings.uiScale, 100, 50, 150);
  const scaleFactor = scalePct / 100;
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri && !nativeZoomUnavailable) {
    root.style.zoom = "";
    if (lastAppliedNativeZoom !== scaleFactor) {
      lastAppliedNativeZoom = scaleFactor;
      void getCurrentWebview()
        .setZoom(scaleFactor)
        .catch(() => {
          // Fallback to CSS zoom if native webview zoom is unavailable
          nativeZoomUnavailable = true;
          lastAppliedNativeZoom = null;
          root.style.zoom = scalePct === 100 ? "" : `${scalePct}%`;
        });
    }
  } else {
    root.style.zoom = scalePct === 100 ? "" : `${scalePct}%`;
  }

  const opacity = clampNumber(settings.globalOpacity, 100, 30, 100) / 100;
  root.style.opacity = opacity < 1 ? String(opacity) : "";
}

export function useSettings() {
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState((prev) => {
      const next = sanitizeSettings({ ...prev, ...patch }, prev);
      saveSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    saveSettings(DEFAULT_SETTINGS);
    setSettingsState(DEFAULT_SETTINGS);
  }, []);

  return { settings, updateSettings, resetSettings };
}
