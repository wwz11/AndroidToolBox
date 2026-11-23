/** 全局应用偏好（localStorage），与 Electron settings.json 中的窗口/高级项配合。 */

export const APP_PREFS_KEY = "toolbox.app.prefs.v1";
export const APP_PREFS_EVENT = "toolbox-app-prefs-change";

export type CloseActionPref = "ask" | "tray" | "quit";

export type AppPrefs = {
  /** 关闭窗口：每次询问 / 后台 / 退出 */
  closeAction: CloseActionPref;
  minimizeToTray: boolean;
  alwaysOnTop: boolean;
  /** 记住主窗口大小与位置（Electron） */
  rememberWindowBounds: boolean;
  /** 左侧导航收起后只显示图标 */
  navCollapsed: boolean;
  /** 左侧导航展开宽度 */
  navWidth: number;
  devicePollMs: number;
  logcatAutoSave: boolean;
  logcatMaxLines: number;
  shellScrollback: number;
  shellAutoLogDefault: boolean;
  serialBaudDefault: number;
  serialAutoLogDefault: boolean;
  scrcpyMaxSide: number;
  /** 录屏断线后等待重连的秒数 */
  scrcpyReconnectSec: number;
  /** 截图式预览最大边长（非内嵌 scrcpy） */
  remotePreviewMaxSide: number;
  /** 截图式预览轮询间隔 */
  remotePreviewPollMs: number;
  netAdbLast: string;
  pullDir: string;
  gotaOutDir: string;
  /** 文件管理默认远程浏览路径 */
  filesBrowsePath: string;
  /** 仅展示；暂只支持中文 */
  uiLocale: "zh-CN";
  apiUrl: string;
  updateUrl: string;
};

export const DEFAULT_APP_PREFS: AppPrefs = {
  closeAction: "ask",
  minimizeToTray: false,
  alwaysOnTop: false,
  rememberWindowBounds: true,
  navCollapsed: false,
  navWidth: 200,
  devicePollMs: 4000,
  logcatAutoSave: true,
  logcatMaxLines: 3000,
  shellScrollback: 20000,
  shellAutoLogDefault: true,
  serialBaudDefault: 115200,
  serialAutoLogDefault: true,
  scrcpyMaxSide: 960,
  scrcpyReconnectSec: 300,
  remotePreviewMaxSide: 720,
  remotePreviewPollMs: 800,
  netAdbLast: "",
  pullDir: "",
  gotaOutDir: "",
  filesBrowsePath: "/sdcard",
  uiLocale: "zh-CN",
  apiUrl: "",
  updateUrl: "",
};

type Listener = (prefs: AppPrefs) => void;
const listeners = new Set<Listener>();

export function subscribeAppPrefs(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeRemoteDir(raw: string): string {
  let p = String(raw || "").trim().replace(/\\/g, "/");
  if (!p) return DEFAULT_APP_PREFS.filesBrowsePath;
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

export function normalizeAppPrefs(raw: Partial<AppPrefs> | null | undefined): AppPrefs {
  const close =
    raw?.closeAction === "tray" || raw?.closeAction === "quit" || raw?.closeAction === "ask"
      ? raw.closeAction
      : DEFAULT_APP_PREFS.closeAction;
  return {
    closeAction: close,
    minimizeToTray: Boolean(raw?.minimizeToTray),
    alwaysOnTop: Boolean(raw?.alwaysOnTop),
    rememberWindowBounds:
      typeof raw?.rememberWindowBounds === "boolean"
        ? raw.rememberWindowBounds
        : DEFAULT_APP_PREFS.rememberWindowBounds,
    navCollapsed: raw?.navCollapsed === true,
    navWidth: clampInt(Number(raw?.navWidth), 168, 320, DEFAULT_APP_PREFS.navWidth),
    devicePollMs: clampInt(Number(raw?.devicePollMs), 1000, 30000, DEFAULT_APP_PREFS.devicePollMs),
    logcatAutoSave:
      typeof raw?.logcatAutoSave === "boolean"
        ? raw.logcatAutoSave
        : DEFAULT_APP_PREFS.logcatAutoSave,
    logcatMaxLines: clampInt(
      Number(raw?.logcatMaxLines),
      500,
      20000,
      DEFAULT_APP_PREFS.logcatMaxLines,
    ),
    shellScrollback: clampInt(
      Number(raw?.shellScrollback),
      1000,
      100000,
      DEFAULT_APP_PREFS.shellScrollback,
    ),
    shellAutoLogDefault:
      typeof raw?.shellAutoLogDefault === "boolean"
        ? raw.shellAutoLogDefault
        : DEFAULT_APP_PREFS.shellAutoLogDefault,
    serialBaudDefault: clampInt(
      Number(raw?.serialBaudDefault),
      1200,
      4000000,
      DEFAULT_APP_PREFS.serialBaudDefault,
    ),
    serialAutoLogDefault:
      typeof raw?.serialAutoLogDefault === "boolean"
        ? raw.serialAutoLogDefault
        : DEFAULT_APP_PREFS.serialAutoLogDefault,
    scrcpyMaxSide: clampInt(
      Number(raw?.scrcpyMaxSide),
      480,
      2560,
      DEFAULT_APP_PREFS.scrcpyMaxSide,
    ),
    scrcpyReconnectSec: clampInt(
      Number(raw?.scrcpyReconnectSec),
      60,
      3600,
      DEFAULT_APP_PREFS.scrcpyReconnectSec,
    ),
    remotePreviewMaxSide: clampInt(
      Number(raw?.remotePreviewMaxSide),
      320,
      1920,
      DEFAULT_APP_PREFS.remotePreviewMaxSide,
    ),
    remotePreviewPollMs: clampInt(
      Number(raw?.remotePreviewPollMs),
      300,
      5000,
      DEFAULT_APP_PREFS.remotePreviewPollMs,
    ),
    netAdbLast: String(raw?.netAdbLast || "").trim(),
    pullDir: String(raw?.pullDir || "").trim(),
    gotaOutDir: String(raw?.gotaOutDir || "").trim(),
    filesBrowsePath: normalizeRemoteDir(
      String(raw?.filesBrowsePath || DEFAULT_APP_PREFS.filesBrowsePath),
    ),
    uiLocale: "zh-CN",
    apiUrl: String(raw?.apiUrl || "").trim(),
    updateUrl: String(raw?.updateUrl || "").trim(),
  };
}

function migrateLegacyInto(base: Partial<AppPrefs>): Partial<AppPrefs> {
  const out = { ...base };
  try {
    if (out.logcatAutoSave == null) {
      const v = localStorage.getItem("toolbox.logcat.autoSave");
      if (v != null) out.logcatAutoSave = v !== "0" && v !== "false";
    }
    if (!out.pullDir) {
      const v = (localStorage.getItem("toolbox.files.pullDir") || "").trim();
      if (v) out.pullDir = v;
    }
    if (!out.gotaOutDir) {
      const v = (localStorage.getItem("toolbox.gota.outDir") || "").trim();
      if (v) out.gotaOutDir = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function readAppPrefs(): AppPrefs {
  try {
    const raw = localStorage.getItem(APP_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppPrefs>) : {};
    return normalizeAppPrefs(migrateLegacyInto(parsed));
  } catch {
    return normalizeAppPrefs(migrateLegacyInto({}));
  }
}

function notify(prefs: AppPrefs) {
  for (const fn of [...listeners]) {
    try {
      fn(prefs);
    } catch {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(APP_PREFS_EVENT, { detail: prefs }));
  } catch {
    /* ignore */
  }
}

let lastWritten = "";

export function writeAppPrefs(next: AppPrefs): AppPrefs {
  const prefs = normalizeAppPrefs(next);
  const serialized = JSON.stringify(prefs);
  if (!lastWritten) {
    try {
      const stored = localStorage.getItem(APP_PREFS_KEY);
      if (stored && JSON.stringify(normalizeAppPrefs(JSON.parse(stored) as Partial<AppPrefs>)) === serialized) {
        lastWritten = serialized;
      }
    } catch {
      /* ignore */
    }
  }
  if (serialized === lastWritten) return prefs;
  lastWritten = serialized;
  try {
    localStorage.setItem(APP_PREFS_KEY, serialized);
  } catch {
    /* ignore */
  }
  // 同步旧键，避免功能页读到过期值
  try {
    localStorage.setItem(
      "toolbox.logcat.autoSave",
      prefs.logcatAutoSave ? "1" : "0",
    );
    if (prefs.pullDir) localStorage.setItem("toolbox.files.pullDir", prefs.pullDir);
    if (prefs.gotaOutDir) localStorage.setItem("toolbox.gota.outDir", prefs.gotaOutDir);
  } catch {
    /* ignore */
  }
  notify(prefs);
  // 推到主进程（窗口/更新/API 等）
  try {
    void window.toolbox?.setAppSettings?.(prefs);
  } catch {
    /* ignore */
  }
  return prefs;
}

export function patchAppPrefs(patch: Partial<AppPrefs>): AppPrefs {
  return writeAppPrefs({ ...readAppPrefs(), ...patch });
}
