import { invoke } from "@tauri-apps/api/core";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Server } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function copyToClipboard(text: string): Promise<boolean> {
  // Prefer native Tauri backend clipboard so async handlers (e.g. after fetching secrets)
  // never fail due to WebKit/WKWebView user-gesture expiration or permission blocks.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      await invoke("clipboard_write", { text });
      return true;
    } catch {
      // Fall through to browser clipboard APIs below.
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below when clipboard API is blocked or unavailable.
    }
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  const prevFocus = document.activeElement as HTMLElement | null;
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    prevFocus?.focus?.({ preventScroll: true });
  }
}

export function formatSshCommand(server: Server): string {
  const parts = ["ssh"];
  if (server.port !== 22) {
    parts.push("-p", String(server.port));
  }
  if (server.auth.type === "key" && server.auth.path.trim()) {
    const keyPath = server.auth.path.trim();
    parts.push("-i", /\s/.test(keyPath) ? `"${keyPath}"` : keyPath);
  } else if (server.auth.type === "ask" && server.auth.key_path?.trim()) {
    const keyPath = server.auth.key_path.trim();
    parts.push("-i", /\s/.test(keyPath) ? `"${keyPath}"` : keyPath);
  }
  parts.push(`${server.username}@${server.host}`);
  return parts.join(" ");
}

export function formatServerConnectionInfo(
  server: Server,
  options?: { credentialName?: string | null }
): string {
  let authText = "密码认证";
  switch (server.auth.type) {
    case "key":
      authText = server.auth.path.trim()
        ? `SSH 私钥 (${server.auth.path.trim()})`
        : "SSH 私钥";
      break;
    case "credential": {
      const credLabel =
        options?.credentialName?.trim() ||
        server.auth.credential_id ||
        "已绑定";
      authText = `登录凭证 (${credLabel})`;
      break;
    }
    case "keyboard_interactive":
      authText = "交互认证 (Keyboard-Interactive)";
      break;
    case "ask":
      authText = server.auth.key_path?.trim()
        ? `每次询问 (${server.auth.key_path.trim()})`
        : "每次询问";
      break;
    case "password":
    default:
      authText = "密码认证";
      break;
  }

  return [
    `名称: ${server.name}`,
    `主机: ${server.host}:${server.port}`,
    `用户: ${server.username}`,
    `认证: ${authText}`,
    `SSH: ${formatSshCommand(server)}`,
  ].join("\n");
}
