import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "serverhub.theme";

export function getStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") {
      return raw;
    }
  } catch {
    // Ignore storage access errors
  }
  return "system";
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const resolved = resolveTheme(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  try {
    void getCurrentWindow()
      .setTheme(mode === "system" ? null : mode)
      .catch(() => {});
  } catch {
    // Ignore outside Tauri runtime
  }
  return resolved;
}

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(getStoredTheme);
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolveTheme(getStoredTheme())
  );

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
    setResolved(applyTheme(next));
  };

  useEffect(() => {
    setResolved(applyTheme(mode));
    if (mode !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  return { mode, setMode, resolved };
}
