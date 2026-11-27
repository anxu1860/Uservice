import { useEffect, useState } from "react";
import {
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Database,
  ExternalLink,
  FolderSync,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import {
  siAlist,
  siCloudflare,
  siMinio,
  siNextcloud,
  siSynology,
} from "simple-icons";
import type { AppSettings } from "@/lib/settings";
import {
  DEFAULT_SYNC_CONFIG,
  detectLocalClouds,
  getSyncConfig,
  pullSync,
  pushSync,
  runSyncNow,
  S3_PRESETS,
  saveSyncConfig,
  startSyncOAuth,
  testSyncConnection,
  WEBDAV_PRESETS,
  type CloudDriveMode,
  type DetectedLocalClouds,
  type S3PresetBrand,
  type SyncConfig,
  type SyncProvider,
  type SyncSecretFlags,
  type SyncSecretPatch,
  type WebdavPresetBrand,
} from "@/lib/sync";
import { DropdownSelect } from "./ui/dropdown-select";

interface SyncSettingsSectionProps {
  settings: AppSettings;
  onSyncPulled?: () => void;
  onSettingsPulled?: (patch: Partial<AppSettings>) => void;
}

const CARD_CLS =
  "rounded-[22px] bg-card px-5 py-4 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const LIST_CARD_CLS =
  "rounded-[22px] bg-card px-5 py-1 shadow-[0_0_0_0.5px_var(--color-border),0_8px_24px_rgb(0_0_0/0.04)]";

const INPUT_CLS =
  "w-full rounded-xl border border-border bg-background/80 px-3 py-2 text-xs outline-none transition focus:border-primary";

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

function ProviderLogo({
  provider,
  className = "h-5 w-5",
}: {
  provider: SyncProvider;
  className?: string;
}) {
  switch (provider) {
    case "google_drive":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d="M8.27 3.5h7.46l6.77 11.73-3.73 6.47H11.3l6.77-11.73z" fill="#FFBA00" />
          <path d="M1.5 15.23 8.27 3.5l3.73 6.47-6.77 11.73z" fill="#00AC47" />
          <path d="M5.23 21.7h13.54l3.73-6.47H8.96z" fill="#2684FC" />
        </svg>
      );
    case "icloud":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            d="M17.8 19.2H6.7a4.7 4.7 0 0 1-.83-9.33A6.2 6.2 0 0 1 18.02 8.7a4.3 4.3 0 0 1-.22 10.5z"
            fill="#3693F3"
          />
        </svg>
      );
    case "onedrive":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            d="M10.1 7.6a5.4 5.4 0 0 1 9.54 2.42 4.1 4.1 0 0 1 2.86 3.91c0 2.26-1.84 4.07-4.1 4.07H6.2a4.7 4.7 0 0 1-.82-9.33 5.4 5.4 0 0 1 4.72-1.07z"
            fill="#0364B8"
          />
          <path
            d="M14.2 11.6a4.5 4.5 0 0 1 4.5 4.4c0 1.1-.4 2-1.1 2H6.2a4.7 4.7 0 0 1-.82-9.33 5.2 5.2 0 0 1 5.38 1.5l3.44 1.43z"
            fill="#28A8EA"
          />
        </svg>
      );
    case "webdav":
      return <Globe className={`${className} text-emerald-500`} />;
    case "github_gist":
      return (
        <svg viewBox="0 0 24 24" className={`${className} fill-current`} aria-hidden="true">
          <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.17c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5z" />
        </svg>
      );
    case "s3":
      return <Database className={`${className} text-amber-500`} />;
    case "local_folder":
      return <FolderSync className={`${className} text-violet-500`} />;
  }
}

function WebdavPresetLogo({
  brand,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  brand: WebdavPresetBrand;
  className?: string;
}) {
  switch (brand) {
    case "fnos":
      return (
        <svg
          viewBox="0 0 43.89 34.33"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M39.3916 0C39.3916 0 41.5349 4.21968 40.553 6.67786C40.0504 7.9362 38.5932 9.43611 36.9963 9.43611H16.078C13.0714 9.43611 10.6341 11.8734 10.6341 14.88V30.1955C10.6341 32.4805 12.4864 34.3329 14.7714 34.3329H20.4657C21.9489 34.3329 23.1513 33.1305 23.1513 31.6472V28.1211H27.0804C28.5636 28.1211 29.766 26.9187 29.766 25.4355V22.3563C33.1388 22.3563 36.3201 20.7885 38.3747 18.1137L38.5726 17.856H27.9514C26.4681 17.856 25.2657 19.0584 25.2657 20.5417V23.0402C25.2657 23.3609 25.0057 23.6208 24.685 23.6208H21.3367C19.8534 23.6208 18.651 24.8232 18.651 26.3065V28.7882C18.651 29.365 18.1834 29.8326 17.6066 29.8326H16.1788C15.602 29.8326 15.1344 29.365 15.1344 28.7882V14.88C15.1344 14.3589 15.5568 13.9364 16.078 13.9364H38.448C41.4546 13.9364 43.8919 11.4991 43.8919 8.4925C43.8919 5.7605 42.7596 3.15069 40.7645 1.2843L39.3916 0ZM3.33893 6.69872C2.35708 4.24054 4.50029 0.0208569 4.50029 0.0208569L3.12742 1.30516C1.13232 3.17155 0 5.78135 0 8.51335C0 11.5199 2.43732 13.9573 5.4439 13.9573H6.77373V13.9358C6.77373 12.1934 7.42685 10.6035 8.50163 9.3977C4.9625 9.10792 3.7825 7.80925 3.33893 6.69872Z"
            fill="#3374DB"
          />
        </svg>
      );
    case "synology":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d={siSynology.path} fill="#0066CC" />
        </svg>
      );
    case "ugreen":
      return (
        <svg
          viewBox="31.54 11.44 86.93 129.63"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M36.21,56.43c8.12,16.43,15.61,13.88,24.28,29.62V39.6c0-15.55-12.96-28.15-28.95-28.15v26.39c.26,5.25,.53,10.23,4.67,18.6Zm24.28,78.24v-24.2c.16-12.01-7.13-26.61-16.7-33.75-3.94-3.35-8-6.82-12.25-14.49v37.98c0,19.49,13.67,36.08,32.41,40.86-2.09-1.4-3.45-3.74-3.45-6.39ZM118.46,37.83V11.44c-15.99,0-28.95,12.6-28.95,28.15v46.45c4.25-7.68,8.31-11.15,12.26-14.5,9.57-7.12,16.86-21.77,16.7-33.72Zm-32.41,103.22c18.74-4.77,32.41-21.37,32.41-40.86,0,0,0-37.98,0-37.98-4.25,7.67-8.31,11.14-12.25,14.49-9.61,7.16-16.85,21.76-16.7,33.75v24.2c0,2.65-1.37,4.99-3.45,6.39Z"
            fill="#00C482"
          />
        </svg>
      );
    case "jianguoyun":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            d="M17.6 18.8H6.9a4.3 4.3 0 0 1-.76-8.54A5.7 5.7 0 0 1 17.78 9.2a3.95 3.95 0 0 1-.18 9.6z"
            fill="#1D8CE0"
          />
          <path
            d="M12 10.2c1.66 0 3 1.48 3 3.3 0 2.15-1.8 3.9-3 4.5-1.2-.6-3-2.35-3-4.5 0-1.82 1.34-3.3 3-3.3z"
            fill="#FFFFFF"
          />
          <path
            d="M12 8.7c.4 0 .75.3.75.7v1.1h-1.5V9.4c0-.4.35-.7.75-.7z"
            fill="#F5A623"
          />
        </svg>
      );
    case "alist":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d={siAlist.path} fill={`#${siAlist.hex}`} />
        </svg>
      );
    case "nextcloud":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d={siNextcloud.path} fill={`#${siNextcloud.hex}`} />
        </svg>
      );
  }
}

function S3PresetLogo({
  brand,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  brand: S3PresetBrand;
  className?: string;
}) {
  switch (brand) {
    case "cloudflare":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d={siCloudflare.path} fill={`#${siCloudflare.hex}`} />
        </svg>
      );
    case "aws":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          fillRule="evenodd"
          className={className}
          aria-hidden="true"
        >
          <path d="M6.763 11.212c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 01-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 01-.287-.375 6.18 6.18 0 01-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.39-.384-.59-.894-.59-1.533 0-.678.24-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.4 2.4 0 01-.28.104.488.488 0 01-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 01.224-.167 4.577 4.577 0 011.005-.36 4.84 4.84 0 011.246-.151c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586h.016zm-3.24 1.214c.263 0 .534-.048.822-.144a1.78 1.78 0 00.758-.51 1.27 1.27 0 00.272-.512c.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 00-.735-.136 6.02 6.02 0 00-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 6.726a1.398 1.398 0 01-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 01.32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 01.311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 01-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 01-.303.08h-.687c-.15 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32L12.32 7.747l-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08l-.686.001zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 01-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.32.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 00.415-.758.777.777 0 00-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 01-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .36.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 01.24.2.43.43 0 01.071.263v.375c0 .168-.064.256-.184.256a.83.83 0 01-.303-.096 3.652 3.652 0 00-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.16.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.157 2.157 0 01-.583.703c-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z" />
          <path
            d="M.378 15.475c3.384 1.963 7.56 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.44-.2.814.287.383.607-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351zm23.531-.2c.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151l.175-.439c.343-.88.802-2.198.52-2.555-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399z"
            fill="#FF9900"
          />
        </svg>
      );
    case "aliyun":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            d="M14.752 4.64h5.274C22.242 4.64 24 6.475 24 8.691V15.8a3.947 3.947 0 01-3.974 3.975h-5.274l1.299-1.835 3.822-1.222c.688-.23 1.146-.918 1.146-1.605v-5.81c0-.687-.458-1.375-1.146-1.605L16.05 6.475l-1.3-1.835zM2.98 15.111c0 .688.46 1.376 1.147 1.606l3.822 1.146 1.3 1.835H3.974A3.947 3.947 0 010 15.723V8.69c0-2.216 1.758-4.05 3.975-4.05h5.273L7.95 6.474 4.127 7.697c-.688.23-1.146.918-1.146 1.606v5.808z"
            fill="#FF6A00"
          />
          <path d="M16.051 11.213H8.025v1.835h8.026v-1.835z" fill="#FF6A00" />
        </svg>
      );
    case "tencent":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path
            d="M20.0483 17.1416C19.6945 17.4914 18.987 18.0161 17.7488 18.0161C17.2182 18.0161 16.5991 18.0161 16.3338 18.0161C15.98 18.0161 13.3268 18.0161 10.143 18.0161C12.4424 15.8298 14.3881 13.9932 14.565 13.8183C14.7419 13.6434 15.1841 13.2061 15.6263 12.8563C16.5107 12.0692 17.2182 11.9817 17.8373 11.9817C18.7217 11.9817 19.4292 12.3316 20.0483 12.8563C21.2864 13.9932 21.2864 16.0047 20.0483 17.1416ZM21.5518 11.457C20.6674 10.495 19.3408 9.88281 17.9257 9.88281C16.6875 9.88281 15.6263 10.3201 14.6534 11.0197C14.2997 11.3695 13.769 11.7194 13.3268 12.2441C12.9731 12.5939 5.36719 19.9401 5.36719 19.9401C5.80939 20.0276 6.34003 20.0276 6.78223 20.0276C7.22443 20.0276 16.0685 20.0276 16.4222 20.0276C17.1298 20.0276 17.6604 20.0276 18.191 19.9401C19.3408 19.8527 20.4905 19.4154 21.4633 18.5409C23.4975 16.6168 23.4975 13.381 21.5518 11.457Z"
            fill="#00A3FF"
          />
          <path
            d="M9.1701 10.9323C8.19726 10.2326 7.22442 9.88281 6.07469 9.88281C4.65965 9.88281 3.33304 10.495 2.44864 11.457C0.502952 13.4685 0.502952 16.6168 2.53708 18.6283C3.42148 19.4154 4.30589 19.8527 5.36717 19.9401L7.4013 18.0161C7.04754 18.0161 6.60533 18.0161 6.25157 18.0161C5.10185 17.9287 4.39433 17.5789 3.95212 17.1416C2.71396 15.9172 2.71396 13.9932 3.86368 12.7688C4.48277 12.1566 5.19029 11.8943 6.07469 11.8943C6.60533 11.8943 7.4013 11.9817 8.19726 12.7688C8.55102 13.1186 9.52386 13.8183 9.87763 14.1681H9.96607L11.2927 12.8563V12.7688C10.6736 12.1566 9.70075 11.3695 9.1701 10.9323Z"
            fill="#00C8DC"
          />
          <path
            d="M18.4564 8.74536C17.4836 6.12171 14.9188 4.28516 12.0003 4.28516C8.5511 4.28516 5.80945 6.82135 5.27881 9.96973C5.54413 9.96973 5.80945 9.88228 6.16321 9.88228C6.51697 9.88228 6.95917 9.96973 7.31294 9.96973C7.75514 7.78336 9.70082 6.20917 12.0003 6.20917C13.946 6.20917 15.6263 7.34608 16.4223 9.00773C16.4223 9.00773 16.5107 9.09518 16.5107 9.00773C17.1298 8.92027 17.8373 8.74536 18.4564 8.74536C18.4564 8.83282 18.4564 8.83282 18.4564 8.74536Z"
            fill="#006EFF"
          />
        </svg>
      );
    case "minio":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
          <path d={siMinio.path} fill={`#${siMinio.hex}`} />
        </svg>
      );
  }
}

interface ProviderMeta {
  id: SyncProvider;
  name: string;
  subtitle: string;
  group: "cloud" | "other";
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "google_drive",
    name: "Google Drive",
    subtitle: "桌面同步目录 / OAuth API",
    group: "cloud",
  },
  {
    id: "icloud",
    name: "iCloud Drive",
    subtitle: "Apple 生态原生云盘同步",
    group: "cloud",
  },
  {
    id: "onedrive",
    name: "Microsoft OneDrive",
    subtitle: "微软网盘目录 / Graph API",
    group: "cloud",
  },
  {
    id: "webdav",
    name: "WebDAV / 飞牛 NAS",
    subtitle: "飞牛 fnOS / 群晖 / 坚果云 / Alist",
    group: "other",
  },
  {
    id: "github_gist",
    name: "GitHub Gist",
    subtitle: "私有 Gist 加密同步",
    group: "other",
  },
  {
    id: "s3",
    name: "S3 对象存储",
    subtitle: "R2 / AWS S3 / OSS / COS / MinIO",
    group: "other",
  },
  {
    id: "local_folder",
    name: "本地 / 网盘目录",
    subtitle: "Dropbox / Syncthing / SMB",
    group: "other",
  },
];

function formatSyncTime(ts: number | null): string {
  if (!ts) return "尚未同步";
  try {
    return new Date(ts * 1000).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "未知时间";
  }
}

function compactSyncMessage(raw: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/^[，,·\s]*(双向同步完成|已上传至云端|已从云端拉取)/, "$1")
    .replace(/[，,]\s*0\s*个\s*AI\s*配置/g, "")
    .replace(/·\s*0\s*个\s*AI\s*配置/g, "")
    .replace(/[，,]\s*0\s*条密钥/g, "")
    .replace(/·\s*0\s*条密钥/g, "")
    .trim();
}

export function SyncSettingsSection({
  settings,
  onSyncPulled,
  onSettingsPulled,
}: SyncSettingsSectionProps) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [flags, setFlags] = useState<SyncSecretFlags>({
    has_passphrase: false,
    has_webdav_password: false,
    has_github_token: false,
    has_s3_secret_key: false,
    has_google_token: false,
    has_google_client_secret: false,
    has_onedrive_token: false,
  });
  const [clouds, setClouds] = useState<DetectedLocalClouds>({
    icloud_path: null,
    google_drive_path: null,
    onedrive_path: null,
    dropbox_path: null,
  });

  // Draft secrets (never prefilled from backend)
  const [webdavPassInput, setWebdavPassInput] = useState("");
  const [githubTokenInput, setGithubTokenInput] = useState("");
  const [s3SecretInput, setS3SecretInput] = useState("");
  const [googleTokenInput, setGoogleTokenInput] = useState("");
  const [googleClientSecretInput, setGoogleClientSecretInput] = useState("");
  const [onedriveTokenInput, setOnedriveTokenInput] = useState("");

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncingAction, setSyncingAction] = useState<
    null | "sync" | "push" | "pull" | "oauth"
  >(null);
  const [passphraseModal, setPassphraseModal] = useState<{
    pendingMode?: "sync" | "push" | "pull";
  } | null>(null);
  const [modalPassInput, setModalPassInput] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  useEffect(() => {
    void Promise.all([getSyncConfig(), detectLocalClouds()])
      .then(([res, detected]) => {
        setConfig(res.config);
        setFlags(res.secrets);
        setClouds(detected);
      })
      .catch((err) => {
        setConfig(DEFAULT_SYNC_CONFIG);
        setFeedback({ ok: false, text: `加载同步配置失败：${String(err)}` });
      });
  }, []);

  if (!config) {
    return (
      <div className="flex items-center justify-center py-12 text-xs opacity-60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载同步设置…
      </div>
    );
  }

  const updateCfg = (patch: Partial<SyncConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const buildSecretPatch = (): SyncSecretPatch | undefined => {
    const patch: SyncSecretPatch = {};
    let any = false;
    if (webdavPassInput.trim()) {
      patch.webdav_password = webdavPassInput.trim();
      any = true;
    }
    if (githubTokenInput.trim()) {
      patch.github_token = githubTokenInput.trim();
      any = true;
    }
    if (s3SecretInput.trim()) {
      patch.s3_secret_key = s3SecretInput.trim();
      any = true;
    }
    if (googleTokenInput.trim()) {
      patch.google_access_token = googleTokenInput.trim();
      any = true;
    }
    if (googleClientSecretInput.trim()) {
      patch.google_client_secret = googleClientSecretInput.trim();
      any = true;
    }
    if (onedriveTokenInput.trim()) {
      patch.onedrive_access_token = onedriveTokenInput.trim();
      any = true;
    }
    return any ? patch : undefined;
  };

  const clearDraftSecrets = () => {
    setWebdavPassInput("");
    setGithubTokenInput("");
    setS3SecretInput("");
    setGoogleTokenInput("");
    setGoogleClientSecretInput("");
    setOnedriveTokenInput("");
  };

  const persistIfNeeded = async (
    overrideConfig?: SyncConfig,
    extraSecrets?: SyncSecretPatch
  ): Promise<SyncConfig> => {
    const targetCfg = overrideConfig ?? config;
    const draftSecrets = buildSecretPatch();
    const secretPatch: SyncSecretPatch | undefined =
      draftSecrets || extraSecrets
        ? { ...(draftSecrets ?? {}), ...(extraSecrets ?? {}) }
        : undefined;
    if (!dirty && !secretPatch && !overrideConfig) {
      return targetCfg;
    }
    const res = await saveSyncConfig(targetCfg, secretPatch);
    setConfig(res.config);
    setFlags(res.secrets);
    setDirty(false);
    clearDraftSecrets();
    window.dispatchEvent(new Event("serverhub:sync-config-changed"));
    return res.config;
  };

  const updateStrategyAndSave = async (patch: Partial<SyncConfig>) => {
    const nextCfg: SyncConfig = { ...config, ...patch };
    setConfig(nextCfg);
    try {
      await persistIfNeeded(nextCfg);
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await persistIfNeeded({ ...config, enabled: true });
      setFeedback({ ok: true, text: "同步配置已保存" });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleClearSecret = async (patch: SyncSecretPatch, label: string) => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await saveSyncConfig(config, patch);
      setConfig(res.config);
      setFlags(res.secrets);
      setFeedback({ ok: true, text: `已清除${label}` });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const saved = await persistIfNeeded();
      const msg = await testSyncConnection(saved);
      setFeedback({ ok: true, text: msg });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setTesting(false);
    }
  };

  const executeSyncAction = async (
    mode: "sync" | "push" | "pull",
    extraSecrets?: SyncSecretPatch
  ) => {
    setSyncingAction(mode);
    setFeedback(null);
    try {
      await persistIfNeeded({ ...config, enabled: true }, extraSecrets);
      const res =
        mode === "push"
          ? await pushSync(settings)
          : mode === "pull"
            ? await pullSync()
            : await runSyncNow(settings);
      setConfig(res.config);
      if (!res.ok) {
        setFeedback({ ok: false, text: res.message });
      }
      if (mode === "pull" || mode === "sync") {
        onSyncPulled?.();
        if (res.pulled_app_settings) {
          onSettingsPulled?.(res.pulled_app_settings);
        }
      }
    } catch (err) {
      const msg = String(err);
      if (
        msg.includes("加密主密码") ||
        msg.includes("同步主密码") ||
        msg.includes("解密失败")
      ) {
        setModalPassInput("");
        setPassphraseModal({ pendingMode: mode });
      }
      setFeedback({ ok: false, text: msg });
    } finally {
      setSyncingAction(null);
    }
  };

  const handleSyncAction = async (mode: "sync" | "push" | "pull") => {
    if (!flags.has_passphrase) {
      setModalPassInput("");
      setPassphraseModal({ pendingMode: mode });
      return;
    }
    await executeSyncAction(mode);
  };

  const handleConfirmPassphraseModal = async () => {
    const pass = modalPassInput.trim();
    if (!pass) return;
    const pendingMode = passphraseModal?.pendingMode;
    setPassphraseModal(null);
    setModalPassInput("");
    if (pendingMode) {
      await executeSyncAction(pendingMode, { passphrase: pass });
    } else {
      setSaving(true);
      setFeedback(null);
      try {
        await persistIfNeeded(undefined, { passphrase: pass });
        setFeedback({ ok: true, text: "已更新同步加密主密码" });
      } catch (err) {
        setFeedback({ ok: false, text: String(err) });
      } finally {
        setSaving(false);
      }
    }
  };

  const handleOAuth = async (provider: "google_drive" | "onedrive") => {
    setSyncingAction("oauth");
    setFeedback(null);
    try {
      await persistIfNeeded();
      const res = await startSyncOAuth(provider);
      setConfig(res.config);
      setFlags(res.secrets);
      setFeedback({
        ok: true,
        text:
          provider === "google_drive"
            ? "Google Drive OAuth 授权成功"
            : "Microsoft OneDrive OAuth 授权成功",
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setSyncingAction(null);
    }
  };

  const currentMeta =
    PROVIDERS.find((p) => p.id === config.provider) ?? PROVIDERS[0];

  const isLocalDetected = (id: SyncProvider): boolean => {
    if (id === "icloud") return Boolean(clouds.icloud_path);
    if (id === "google_drive") return Boolean(clouds.google_drive_path);
    if (id === "onedrive") return Boolean(clouds.onedrive_path);
    if (id === "local_folder") return Boolean(clouds.dropbox_path);
    return false;
  };

  const busy = saving || testing || syncingAction !== null;

  return (
    <div className="motion-stagger space-y-6">
      {/* Top Status & Quick Actions */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          云端同步概览
        </div>
        <div className={CARD_CLS}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted/80">
                <ProviderLogo provider={config.provider} className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 text-[13px] font-semibold">
                  <span>{currentMeta.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setModalPassInput("");
                      setPassphraseModal({});
                    }}
                    title={
                      flags.has_passphrase
                        ? "已设置同步加密主密码，点击可修改或清除"
                        : "点击设置同步加密主密码"
                    }
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition hover:opacity-85 ${
                      flags.has_passphrase
                        ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {flags.has_passphrase ? (
                      <>
                        <ShieldCheck className="h-3 w-3" />
                        <span>AES-256 端到端加密</span>
                      </>
                    ) : (
                      <>
                        <Lock className="h-3 w-3" />
                        <span>设置加密主密码</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="mt-0.5 text-[11px] opacity-60">
                  {config.last_sync_at
                    ? `${formatSyncTime(config.last_sync_at)}${
                        config.last_sync_message
                          ? ` · ${compactSyncMessage(config.last_sync_message)}`
                          : ""
                      }`
                    : "尚未执行过云端同步"}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSyncAction("sync")}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {syncingAction === "sync" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span>立即同步</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSyncAction("push")}
                title="将本地数据加密上传覆盖云端"
                className="inline-flex items-center gap-1 rounded-xl bg-muted px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted/80 disabled:opacity-50"
              >
                {syncingAction === "push" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudUpload className="h-3.5 w-3.5" />
                )}
                <span>上传</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSyncAction("pull")}
                title="从云端拉取并恢复到本地"
                className="inline-flex items-center gap-1 rounded-xl bg-muted px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted/80 disabled:opacity-50"
              >
                {syncingAction === "pull" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CloudDownload className="h-3.5 w-3.5" />
                )}
                <span>拉取</span>
              </button>
            </div>
          </div>

          {feedback && (
            <div
              className={`mt-3 rounded-xl px-3 py-2 text-xs ${
                feedback.ok
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive"
              }`}
            >
              {feedback.text}
            </div>
          )}
        </div>
      </section>

      {/* Provider Selector */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          选择同步方式
        </div>
        <div className={CARD_CLS}>
          <div className="space-y-3">
            <div>
              <div className="mb-2 text-[11px] font-medium opacity-60">
                主流云盘账号
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {PROVIDERS.filter((p) => p.group === "cloud").map((p) => {
                  const active = config.provider === p.id;
                  const detected = isLocalDetected(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        updateCfg({ provider: p.id });
                        setFeedback(null);
                      }}
                      className={`flex items-start gap-2.5 rounded-2xl border p-3 text-left transition ${
                        active
                          ? "border-primary bg-primary/8 shadow-sm"
                          : "border-border/70 bg-background/40 hover:border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-background shadow-xs">
                        <ProviderLogo provider={p.id} className="h-4.5 w-4.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-semibold">
                            {p.name}
                          </span>
                          {detected && (
                            <span
                              title="已检测到本机同步目录"
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                            />
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] opacity-60">
                          {p.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className="border-t pt-3"
              style={{ borderColor: "var(--separator)" }}
            >
              <div className="mb-2 text-[11px] font-medium opacity-60">
                开发者与自托管方式
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PROVIDERS.filter((p) => p.group === "other").map((p) => {
                  const active = config.provider === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        updateCfg({ provider: p.id });
                        setFeedback(null);
                      }}
                      className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition ${
                        active
                          ? "border-primary bg-primary/8 shadow-sm"
                          : "border-border/70 bg-background/40 hover:border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-background shadow-xs">
                        <ProviderLogo provider={p.id} className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold">
                          {p.name}
                        </div>
                        <div className="truncate text-[10px] opacity-60">
                          {p.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Provider-specific Configuration */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          {currentMeta.name} 连接配置
        </div>
        <div className={CARD_CLS}>
          <div className="space-y-3.5">
            {/* iCloud Drive */}
            {config.provider === "icloud" && (
              <>
                <div className="flex items-center justify-between rounded-xl bg-muted/50 px-3 py-2.5 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium">本机 iCloud 云盘状态</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] opacity-65">
                      {clouds.icloud_path
                        ? clouds.icloud_path
                        : "未检测到默认 iCloud Drive 目录"}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium ${
                      clouds.icloud_path
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {clouds.icloud_path ? "已就绪" : "未检测到"}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">iCloud 子目录名称</span>
                    <input
                      type="text"
                      value={config.icloud_subfolder}
                      onChange={(e) =>
                        updateCfg({ icloud_subfolder: e.target.value })
                      }
                      placeholder="ServerHub"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">
                      自定义根目录（可选，留空自动检测）
                    </span>
                    <input
                      type="text"
                      value={config.icloud_custom_path}
                      onChange={(e) =>
                        updateCfg({ icloud_custom_path: e.target.value })
                      }
                      placeholder="~/Library/Mobile Documents/com~apple~CloudDocs"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                </div>
                <p className="text-[11px] opacity-55">
                  通过 macOS / Windows 本机 iCloud Drive 目录自动同步加密数据包，无需额外申请 API 密钥，多台 Apple 设备开箱即用。
                </p>
              </>
            )}

            {/* Google Drive */}
            {config.provider === "google_drive" && (
              <>
                <div className="flex items-center justify-between gap-4 text-[13px]">
                  <div>
                    <div className="font-medium">连接模式</div>
                    <div className="text-[11px] opacity-55">
                      推荐使用桌面目录模式（免配置），或使用 OAuth 2.0 同步至隐藏 appDataFolder
                    </div>
                  </div>
                  <div className="grid grid-cols-2 rounded-[10px] bg-muted p-0.5 text-xs">
                    {(
                      [
                        { id: "desktop_folder", label: "桌面目录" },
                        { id: "api", label: "OAuth API" },
                      ] as { id: CloudDriveMode; label: string }[]
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => updateCfg({ google_mode: m.id })}
                        className={`rounded-[8px] px-2.5 py-1 transition ${
                          config.google_mode === m.id
                            ? "bg-background font-medium shadow-sm"
                            : "opacity-65 hover:opacity-100"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {config.google_mode === "desktop_folder" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] opacity-70">
                        Google Drive 同步目录路径
                      </span>
                      {clouds.google_drive_path && (
                        <button
                          type="button"
                          onClick={() =>
                            updateCfg({
                              google_folder_path: `${clouds.google_drive_path}/ServerHub`,
                            })
                          }
                          className="text-[11px] text-primary hover:underline"
                        >
                          使用已检测目录
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={config.google_folder_path}
                      onChange={(e) =>
                        updateCfg({ google_folder_path: e.target.value })
                      }
                      placeholder={
                        clouds.google_drive_path
                          ? `${clouds.google_drive_path}/ServerHub`
                          : "~/Library/CloudStorage/GoogleDrive-xxx/My Drive/ServerHub"
                      }
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[11px] opacity-70">
                          Google OAuth Client ID（桌面应用）
                        </span>
                        <input
                          type="text"
                          value={config.google_client_id}
                          onChange={(e) =>
                            updateCfg({ google_client_id: e.target.value })
                          }
                          placeholder="xxxx.apps.googleusercontent.com"
                          className={`${INPUT_CLS} font-mono`}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[11px] opacity-70">
                          Client Secret（可选，加密存储）
                        </span>
                        <input
                          type="password"
                          value={googleClientSecretInput}
                          onChange={(e) => {
                            setGoogleClientSecretInput(e.target.value);
                            setDirty(true);
                          }}
                          placeholder={
                            flags.has_google_client_secret
                              ? "已保存（留空保持不变）"
                              : "GOCSPX-..."
                          }
                          className={`${INPUT_CLS} font-mono`}
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Cloud className="h-4 w-4 text-primary" />
                        <span>
                          {flags.has_google_token
                            ? "已获取 Google Drive 访问令牌"
                            : "尚未授权 Google 账号"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleOAuth("google_drive")}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                        >
                          {syncingAction === "oauth" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3 w-3" />
                          )}
                          <span>浏览器授权登录</span>
                        </button>
                        {flags.has_google_token && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void handleClearSecret(
                                { clear_google_token: true },
                                "Google 授权令牌"
                              )
                            }
                            className="text-[11px] text-destructive hover:underline"
                          >
                            断开授权
                          </button>
                        )}
                      </div>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[11px] opacity-70">
                        或手动填入 Access Token（调试 / 临时使用）
                      </span>
                      <input
                        type="password"
                        value={googleTokenInput}
                        onChange={(e) => {
                          setGoogleTokenInput(e.target.value);
                          setDirty(true);
                        }}
                        placeholder={
                          flags.has_google_token
                            ? "已保存令牌（留空保持不变）"
                            : "ya29...."
                        }
                        className={`${INPUT_CLS} font-mono`}
                      />
                    </label>
                  </div>
                )}
              </>
            )}

            {/* Microsoft OneDrive */}
            {config.provider === "onedrive" && (
              <>
                <div className="flex items-center justify-between gap-4 text-[13px]">
                  <div>
                    <div className="font-medium">连接模式</div>
                    <div className="text-[11px] opacity-55">
                      推荐使用桌面目录模式（免配置），或通过 Microsoft Graph API 同步至应用专属目录
                    </div>
                  </div>
                  <div className="grid grid-cols-2 rounded-[10px] bg-muted p-0.5 text-xs">
                    {(
                      [
                        { id: "desktop_folder", label: "桌面目录" },
                        { id: "api", label: "OAuth API" },
                      ] as { id: CloudDriveMode; label: string }[]
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => updateCfg({ onedrive_mode: m.id })}
                        className={`rounded-[8px] px-2.5 py-1 transition ${
                          config.onedrive_mode === m.id
                            ? "bg-background font-medium shadow-sm"
                            : "opacity-65 hover:opacity-100"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {config.onedrive_mode === "desktop_folder" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] opacity-70">
                        OneDrive 同步目录路径
                      </span>
                      {clouds.onedrive_path && (
                        <button
                          type="button"
                          onClick={() =>
                            updateCfg({
                              onedrive_folder_path: `${clouds.onedrive_path}/ServerHub`,
                            })
                          }
                          className="text-[11px] text-primary hover:underline"
                        >
                          使用已检测目录
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={config.onedrive_folder_path}
                      onChange={(e) =>
                        updateCfg({ onedrive_folder_path: e.target.value })
                      }
                      placeholder={
                        clouds.onedrive_path
                          ? `${clouds.onedrive_path}/ServerHub`
                          : "~/Library/CloudStorage/OneDrive-Personal/ServerHub"
                      }
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label className="block space-y-1">
                      <span className="text-[11px] opacity-70">
                        Microsoft Entra / Azure 应用 Client ID（Public Client）
                      </span>
                      <input
                        type="text"
                        value={config.onedrive_client_id}
                        onChange={(e) =>
                          updateCfg({ onedrive_client_id: e.target.value })
                        }
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        className={`${INPUT_CLS} font-mono`}
                      />
                    </label>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Cloud className="h-4 w-4 text-primary" />
                        <span>
                          {flags.has_onedrive_token
                            ? config.onedrive_account_email
                              ? `已登录：${config.onedrive_account_email}`
                              : "已获取 OneDrive 访问令牌"
                            : "尚未授权微软账号"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleOAuth("onedrive")}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                        >
                          {syncingAction === "oauth" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3 w-3" />
                          )}
                          <span>浏览器授权登录</span>
                        </button>
                        {flags.has_onedrive_token && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void handleClearSecret(
                                { clear_onedrive_token: true },
                                "OneDrive 授权令牌"
                              )
                            }
                            className="text-[11px] text-destructive hover:underline"
                          >
                            断开授权
                          </button>
                        )}
                      </div>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[11px] opacity-70">
                        或手动填入 Graph Access Token（可选）
                      </span>
                      <input
                        type="password"
                        value={onedriveTokenInput}
                        onChange={(e) => {
                          setOnedriveTokenInput(e.target.value);
                          setDirty(true);
                        }}
                        placeholder={
                          flags.has_onedrive_token
                            ? "已保存令牌（留空保持不变）"
                            : "EwB..."
                        }
                        className={`${INPUT_CLS} font-mono`}
                      />
                    </label>
                  </div>
                )}
              </>
            )}

            {/* WebDAV */}
            {config.provider === "webdav" && (
              <>
                <div className="space-y-1.5">
                  <div className="text-[11px] opacity-60">
                    快速填充预设（支持飞牛 fnOS、群晖、绿联等 NAS 与主流网盘）
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEBDAV_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          updateCfg({
                            webdav_url: preset.url,
                            webdav_remote_path: preset.remotePath,
                            webdav_allow_insecure_tls: preset.allowInsecureTls,
                          })
                        }
                        title={preset.hint}
                        className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium transition hover:bg-primary/15 hover:text-primary"
                      >
                        <WebdavPresetLogo brand={preset.brand} />
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block space-y-1">
                  <span className="text-[11px] opacity-70">
                    WebDAV 服务地址（飞牛 fnOS 默认 HTTP 5005 / HTTPS 5006）
                  </span>
                  <input
                    type="text"
                    value={config.webdav_url}
                    onChange={(e) => updateCfg({ webdav_url: e.target.value })}
                    placeholder="http://192.168.1.100:5005/ 或 https://dav.jianguoyun.com/dav/"
                    className={`${INPUT_CLS} font-mono`}
                  />
                </label>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">
                      用户名 / 飞牛账号
                    </span>
                    <input
                      type="text"
                      value={config.webdav_username}
                      onChange={(e) =>
                        updateCfg({ webdav_username: e.target.value })
                      }
                      placeholder="admin 或 user@example.com"
                      className={INPUT_CLS}
                    />
                  </label>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] opacity-70">
                        密码 / 应用专用密码（安全加密存储）
                      </span>
                      {flags.has_webdav_password && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleClearSecret(
                              { clear_webdav_password: true },
                              "WebDAV 密码"
                            )
                          }
                          className="text-[11px] text-destructive hover:underline"
                        >
                          清除
                        </button>
                      )}
                    </div>
                    <input
                      type="password"
                      value={webdavPassInput}
                      onChange={(e) => {
                        setWebdavPassInput(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={
                        flags.has_webdav_password
                          ? "已保存密码（留空保持不变）"
                          : "输入 NAS 登录密码或网盘应用密码"
                      }
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </div>
                </div>

                <label className="block space-y-1">
                  <span className="text-[11px] opacity-70">
                    远端同步文件路径（将在 WebDAV 对应目录下自动创建子文件夹）
                  </span>
                  <input
                    type="text"
                    value={config.webdav_remote_path}
                    onChange={(e) =>
                      updateCfg({ webdav_remote_path: e.target.value })
                    }
                    placeholder="ServerHub/serverhub-sync.enc.json"
                    className={`${INPUT_CLS} font-mono`}
                  />
                </label>

                <div className="flex items-center justify-between pt-1 text-xs">
                  <div>
                    <div className="font-medium">
                      允许局域网自签名 HTTPS 证书
                    </div>
                    <div className="text-[11px] opacity-55">
                      连接飞牛 fnOS (5006 端口)、群晖等局域网 NAS 的自签名 HTTPS 地址时开启
                    </div>
                  </div>
                  <Toggle
                    checked={Boolean(config.webdav_allow_insecure_tls)}
                    onChange={(v) =>
                      updateCfg({ webdav_allow_insecure_tls: v })
                    }
                  />
                </div>
              </>
            )}

            {/* GitHub Gist */}
            {config.provider === "github_gist" && (
              <>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] opacity-70">
                      GitHub Personal Access Token（需勾选 gist 权限）
                    </span>
                    {flags.has_github_token && (
                      <button
                        type="button"
                        onClick={() =>
                          void handleClearSecret(
                            { clear_github_token: true },
                            "GitHub Token"
                          )
                        }
                        className="text-[11px] text-destructive hover:underline"
                      >
                        清除
                      </button>
                    )}
                  </div>
                  <input
                    type="password"
                    value={githubTokenInput}
                    onChange={(e) => {
                      setGithubTokenInput(e.target.value);
                      setDirty(true);
                    }}
                    placeholder={
                      flags.has_github_token
                        ? "已保存 Token（留空保持不变）"
                        : "ghp_... 或 github_pat_..."
                    }
                    className={`${INPUT_CLS} font-mono`}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">
                      Gist ID（首次上传留空将自动创建私有 Gist）
                    </span>
                    <input
                      type="text"
                      value={config.github_gist_id}
                      onChange={(e) =>
                        updateCfg({ github_gist_id: e.target.value })
                      }
                      placeholder="留空自动创建，或填入已有 Gist ID"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">同步文件名</span>
                    <input
                      type="text"
                      value={config.github_filename}
                      onChange={(e) =>
                        updateCfg({ github_filename: e.target.value })
                      }
                      placeholder="serverhub-sync.enc.json"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                </div>
              </>
            )}

            {/* S3 Compatible */}
            {config.provider === "s3" && (
              <>
                <div className="space-y-1.5">
                  <div className="text-[11px] opacity-60">对象存储预设</div>
                  <div className="flex flex-wrap gap-1.5">
                    {S3_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          updateCfg({
                            s3_endpoint: preset.endpoint,
                            s3_region: preset.region,
                            s3_path_style: preset.pathStyle,
                          })
                        }
                        className="flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium transition hover:bg-primary/15 hover:text-primary"
                      >
                        <S3PresetLogo brand={preset.brand} />
                        <span>{preset.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-[11px] opacity-70">Endpoint</span>
                    <input
                      type="text"
                      value={config.s3_endpoint}
                      onChange={(e) =>
                        updateCfg({ s3_endpoint: e.target.value })
                      }
                      placeholder="https://<account-id>.r2.cloudflarestorage.com"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">Region</span>
                    <input
                      type="text"
                      value={config.s3_region}
                      onChange={(e) => updateCfg({ s3_region: e.target.value })}
                      placeholder="auto / us-east-1"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">Bucket 名称</span>
                    <input
                      type="text"
                      value={config.s3_bucket}
                      onChange={(e) => updateCfg({ s3_bucket: e.target.value })}
                      placeholder="my-serverhub-sync"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">对象路径 (Key)</span>
                    <input
                      type="text"
                      value={config.s3_object_key}
                      onChange={(e) =>
                        updateCfg({ s3_object_key: e.target.value })
                      }
                      placeholder="serverhub/serverhub-sync.enc.json"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[11px] opacity-70">Access Key ID</span>
                    <input
                      type="text"
                      value={config.s3_access_key_id}
                      onChange={(e) =>
                        updateCfg({ s3_access_key_id: e.target.value })
                      }
                      placeholder="AKIA..."
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </label>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] opacity-70">
                        Secret Access Key（加密存储）
                      </span>
                      {flags.has_s3_secret_key && (
                        <button
                          type="button"
                          onClick={() =>
                            void handleClearSecret(
                              { clear_s3_secret_key: true },
                              "S3 Secret Key"
                            )
                          }
                          className="text-[11px] text-destructive hover:underline"
                        >
                          清除
                        </button>
                      )}
                    </div>
                    <input
                      type="password"
                      value={s3SecretInput}
                      onChange={(e) => {
                        setS3SecretInput(e.target.value);
                        setDirty(true);
                      }}
                      placeholder={
                        flags.has_s3_secret_key
                          ? "已保存密钥（留空保持不变）"
                          : "输入 Secret Access Key"
                      }
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1 text-xs">
                  <div>
                    <div className="font-medium">强制 Path-Style 访问</div>
                    <div className="text-[11px] opacity-55">
                      Cloudflare R2、MinIO 自建服务通常需要开启此项
                    </div>
                  </div>
                  <Toggle
                    checked={config.s3_path_style}
                    onChange={(v) => updateCfg({ s3_path_style: v })}
                  />
                </div>
              </>
            )}

            {/* Local Folder */}
            {config.provider === "local_folder" && (
              <>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] opacity-70">
                      同步目录路径（支持 Dropbox / Syncthing / Resilio / NAS 挂载）
                    </span>
                    {clouds.dropbox_path && (
                      <button
                        type="button"
                        onClick={() =>
                          updateCfg({
                            local_folder_path: `${clouds.dropbox_path}/ServerHub`,
                          })
                        }
                        className="text-[11px] text-primary hover:underline"
                      >
                        填入 Dropbox 目录
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={config.local_folder_path}
                    onChange={(e) =>
                      updateCfg({ local_folder_path: e.target.value })
                    }
                    placeholder="~/Dropbox/ServerHub 或 /Volumes/NAS/ServerHub"
                    className={`${INPUT_CLS} font-mono`}
                  />
                </div>
              </>
            )}

            <div
              className="flex items-center justify-end gap-2 border-t pt-3"
              style={{ borderColor: "var(--separator)" }}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleTest()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-muted px-3 py-1.5 text-xs font-medium transition hover:bg-muted/80 disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Zap className="h-3.5 w-3.5" />
                )}
                <span>测试连接</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSave()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span>{dirty ? "保存配置" : "已保存"}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Sync Scope & Strategy */}
      <section className="space-y-2">
        <div className="px-2 text-[11px] font-semibold tracking-wide uppercase opacity-55">
          同步内容与自动化策略
        </div>
        <div className={LIST_CARD_CLS}>
          <div className="flex items-center justify-between py-3.5 text-[13px]">
            <div>
              <div className="font-medium">服务器列表与分组</div>
              <div className="text-[11px] opacity-55">
                同步所有 SSH / RDP / VNC 主机配置、标签、费用与备注
              </div>
            </div>
            <Toggle
              checked={config.sync_servers}
              onChange={(v) => void updateStrategyAndSave({ sync_servers: v })}
            />
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">SSH 密码与 AI API 密钥</div>
              <div className="text-[11px] opacity-55">
                随加密信封一同同步本地密钥库中的敏感凭据（必须设置加密主密码）
              </div>
            </div>
            <Toggle
              checked={config.sync_secrets}
              onChange={(v) => void updateStrategyAndSave({ sync_secrets: v })}
            />
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">AI 运维助手模型配置</div>
              <div className="text-[11px] opacity-55">
                同步已配置的 AI 接口地址、模型名称与自定义提示词
              </div>
            </div>
            <Toggle
              checked={config.sync_ai_profiles}
              onChange={(v) =>
                void updateStrategyAndSave({ sync_ai_profiles: v })
              }
            />
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">应用外观与终端设置</div>
              <div className="text-[11px] opacity-55">
                同步主题色、终端字体、探针刷新速率与默认连接参数
              </div>
            </div>
            <Toggle
              checked={config.sync_app_settings}
              onChange={(v) =>
                void updateStrategyAndSave({ sync_app_settings: v })
              }
            />
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">冲突解决策略</div>
              <div className="text-[11px] opacity-55">
                执行「立即同步」时如何处理本地与云端差异
              </div>
            </div>
            <DropdownSelect
              variant="compact"
              align="right"
              value={config.conflict_strategy}
              onChange={(conflict_strategy) =>
                void updateStrategyAndSave({ conflict_strategy })
              }
              options={[
                { value: "latest", label: "智能双向合并（按最新修改时间）" },
                { value: "local", label: "本地优先（覆盖云端）" },
                { value: "remote", label: "云端优先（覆盖本地）" },
              ]}
              menuClassName="w-56"
            />
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">自动后台同步</div>
              <div className="text-[11px] opacity-55">
                按设定间隔自动与云端保持同步
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {config.auto_sync && (
                <DropdownSelect
                  variant="compact"
                  align="right"
                  value={config.auto_sync_interval_min}
                  onChange={(auto_sync_interval_min) =>
                    void updateStrategyAndSave({ auto_sync_interval_min })
                  }
                  options={[
                    { value: 5, label: "每 5 分钟" },
                    { value: 15, label: "每 15 分钟" },
                    { value: 30, label: "每 30 分钟" },
                    { value: 60, label: "每 60 分钟" },
                  ]}
                  className="px-2.5 py-1"
                  menuClassName="w-32"
                />
              )}
              <Toggle
                checked={config.auto_sync}
                onChange={(v) => void updateStrategyAndSave({ auto_sync: v })}
              />
            </div>
          </div>

          <div
            className="flex items-center justify-between border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div>
              <div className="font-medium">启动应用时自动同步</div>
              <div className="text-[11px] opacity-55">
                打开 UService 后自动在后台执行一次静默同步
              </div>
            </div>
            <Toggle
              checked={config.sync_on_startup}
              onChange={(v) =>
                void updateStrategyAndSave({ sync_on_startup: v })
              }
            />
          </div>

          <div
            className="flex items-center justify-between gap-4 border-t py-3.5 text-[13px]"
            style={{ borderColor: "var(--separator)" }}
          >
            <div className="shrink-0 font-medium">当前设备标识</div>
            <input
              type="text"
              value={config.device_name}
              onChange={(e) => updateCfg({ device_name: e.target.value })}
              onBlur={() =>
                void updateStrategyAndSave({ device_name: config.device_name })
              }
              placeholder="MacBook Pro"
              className="w-52 rounded-lg bg-muted px-3 py-1.5 text-xs outline-none ring-1 ring-black/10 dark:ring-white/10"
            />
          </div>
        </div>
      </section>

      {/* First-time Sync / Edit Passphrase Modal */}
      {passphraseModal && (
        <div
          className="motion-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={() => setPassphraseModal(null)}
        >
          <div
            className="motion-modal w-full max-w-md rounded-[22px] border border-border bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">
                  {passphraseModal.pendingMode
                    ? "设置同步加密主密码"
                    : flags.has_passphrase
                      ? "修改同步加密主密码"
                      : "设置同步加密主密码"}
                </div>
                <div className="mt-1 text-xs opacity-65">
                  {passphraseModal.pendingMode === "pull"
                    ? "请输入云端备份所使用的同步加密主密码以解密数据。"
                    : "首次使用云端同步请设置一个主密码。数据离开本机前将通过 AES-256-GCM 端到端加密，多台设备同步时需填写相同的主密码。"}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <input
                type="password"
                autoFocus
                value={modalPassInput}
                onChange={(e) => setModalPassInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && modalPassInput.trim()) {
                    void handleConfirmPassphraseModal();
                  } else if (e.key === "Escape") {
                    setPassphraseModal(null);
                  }
                }}
                placeholder={
                  flags.has_passphrase
                    ? "输入新的同步加密主密码"
                    : "输入同步加密主密码（多端保持一致）"
                }
                className={`${INPUT_CLS} font-mono`}
              />
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <div>
                {flags.has_passphrase && !passphraseModal.pendingMode && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPassphraseModal(null);
                      void handleClearSecret(
                        { clear_passphrase: true },
                        "同步加密主密码"
                      );
                    }}
                    className="text-xs text-destructive hover:underline"
                  >
                    清除已存主密码
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPassphraseModal(null)}
                  className="rounded-xl bg-muted px-3 py-1.5 text-xs font-medium transition hover:bg-muted/80"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!modalPassInput.trim() || busy}
                  onClick={() => void handleConfirmPassphraseModal()}
                  className="rounded-xl bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                >
                  {passphraseModal.pendingMode === "push"
                    ? "保存并上传"
                    : passphraseModal.pendingMode === "pull"
                      ? "解密并拉取"
                      : passphraseModal.pendingMode === "sync"
                        ? "保存并立即同步"
                        : "保存主密码"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
