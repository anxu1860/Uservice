import type { ITheme } from "@xterm/xterm";

export interface TerminalColorScheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalThemePreset {
  id: string;
  name: string;
  description: string;
  theme: TerminalColorScheme;
}

export const SERVERHUB_DARK_THEME: TerminalColorScheme = {
  background: "#14161b",
  foreground: "#e4e4e7",
  cursor: "#3b82f6",
  cursorAccent: "#14161b",
  selectionBackground: "#3b82f652",
  black: "#1f2328",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#6e7681",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#ffffff",
};

export const SERVERHUB_LIGHT_THEME: TerminalColorScheme = {
  background: "#fafafa",
  foreground: "#1f2328",
  cursor: "#0969da",
  cursorAccent: "#fafafa",
  selectionBackground: "#0969da38",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#bf8700",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

export const TERMINAL_THEME_PRESETS: TerminalThemePreset[] = [
  {
    id: "serverhub-dark",
    name: "默认深色",
    description: "ServerHub 深邃炭黑",
    theme: SERVERHUB_DARK_THEME,
  },
  {
    id: "serverhub-light",
    name: "默认浅色",
    description: "ServerHub 清爽浅灰",
    theme: SERVERHUB_LIGHT_THEME,
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: "深蓝夜色高对比",
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c88",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "经典紫韵暗色",
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475aaa",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    description: "柔和暖调深色",
    theme: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b7088",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "one-dark",
    name: "One Dark Pro",
    description: "Atom / VS Code 经典",
    theme: {
      background: "#21252b",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#21252b",
      selectionBackground: "#3e4451aa",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    description: "北欧冰蓝护眼",
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#4c566a99",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    description: "复古暖棕高可读",
    theme: {
      background: "#1d2021",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#1d2021",
      selectionBackground: "#50494599",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "深青经典学术配色",
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642cc",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "柔和米白护眼浅色",
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5cc",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "monokai-pro",
    name: "Monokai Pro",
    description: "鲜明高饱和暗色",
    theme: {
      background: "#2d2a2e",
      foreground: "#fcfcfa",
      cursor: "#fcfcfa",
      cursorAccent: "#2d2a2e",
      selectionBackground: "#5b595c88",
      black: "#403e41",
      red: "#ff6188",
      green: "#a9dc76",
      yellow: "#ffd866",
      blue: "#fc9867",
      magenta: "#ab9df2",
      cyan: "#78dce8",
      white: "#fcfcfa",
      brightBlack: "#727072",
      brightRed: "#ff6188",
      brightGreen: "#a9dc76",
      brightYellow: "#ffd866",
      brightBlue: "#fc9867",
      brightMagenta: "#ab9df2",
      brightCyan: "#78dce8",
      brightWhite: "#ffffff",
    },
  },
];

export const DEFAULT_CUSTOM_TERMINAL_THEME: TerminalColorScheme = {
  ...SERVERHUB_DARK_THEME,
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

function pickColor(val: unknown, fallback: string): string {
  if (typeof val === "string" && HEX_COLOR_RE.test(val.trim())) {
    return val.trim();
  }
  return fallback;
}

export function sanitizeTerminalColorScheme(
  raw: unknown
): TerminalColorScheme {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_CUSTOM_TERMINAL_THEME };
  }
  const obj = raw as Record<string, unknown>;
  const d = DEFAULT_CUSTOM_TERMINAL_THEME;
  return {
    background: pickColor(obj.background, d.background),
    foreground: pickColor(obj.foreground, d.foreground),
    cursor: pickColor(obj.cursor, d.cursor),
    cursorAccent: pickColor(obj.cursorAccent, d.cursorAccent),
    selectionBackground: pickColor(obj.selectionBackground, d.selectionBackground),
    black: pickColor(obj.black, d.black),
    red: pickColor(obj.red, d.red),
    green: pickColor(obj.green, d.green),
    yellow: pickColor(obj.yellow, d.yellow),
    blue: pickColor(obj.blue, d.blue),
    magenta: pickColor(obj.magenta, d.magenta),
    cyan: pickColor(obj.cyan, d.cyan),
    white: pickColor(obj.white, d.white),
    brightBlack: pickColor(obj.brightBlack, d.brightBlack),
    brightRed: pickColor(obj.brightRed, d.brightRed),
    brightGreen: pickColor(obj.brightGreen, d.brightGreen),
    brightYellow: pickColor(obj.brightYellow, d.brightYellow),
    brightBlue: pickColor(obj.brightBlue, d.brightBlue),
    brightMagenta: pickColor(obj.brightMagenta, d.brightMagenta),
    brightCyan: pickColor(obj.brightCyan, d.brightCyan),
    brightWhite: pickColor(obj.brightWhite, d.brightWhite),
  };
}

export function resolveTerminalTheme(
  themeId: string,
  customTheme: TerminalColorScheme,
  appIsDark: boolean
): TerminalColorScheme {
  if (themeId === "custom") {
    return customTheme;
  }
  if (themeId === "auto") {
    return appIsDark ? SERVERHUB_DARK_THEME : SERVERHUB_LIGHT_THEME;
  }
  const preset = TERMINAL_THEME_PRESETS.find((p) => p.id === themeId);
  if (preset) return preset.theme;
  return appIsDark ? SERVERHUB_DARK_THEME : SERVERHUB_LIGHT_THEME;
}

export function toXtermTheme(scheme: TerminalColorScheme): ITheme {
  return { ...scheme };
}

/** Returns true if a #RRGGBB hex color is perceptually light. */
export function isLightHexColor(hex: string): boolean {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex.trim());
  if (!m) return false;
  const r = Number.parseInt(m[1], 16);
  const g = Number.parseInt(m[2], 16);
  const b = Number.parseInt(m[3], 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55;
}

/** Extracts the 6-digit #RRGGBB portion for <input type="color">. */
export function toSixDigitHex(hex: string, fallback = "#000000"): string {
  const m = /^#?([0-9a-fA-F]{6})/.exec(hex.trim());
  return m ? `#${m[1]}` : fallback;
}
