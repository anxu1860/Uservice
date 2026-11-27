import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./settings";

export type SyncProvider =
  | "google_drive"
  | "icloud"
  | "onedrive"
  | "webdav"
  | "github_gist"
  | "s3"
  | "local_folder";

export type CloudDriveMode = "desktop_folder" | "api";
export type ConflictStrategy = "latest" | "local" | "remote";

export interface SyncConfig {
  enabled: boolean;
  provider: SyncProvider;
  device_name: string;

  sync_servers: boolean;
  sync_secrets: boolean;
  sync_ai_profiles: boolean;
  sync_app_settings: boolean;

  auto_sync: boolean;
  auto_sync_interval_min: number;
  sync_on_startup: boolean;
  conflict_strategy: ConflictStrategy;

  google_mode: CloudDriveMode;
  google_folder_path: string;
  google_client_id: string;
  google_account_email: string;

  icloud_subfolder: string;
  icloud_custom_path: string;

  onedrive_mode: CloudDriveMode;
  onedrive_folder_path: string;
  onedrive_client_id: string;
  onedrive_account_email: string;

  webdav_url: string;
  webdav_username: string;
  webdav_remote_path: string;
  webdav_allow_insecure_tls?: boolean;

  github_gist_id: string;
  github_filename: string;

  s3_endpoint: string;
  s3_region: string;
  s3_bucket: string;
  s3_object_key: string;
  s3_access_key_id: string;
  s3_path_style: boolean;

  local_folder_path: string;

  last_sync_at: number | null;
  last_sync_status: string | null;
  last_sync_message: string | null;
}

export interface SyncSecretFlags {
  has_passphrase: boolean;
  has_webdav_password: boolean;
  has_github_token: boolean;
  has_s3_secret_key: boolean;
  has_google_token: boolean;
  has_google_client_secret: boolean;
  has_onedrive_token: boolean;
}

export interface SyncConfigResponse {
  config: SyncConfig;
  secrets: SyncSecretFlags;
}

export interface SyncSecretPatch {
  passphrase?: string;
  clear_passphrase?: boolean;
  webdav_password?: string;
  clear_webdav_password?: boolean;
  github_token?: string;
  clear_github_token?: boolean;
  s3_secret_key?: string;
  clear_s3_secret_key?: boolean;
  google_access_token?: string;
  clear_google_token?: boolean;
  google_client_secret?: string;
  clear_google_client_secret?: boolean;
  onedrive_access_token?: string;
  clear_onedrive_token?: boolean;
}

export interface DetectedLocalClouds {
  icloud_path: string | null;
  google_drive_path: string | null;
  onedrive_path: string | null;
  dropbox_path: string | null;
}

export interface SyncActionResult {
  ok: boolean;
  action: "push" | "pull" | "sync";
  message: string;
  synced_at: number;
  servers_count: number;
  secrets_count: number;
  ai_profiles_count: number;
  pulled_app_settings: Partial<AppSettings> | null;
  config: SyncConfig;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  provider: "icloud",
  device_name: "My Desktop",
  sync_servers: true,
  sync_secrets: true,
  sync_ai_profiles: true,
  sync_app_settings: true,
  auto_sync: false,
  auto_sync_interval_min: 15,
  sync_on_startup: false,
  conflict_strategy: "latest",
  google_mode: "desktop_folder",
  google_folder_path: "",
  google_client_id: "",
  google_account_email: "",
  icloud_subfolder: "ServerHub",
  icloud_custom_path: "",
  onedrive_mode: "desktop_folder",
  onedrive_folder_path: "",
  onedrive_client_id: "",
  onedrive_account_email: "",
  webdav_url: "",
  webdav_username: "",
  webdav_remote_path: "ServerHub/serverhub-sync.enc.json",
  webdav_allow_insecure_tls: false,
  github_gist_id: "",
  github_filename: "serverhub-sync.enc.json",
  s3_endpoint: "",
  s3_region: "auto",
  s3_bucket: "",
  s3_object_key: "serverhub/serverhub-sync.enc.json",
  s3_access_key_id: "",
  s3_path_style: true,
  local_folder_path: "",
  last_sync_at: null,
  last_sync_status: null,
  last_sync_message: null,
};

export type WebdavPresetBrand =
  | "fnos"
  | "synology"
  | "ugreen"
  | "jianguoyun"
  | "alist"
  | "nextcloud";

export type S3PresetBrand =
  | "cloudflare"
  | "aws"
  | "aliyun"
  | "tencent"
  | "minio";

export const WEBDAV_PRESETS = [
  {
    brand: "fnos" as WebdavPresetBrand,
    label: "飞牛 fnOS (HTTP)",
    url: "http://192.168.1.100:5005/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: false,
    hint: "在飞牛 fnOS「文件共享协议 → WebDAV」中开启 HTTP (默认 5005)，使用飞牛账号密码登录",
  },
  {
    brand: "fnos" as WebdavPresetBrand,
    label: "飞牛 fnOS (HTTPS)",
    url: "https://192.168.1.100:5006/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: true,
    hint: "飞牛 fnOS 开启 HTTPS (默认 5006)，已自动开启允许局域网自签名证书",
  },
  {
    brand: "synology" as WebdavPresetBrand,
    label: "群晖 Synology",
    url: "https://192.168.1.100:5006/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: true,
    hint: "群晖 WebDAV Server 套件默认端口：HTTP 5005 / HTTPS 5006",
  },
  {
    brand: "ugreen" as WebdavPresetBrand,
    label: "绿联 / 极空间 NAS",
    url: "http://192.168.1.100:5005/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: false,
    hint: "在 NAS「文件服务 / WebDAV」中启用并查看对应端口与挂载路径",
  },
  {
    brand: "jianguoyun" as WebdavPresetBrand,
    label: "坚果云",
    url: "https://dav.jianguoyun.com/dav/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: false,
    hint: "在坚果云「账户信息 → 安全选项 → 第三方应用管理」中生成应用专用密码",
  },
  {
    brand: "alist" as WebdavPresetBrand,
    label: "Alist / OpenList",
    url: "http://192.168.1.100:5244/dav/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: false,
    hint: "Alist WebDAV 路径固定带有 /dav/ 后缀，需为用户开启 WebDAV 读取与写入权限",
  },
  {
    brand: "nextcloud" as WebdavPresetBrand,
    label: "Nextcloud",
    url: "https://your-nextcloud.example.com/remote.php/dav/files/USERNAME/",
    remotePath: "ServerHub/serverhub-sync.enc.json",
    allowInsecureTls: false,
    hint: "请将 URL 中的 USERNAME 替换为你的 Nextcloud 用户名",
  },
] as const;

export const S3_PRESETS = [
  {
    brand: "cloudflare" as S3PresetBrand,
    label: "Cloudflare R2",
    endpoint: "https://<account-id>.r2.cloudflarestorage.com",
    region: "auto",
    pathStyle: true,
  },
  {
    brand: "aws" as S3PresetBrand,
    label: "AWS S3",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    pathStyle: false,
  },
  {
    brand: "aliyun" as S3PresetBrand,
    label: "阿里云 OSS",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    region: "cn-hangzhou",
    pathStyle: false,
  },
  {
    brand: "tencent" as S3PresetBrand,
    label: "腾讯云 COS",
    endpoint: "https://cos.ap-shanghai.myqcloud.com",
    region: "ap-shanghai",
    pathStyle: false,
  },
  {
    brand: "minio" as S3PresetBrand,
    label: "MinIO 自建",
    endpoint: "http://127.0.0.1:9000",
    region: "us-east-1",
    pathStyle: true,
  },
] as const;

export async function getSyncConfig(): Promise<SyncConfigResponse> {
  return invoke<SyncConfigResponse>("sync_config_get");
}

export async function saveSyncConfig(
  config: SyncConfig,
  secrets?: SyncSecretPatch
): Promise<SyncConfigResponse> {
  return invoke<SyncConfigResponse>("sync_config_save", {
    config,
    secrets: secrets ?? null,
  });
}

export async function detectLocalClouds(): Promise<DetectedLocalClouds> {
  return invoke<DetectedLocalClouds>("sync_detect_clouds");
}

export async function testSyncConnection(
  config?: SyncConfig
): Promise<string> {
  return invoke<string>("sync_test_connection", {
    config: config ?? null,
  });
}

function prepareAppSettingsForSync(
  appSettings?: AppSettings
): Partial<AppSettings> | null {
  if (!appSettings) return null;
  // Never upload large local wallpaper data URIs on every sync cycle.
  const { backgroundImage: _ignored, ...rest } = appSettings;
  return rest;
}

export async function pushSync(
  appSettings?: AppSettings
): Promise<SyncActionResult> {
  return invoke<SyncActionResult>("sync_push", {
    appSettings: prepareAppSettingsForSync(appSettings),
  });
}

export async function pullSync(): Promise<SyncActionResult> {
  return invoke<SyncActionResult>("sync_pull");
}

export async function runSyncNow(
  appSettings?: AppSettings
): Promise<SyncActionResult> {
  return invoke<SyncActionResult>("sync_now", {
    appSettings: prepareAppSettingsForSync(appSettings),
  });
}

export async function startSyncOAuth(
  provider: "google_drive" | "onedrive"
): Promise<SyncConfigResponse> {
  return invoke<SyncConfigResponse>("sync_oauth_authorize", { provider });
}
