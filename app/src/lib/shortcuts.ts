export type TerminalShortcutAction =
  | "clearScreen"
  | "copySelection"
  | "pasteClipboard"
  | "selectAll"
  | "toggleQuickInput"
  | "findInTerminal"
  | "toggleAiAssistant"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset";

export type TerminalShortcuts = Record<TerminalShortcutAction, string>;

export interface ShortcutDefinition {
  id: TerminalShortcutAction;
  label: string;
  description: string;
  macDefault: string;
  otherDefault: string;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: "clearScreen",
    label: "清屏",
    description: "清空当前终端屏幕与滚动缓冲区",
    macDefault: "Meta+K",
    otherDefault: "Ctrl+Shift+K",
  },
  {
    id: "copySelection",
    label: "复制终端选取",
    description: "复制终端中选中的文本（未选中内容时照常发送按键）",
    macDefault: "Meta+C",
    otherDefault: "Ctrl+Shift+C",
  },
  {
    id: "pasteClipboard",
    label: "粘贴系统剪贴板",
    description: "将系统剪贴板文本粘贴并发送到当前终端",
    macDefault: "Meta+V",
    otherDefault: "Ctrl+Shift+V",
  },
  {
    id: "selectAll",
    label: "全选终端内容",
    description: "选中当前终端缓冲区中的全部输出文本",
    macDefault: "Meta+A",
    otherDefault: "Ctrl+Shift+A",
  },
  {
    id: "toggleQuickInput",
    label: "切换快捷输入",
    description: "打开或收起底部快捷命令输入栏，方便编辑与批量发送",
    macDefault: "Meta+I",
    otherDefault: "Ctrl+Shift+I",
  },
  {
    id: "findInTerminal",
    label: "终端内搜索",
    description: "打开终端输出关键字搜索浮层",
    macDefault: "Meta+F",
    otherDefault: "Ctrl+Shift+F",
  },
  {
    id: "toggleAiAssistant",
    label: "切换 AI 运维助手",
    description: "打开或收起右侧 AI 运维助手面板",
    macDefault: "Meta+Shift+K",
    otherDefault: "Ctrl+Shift+L",
  },
  {
    id: "zoomIn",
    label: "放大终端字体",
    description: "临时增大当前终端会话的字体大小",
    macDefault: "Meta+=",
    otherDefault: "Ctrl+=",
  },
  {
    id: "zoomOut",
    label: "缩小终端字体",
    description: "临时减小当前终端会话的字体大小",
    macDefault: "Meta+-",
    otherDefault: "Ctrl+-",
  },
  {
    id: "zoomReset",
    label: "重置终端字体",
    description: "恢复当前终端会话至默认设置字号",
    macDefault: "Meta+0",
    otherDefault: "Ctrl+0",
  },
];

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
}

export function getDefaultTerminalShortcuts(): TerminalShortcuts {
  const mac = isMacPlatform();
  const result = {} as TerminalShortcuts;
  for (const def of SHORTCUT_DEFINITIONS) {
    result[def.id] = mac ? def.macDefault : def.otherDefault;
  }
  return result;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const CODE_TO_KEY: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

function normalizeKeyFromEvent(ev: KeyboardEvent): string | null {
  const { code, key } = ev;
  if (
    key === "Control" ||
    key === "Shift" ||
    key === "Alt" ||
    key === "Meta" ||
    key === "OS" ||
    key === "Process" ||
    key === "Dead"
  ) {
    return null;
  }

  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toUpperCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }
  if (CODE_TO_KEY[code]) {
    return CODE_TO_KEY[code];
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key;
}

const CANONICAL_KEY_MAP: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  escape: "Escape",
  esc: "Escape",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  plus: "=",
};

export function normalizeShortcutCombo(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Preserve "+" as the main key (e.g. "Meta++", "Ctrl + +", "+") before splitting on "+"
  const prepared = trimmed.replace(/(?:^|\+)\s*\+$/, "+__PLUS__");
  const tokens = prepared
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";

  const mods = new Set<string>();
  let mainKey = "";

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "ctrl" || lower === "control") {
      mods.add("Ctrl");
    } else if (lower === "alt" || lower === "option" || lower === "opt") {
      mods.add("Alt");
    } else if (lower === "shift") {
      mods.add("Shift");
    } else if (lower === "meta" || lower === "cmd" || lower === "command") {
      mods.add("Meta");
    } else if (lower === "mod") {
      mods.add(isMacPlatform() ? "Meta" : "Ctrl");
    } else if (token === "__PLUS__" || token === "+") {
      mainKey = "=";
    } else if (CANONICAL_KEY_MAP[lower]) {
      mainKey = CANONICAL_KEY_MAP[lower];
    } else if (/^f([1-9]|1[0-2])$/.test(lower)) {
      mainKey = lower.toUpperCase();
    } else {
      mainKey = token.length === 1 ? token.toUpperCase() : token;
    }
  }

  if (!mainKey) return "";
  const orderedMods = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...orderedMods, mainKey].join("+");
}

export function sanitizeTerminalShortcuts(
  raw: unknown
): TerminalShortcuts {
  const defaults = getDefaultTerminalShortcuts();
  if (!raw || typeof raw !== "object") return defaults;
  const record = raw as Record<string, unknown>;
  const result = { ...defaults };
  for (const def of SHORTCUT_DEFINITIONS) {
    const val = record[def.id];
    if (typeof val === "string") {
      result[def.id] = val === "" ? "" : normalizeShortcutCombo(val);
    }
  }
  return result;
}

export function eventToShortcutCombo(ev: KeyboardEvent): string | null {
  const mainKey = normalizeKeyFromEvent(ev);
  if (!mainKey) return null;

  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(mainKey);
  const hasPrimaryModifier = ev.ctrlKey || ev.metaKey || ev.altKey;
  if (!hasPrimaryModifier && !isFunctionKey) {
    return null;
  }

  const parts: string[] = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  parts.push(mainKey);
  return parts.join("+");
}

export function matchesShortcut(ev: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return false;

  const parts = normalized.split("+");
  const targetKey = parts[parts.length - 1];
  const needCtrl = parts.includes("Ctrl");
  const needAlt = parts.includes("Alt");
  const needShift = parts.includes("Shift");
  const needMeta = parts.includes("Meta");

  if (
    ev.ctrlKey !== needCtrl ||
    ev.altKey !== needAlt ||
    ev.metaKey !== needMeta
  ) {
    return false;
  }

  const actualKey = normalizeKeyFromEvent(ev);
  if (!actualKey) return false;

  // Allow Shift on "=" (i.e. Cmd/Ctrl + "+") when shortcut is bound to "=" without Shift
  if (targetKey === "=" && !needShift && (ev.key === "+" || ev.key === "=")) {
    return true;
  }

  if (ev.shiftKey !== needShift) {
    return false;
  }

  return actualKey.toLowerCase() === targetKey.toLowerCase();
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  "=": "+",
  "-": "−",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↵",
  Space: "Space",
};

export function formatShortcutParts(combo: string): string[] {
  if (!combo) return [];
  const normalized = normalizeShortcutCombo(combo);
  if (!normalized) return [];
  const mac = isMacPlatform();
  return normalized.split("+").map((part) => {
    if (part === "Meta") return mac ? "⌘" : "Win";
    if (part === "Ctrl") return mac ? "⌃" : "Ctrl";
    if (part === "Alt") return mac ? "⌥" : "Alt";
    if (part === "Shift") return mac ? "⇧" : "Shift";
    return KEY_DISPLAY_MAP[part] ?? part;
  });
}

export function formatShortcutLabel(combo: string): string {
  const parts = formatShortcutParts(combo);
  if (parts.length === 0) return "";
  return isMacPlatform() ? parts.join(" ") : parts.join(" + ");
}
