import { Server as ServerIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Server } from "../types";

export type ProviderId =
  | "tencent"
  | "aliyun"
  | "aws"
  | "gcp"
  | "azure"
  | "huawei"
  | "volcengine"
  | "cloudflare"
  | "digitalocean"
  | "vultr"
  | "hetzner"
  | "linode"
  | "oracle"
  | "generic";

export const CLOUD_PROVIDERS: { id: ProviderId | "auto"; label: string }[] = [
  { id: "auto", label: "自动识别（按名称/主机）" },
  { id: "tencent", label: "腾讯云 Tencent Cloud" },
  { id: "aliyun", label: "阿里云 Alibaba Cloud" },
  { id: "huawei", label: "华为云 Huawei Cloud" },
  { id: "volcengine", label: "火山引擎 Volcengine" },
  { id: "aws", label: "AWS Amazon" },
  { id: "gcp", label: "Google Cloud" },
  { id: "azure", label: "Microsoft Azure" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "digitalocean", label: "DigitalOcean" },
  { id: "vultr", label: "Vultr" },
  { id: "hetzner", label: "Hetzner" },
  { id: "linode", label: "Linode / Akamai" },
  { id: "oracle", label: "Oracle Cloud" },
  { id: "generic", label: "通用 Linux 服务器" },
];

const VALID_IDS = new Set<string>(
  CLOUD_PROVIDERS.map((p) => p.id).filter((id) => id !== "auto")
);

export function detectProvider(
  server: Pick<Server, "name" | "group" | "host" | "provider">
): ProviderId {
  if (server.provider && VALID_IDS.has(server.provider)) {
    return server.provider as ProviderId;
  }
  const haystack = `${server.name} ${server.group ?? ""} ${server.host}`.toLowerCase();

  if (/腾讯|tencent|qcloud|lighthouse/.test(haystack)) return "tencent";
  if (/阿里|aliyun|alibaba/.test(haystack)) return "aliyun";
  if (/华为|huawei/.test(haystack)) return "huawei";
  if (/火山|volc|bytedance/.test(haystack)) return "volcengine";
  if (/\baws\b|amazon|amazonaws|lightsail|\bec2\b/.test(haystack)) return "aws";
  if (/\bgcp\b|google|googleapis/.test(haystack)) return "gcp";
  if (/azure|microsoft/.test(haystack)) return "azure";
  if (/cloudflare/.test(haystack)) return "cloudflare";
  if (/digitalocean|droplet/.test(haystack)) return "digitalocean";
  if (/vultr/.test(haystack)) return "vultr";
  if (/hetzner/.test(haystack)) return "hetzner";
  if (/linode|akamai/.test(haystack)) return "linode";
  if (/oracle|\boci\b/.test(haystack)) return "oracle";
  return "generic";
}

interface ProviderIconProps {
  server: Pick<Server, "name" | "group" | "host" | "provider">;
  className?: string;
}

export function ProviderIcon({ server, className }: ProviderIconProps) {
  const id = detectProvider(server);
  const cls = cn("h-4 w-4 shrink-0", className);

  switch (id) {
    case "tencent":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="腾讯云">
          <path
            fill="#0052D9"
            d="M17.5 19H7a5 5 0 0 1-.8-9.93A6.5 6.5 0 0 1 18.7 8.4 4.5 4.5 0 0 1 17.5 19Z"
          />
          <path
            fill="#3698FF"
            d="M8.8 14.8c-.7 0-1.3-.56-1.3-1.25S8.1 12.3 8.8 12.3h4.9l1.35-1.95a1.1 1.1 0 1 1 1.8 1.26l-1.75 2.52a1.3 1.3 0 0 1-1.07.67H8.8Z"
          />
        </svg>
      );

    case "aliyun":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="阿里云">
          <path
            fill="#FF6A00"
            d="M3 6.5A2.5 2.5 0 0 1 5.5 4H8v3H6v10h2v3H5.5A2.5 2.5 0 0 1 3 17.5v-11Zm13-2.5h2.5A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H16v-3h2V7h-2V4Zm-7 6.5h6v3H9v-3Z"
          />
        </svg>
      );

    case "huawei":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="华为云">
          <path
            fill="#CF0A2C"
            d="M12 4c1.2 2.4 1.6 4.8 1.1 7.2 1.9-1.7 4-2.8 6.4-3.1-.7 2.4-2.1 4.3-4.2 5.7 2 .4 3.7 1.3 5 2.7-2.4.7-4.8.4-7-.8 1.2 1.9 1.6 3.9 1.1 6-1.8-1.4-2.9-3.2-3.4-5.4-.5 2.2-1.6 4-3.4 5.4-.5-2.1-.1-4.1 1.1-6-2.2 1.2-4.6 1.5-7 .8 1.3-1.4 3-2.3 5-2.7-2.1-1.4-3.5-3.3-4.2-5.7 2.4.3 4.5 1.4 6.4 3.1C10.4 8.8 10.8 6.4 12 4Z"
          />
        </svg>
      );

    case "volcengine":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="火山引擎">
          <path
            fill="#3370FF"
            d="M4.5 18.5 10.2 6.2c.4-.9 1.7-.9 2.1 0l2.7 5.8-3 6.5H4.5Z"
          />
          <path
            fill="#FF4D4F"
            d="M12.3 18.5 16 10.6c.4-.8 1.5-.8 1.9 0l3.6 7.9h-9.2Z"
          />
        </svg>
      );

    case "aws":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="AWS">
          <path
            fill="#FF9900"
            d="M4.2 15.6c4.5 3.1 10.9 3.3 15.6.2.4-.3.8.2.4.6-4.7 4-11.9 4-16.6.1-.4-.3.1-1.1.6-.9Zm16.9-1.1c-.4-.5-2.4-.3-3.3-.1-.3.1-.3-.2-.1-.4 1.6-1.1 4.2-.8 4.5-.4.3.4-.1 3-1.6 4.2-.2.2-.5.1-.4-.2.4-.9 1.2-2.7.9-3.1Z"
          />
          <path
            fill="currentColor"
            d="M7.8 12.2 6 6.8h1.5l1 3.7 1.1-3.7h1.4l1.1 3.7 1-3.7h1.4l-1.8 5.4H11.3L10.3 8.7l-1 3.5H7.8Zm8.7.1c-.9 0-1.7-.3-2.1-.7l.5-1c.5.4 1 .6 1.6.6.6 0 .9-.2.9-.6 0-.9-2.4-.4-2.4-2.2 0-1 .8-1.7 2.1-1.7.8 0 1.4.2 1.9.6l-.5 1c-.4-.3-.9-.5-1.4-.5-.5 0-.8.2-.8.5 0 .9 2.4.4 2.4 2.2 0 1.1-.8 1.8-2.2 1.8Z"
          />
        </svg>
      );

    case "gcp":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Google Cloud">
          <path
            fill="#EA4335"
            d="M12.2 6.8a4.9 4.9 0 0 1 3.4 1.4l2.2-2.2A8 8 0 0 0 5.3 9.7l2.7 2a4.8 4.8 0 0 1 4.2-4.9Z"
          />
          <path
            fill="#4285F4"
            d="M19.5 11.4a4.5 4.5 0 0 0-1.7-5.4l-2.2 2.2a4.8 4.8 0 0 1 1.4 3.4v.6h1a2.5 2.5 0 0 1 0 5h-6v3h6a5.5 5.5 0 0 0 1.5-8.8Z"
          />
          <path
            fill="#34A853"
            d="M6.5 17.2a4.8 4.8 0 0 0 5.5 3v-3H7.5a2.5 2.5 0 0 1-1-4.8L3.8 10.4a5.5 5.5 0 0 0 2.7 6.8Z"
          />
          <path
            fill="#FBBC05"
            d="M5.3 9.7A5.5 5.5 0 0 0 3.8 10.4l2.7 2a4.8 4.8 0 0 1 1.5-.7L5.3 9.7Z"
          />
        </svg>
      );

    case "azure":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Microsoft Azure">
          <path fill="#0078D4" d="M13.2 4 6.5 18.5h4.3l1.3-3.1h5.1l1.2 3.1H21L13.2 4Zm-.4 8.7 1.8-4.5 1.8 4.5h-3.6Z" />
          <path fill="#50E6FF" d="M9.6 6.2 3 18.5h4.5l4.2-9.2-2.1-3.1Z" />
        </svg>
      );

    case "cloudflare":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Cloudflare">
          <path
            fill="#F38020"
            d="M17.3 17.5H6.2a3.2 3.2 0 0 1-.4-6.37 5.2 5.2 0 0 1 9.96-1.43 3.7 3.7 0 0 1 4.14 3.67 3.6 3.6 0 0 1-2.6 4.13Z"
          />
        </svg>
      );

    case "digitalocean":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="DigitalOcean">
          <path
            fill="#0080FF"
            d="M12 4a8 8 0 1 1-8 8h3.1a4.9 4.9 0 1 0 4.9-4.9V4Zm0 12.9v3.1H8.9v-3.1H12Zm-3.1 0H6.3v-2.6h2.6v2.6Zm-2.6-2.6H4.4v-1.9h1.9v1.9Z"
          />
        </svg>
      );

    case "vultr":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Vultr">
          <path
            fill="#007BFC"
            d="M4 6h4.2l3.8 7.6L15.8 6H20l-6.4 12.5h-3.2L4 6Z"
          />
        </svg>
      );

    case "hetzner":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Hetzner">
          <rect x="3" y="3" width="18" height="18" rx="4" fill="#D50C2D" />
          <path
            fill="#fff"
            d="M7.5 6.5h2.6v4.2h3.8V6.5h2.6v11h-2.6v-4.4h-3.8v4.4H7.5v-11Z"
          />
        </svg>
      );

    case "linode":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Linode">
          <path
            fill="#00A95C"
            d="M12 3.5c-4.7 0-8.5 3.6-8.5 8.1 0 2.6 1.3 5 3.4 6.5-.2-.8-.3-1.7-.1-2.6.5-2.6 2.8-4.7 5.7-4.7 2.2 0 4.1 1.2 5 3 .4-1.8-.3-3.8-1.9-4.9-1.5-1.1-3.6-1.1-5.2-.2 1.1-1.9 3.2-3 5.5-2.7 2.4.3 4.4 1.9 5.2 4.1.7-3.9-2.1-7.6-9.1-7.6Z"
          />
        </svg>
      );

    case "oracle":
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Oracle Cloud">
          <rect
            x="3"
            y="7.5"
            width="18"
            height="9"
            rx="4.5"
            fill="none"
            stroke="#F80000"
            strokeWidth="2.8"
          />
        </svg>
      );

    case "generic":
    default:
      return <ServerIcon className={cn("h-4 w-4 shrink-0 text-primary", className)} />;
  }
}
