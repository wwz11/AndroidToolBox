export type DeviceRow = { serial: string; state: string };

export type DevicesResponse = {
  devices: string[];
  rows: DeviceRow[];
  selected: string;
  adb_available: boolean;
  message: string;
};

export type ConnectResponse = DevicesResponse & { ok: boolean; message: string };

export type ApkIntentDataInfo = {
  scheme?: string;
  host?: string;
  port?: string;
  path?: string;
  pathPrefix?: string;
  pathPattern?: string;
  mimeType?: string;
};

export type ApkIntentFilterInfo = {
  component?: string;
  component_kind?: string;
  exported?: boolean | null;
  actions?: string[];
  categories?: string[];
  data?: ApkIntentDataInfo[];
  priority?: string;
};

export type ApkAnalyzeInfo = {
  filename?: string;
  file_size?: number;
  file_size_label?: string;
  md5?: string;
  package?: string;
  version_name?: string;
  version_code?: string;
  min_sdk?: string;
  target_sdk?: string;
  max_sdk?: string;
  label?: string;
  debuggable?: boolean | null;
  permissions?: string[];
  /** 普通权限：安装即由系统默认授予，一般无需用户再手动点授权 */
  permissions_auto?: string[];
  /** 危险权限：需运行时弹窗由用户授予 */
  permissions_runtime?: string[];
  /** 特殊权限：通常需进设置页手动开启 */
  permissions_special?: string[];
  activities?: {
    kind?: string;
    name: string;
    exported?: boolean | null;
    permission?: string;
    intent_filters?: ApkIntentFilterInfo[];
  }[];
  services?: {
    kind?: string;
    name: string;
    exported?: boolean | null;
    permission?: string;
    intent_filters?: ApkIntentFilterInfo[];
  }[];
  receivers?: {
    kind?: string;
    name: string;
    exported?: boolean | null;
    permission?: string;
    intent_filters?: ApkIntentFilterInfo[];
  }[];
  providers?: {
    kind?: string;
    name: string;
    exported?: boolean | null;
    permission?: string;
    intent_filters?: ApkIntentFilterInfo[];
  }[];
  /** Manifest 中声明的 intent-filter 汇总 */
  intent_filters?: ApkIntentFilterInfo[];
  abis?: string[];
  has_dex?: boolean;
  dex_count?: number;
  has_native?: boolean;
  warnings?: string[];
};

export type ApkCompareInfo = {
  ok?: boolean;
  installed?: boolean;
  package?: string;
  verdict?: string;
  verdict_kind?: string;
  apk_version_name?: string;
  apk_version_code?: string;
  device_version_name?: string;
  device_version_code?: string;
  granted?: string[];
  denied?: string[];
  /** dumpsys install permissions：系统默认已授予 */
  install_granted?: string[];
  runtime_granted?: string[];
  runtime_denied?: string[];
  permissions_auto?: string[];
  permissions_runtime?: string[];
  permissions_special?: string[];
  perms_added?: string[];
  perms_removed?: string[];
};

export type ApkAnalyzeResponse = {
  ok: boolean;
  filename: string;
  package: string;
  version_name: string;
  version_code?: string;
  min_sdk?: string;
  target_sdk?: string;
  md5?: string;
  abis?: string[];
  permissions?: string[];
  report?: string;
  info?: ApkAnalyzeInfo;
};

export type ApkCompareResponse = ApkAnalyzeResponse & {
  device?: string;
  compare?: string;
  compare_info?: ApkCompareInfo;
};

export type KeyHidId = {
  name: string;
  vid: string;
  pid: string;
  bus: string;
};

export type KeyIdsResponse = {
  ok: boolean;
  message: string;
  devices: KeyHidId[];
};

export type KeyCaptureResponse = {
  ok: boolean;
  page: string;
  usage: string;
  scan: string;
  input: string;
  key_code: number | null;
  page_known: boolean;
  message: string;
};

export type HealthResponse = {
  ok: boolean;
  service?: string;
  api_rev?: number;
  features?: string[];
};
