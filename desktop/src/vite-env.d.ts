/// <reference types="vite/client" />

interface ToolboxBridge {
  apiBase: string;
  apiToken?: string;
  platform: string;
  restartApi?: () => Promise<{ ok: boolean; message?: string }>;
  /** Electron 下返回 File 的本机绝对路径 */
  pathForFile?: (file: File) => string;
  /** 将本机文件拖出到系统（资源管理器/桌面） */
  startDrag?: (filePath: string) => void;
  /** 选择本机目录；取消返回空字符串 */
  chooseDirectory?: (opts?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<string>;
  /** 用系统资源管理器打开文件/目录 */
  openPath?: (
    path: string,
  ) => Promise<{ ok: boolean; path?: string; message?: string }>;
  /** 选择本机文件；取消返回空字符串 */
  chooseFile?: (opts?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<string>;
  /** 读取本机文件为 base64 */
  readFileBase64?: (filePath: string) => Promise<{
    ok: boolean;
    path?: string;
    name?: string;
    bytes?: number;
    dataBase64?: string;
    message?: string;
  }>;
  /** 保存 base64 到本机 */
  saveFileBase64?: (opts: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    dataBase64: string;
    forceDialog?: boolean;
  }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    message?: string;
  }>;
  /** 默认拉取目录（userdata/output/adb_pulls） */
  defaultPullDir?: () => Promise<string>;
  /** 默认 GOTA 分割输出目录（userdata/output/gota） */
  defaultGotaDir?: () => Promise<string>;
  /** 主进程请求关闭确认；返回取消订阅 */
  onClosePrompt?: (handler: () => void) => () => void;
  /** 回复关闭确认 */
  replyClosePrompt?: (action: "tray" | "quit" | "cancel") => void;
  /** 主进程统一应用内提示 */
  onAppPrompt?: (
    handler: (spec: {
      mark?: string;
      title?: string;
      body?: string;
      tips?: string[];
      primary?: string;
      secondary?: string;
    }) => void,
  ) => () => void;
  onAppPromptDismiss?: (handler: () => void) => () => void;
  ackAppPrompt?: () => void;
  replyAppPrompt?: (action: "primary" | "secondary" | "cancel") => void;
  /** 手动检查更新 */
  checkForUpdates?: () => Promise<{
    ok?: boolean;
    state?: string;
    message?: string;
    version?: string;
  }>;
  getAppVersion?: () => Promise<string>;
  /** 自定义标题栏（Win/Linux） */
  windowControls?: () => Promise<{
    customTitlebar?: boolean;
    platform?: string;
  }>;
  windowMinimize?: () => Promise<void> | void;
  windowToggleMaximize?: () => Promise<boolean> | boolean;
  windowClose?: () => Promise<void> | void;
  windowIsMaximized?: () => Promise<boolean> | boolean;
  windowIsAlwaysOnTop?: () => Promise<boolean> | boolean;
  windowToggleAlwaysOnTop?: () => Promise<boolean> | boolean;
  getAppSettings?: () => Promise<Record<string, unknown>>;
  setAppSettings?: (
    patch: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onWindowMaximized?: (handler: (maximized: boolean) => void) => () => void;
  /** 系统剪贴板读写（终端复制粘贴，经主进程） */
  clipboardWriteText?: (text: string) => Promise<boolean> | boolean;
  clipboardReadText?: () => Promise<string> | string;
  /** 汇报后台任务状态（托盘提示） */
  reportActivity?: (payload: {
    id: string;
    active: boolean;
    label?: string;
  }) => void;
  /** 订阅更新状态 */
  onUpdateStatus?: (
    handler: (payload: {
      state?: string;
      message?: string;
      version?: string;
      percent?: number;
      detail?: string;
    }) => void,
  ) => () => void;
}

interface Window {
  toolbox?: ToolboxBridge;
}
