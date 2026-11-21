import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Server } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function copyToClipboard(text: string): Promise<boolean> {
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
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
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
  }
  parts.push(`${server.username}@${server.host}`);
  return parts.join(" ");
}

export function formatServerConnectionInfo(server: Server): string {
  const authText =
    server.auth.type === "key"
      ? server.auth.path.trim()
        ? `密钥 (${server.auth.path.trim()})`
        : "密钥"
      : "密码";

  return [
    `名称: ${server.name}`,
    `主机: ${server.host}:${server.port}`,
    `用户: ${server.username}`,
    `认证: ${authText}`,
    `SSH: ${formatSshCommand(server)}`,
  ].join("\n");
}
