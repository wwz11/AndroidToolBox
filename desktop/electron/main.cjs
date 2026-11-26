const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
  ipcMain,
  clipboard,
  screen,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const { autoUpdater } = require("electron-updater");

const DEV_SERVER = process.env.VITE_DEV_SERVER || "";
const API_PORT = process.env.TOOLBOX_API_PORT || "17831";
let API_URL = process.env.TOOLBOX_API_URL || `http://127.0.0.1:${API_PORT}`;
const API_TOKEN =
  process.env.TOOLBOX_API_TOKEN || crypto.randomBytes(24).toString("hex");
process.env.TOOLBOX_API_TOKEN = API_TOKEN;
const NEED_API_REV = 90;
const APP_NAME = "AndroidTVTestToolBox";
const LEGACY_DATA_DIR_NAME = "Toolbox";
/** 默认 GitHub Releases 更新源（generic 协议直连 latest.yml 与安装包） */
const DEFAULT_UPDATE_URL =
  "https://github.com/wwz11/AndroidToolBox/releases/latest/download";

/** @type {import('child_process').ChildProcess | null} */
let apiProc = null;
let managedApi = false;
/** @type {Promise<void> | null} */
let apiBootPromise = null;
let apiAutoRestartTimes = [];
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').Tray | null} */
let tray = null;
/** @type {Map<string, string>} id -> label */
const bgActivities = new Map();
let lastActivityBalloonAt = 0;
/** 为 true 时允许真正退出（托盘「退出」或 before-quit） */
let quitting = false;
/** 关闭确认框打开中，避免重复弹窗 */
let closePromptOpen = false;
/** 更新检查/下载中 */
let updateBusy = false;
let updateDownloaded = false;
let updaterWired = false;
/** 本会话已选「下次再说」，启动自动检查不再弹窗；手动「检查更新」仍可再问 */
let updateDeferredThisSession = false;
/** 本地/NAS 已下载的 Setup 路径（非 http 源时使用） */
let pendingInstallerPath = "";
let pendingInstallerVersion = "";

// 只允许一个实例：重复双击会唤起已有窗口（含托盘隐藏时）
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function isPackaged() {
  return app.isPackaged;
}

function resourcesDir() {
  if (isPackaged()) return process.resourcesPath;
  return path.resolve(__dirname, "..");
}

function repoRoot() {
  if (isPackaged()) return resourcesDir();
  return path.resolve(__dirname, "..", "..");
}

/** @type {import('electron').NativeImage | null} */
let trayIconBase = null;
/** @type {import('electron').NativeImage | null} */
let trayIconBusy = null;
/** @type {ReturnType<typeof setInterval> | null} */
let trayBlinkTimer = null;
let trayBlinkOn = true;

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "icon.ico"),
    path.join(__dirname, "icon.png"),
    path.join(resourcesDir(), "icon.ico"),
    path.join(repoRoot(), "build", "assets", "toolbox.ico"),
    path.join(repoRoot(), "build", "assets", "toolbox_256.png"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function getTrayIconBase() {
  if (trayIconBase && !trayIconBase.isEmpty()) return trayIconBase;
  trayIconBase = resolveTrayIcon();
  return trayIconBase;
}

/** 在图标右下角画醒目状态点（进行中） */
function paintTrayBadge(base, colorRgb) {
  if (!base || base.isEmpty()) return base;
  const size = 32;
  const scaled = base.resize({ width: size, height: size });
  let buf;
  try {
    buf = Buffer.from(scaled.toBitmap());
  } catch {
    return base;
  }
  if (buf.length < size * size * 4) return base;

  const [br, bg, bb] = colorRgb;
  const winLike = process.platform === "win32" || process.platform === "linux";
  const cx = size - 7;
  const cy = size - 7;
  const outerR = 6;
  const innerR = 4.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > outerR * outerR) continue;
      const i = (y * size + x) * 4;
      if (d2 > innerR * innerR) {
        // 白边，托盘上更醒目
        buf[i] = 255;
        buf[i + 1] = 255;
        buf[i + 2] = 255;
        buf[i + 3] = 255;
      } else if (winLike) {
        // Windows/Linux toBitmap 为 BGRA
        buf[i] = bb;
        buf[i + 1] = bg;
        buf[i + 2] = br;
        buf[i + 3] = 255;
      } else {
        buf[i] = br;
        buf[i + 1] = bg;
        buf[i + 2] = bb;
        buf[i + 3] = 255;
      }
    }
  }
  try {
    return nativeImage.createFromBitmap(buf, { width: size, height: size });
  } catch {
    return base;
  }
}

function getTrayIconBusy() {
  if (trayIconBusy && !trayIconBusy.isEmpty()) return trayIconBusy;
  // 橙红点：进行中
  trayIconBusy = paintTrayBadge(getTrayIconBase(), [255, 92, 28]);
  return trayIconBusy;
}

function stopTrayBlink() {
  if (trayBlinkTimer != null) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }
  trayBlinkOn = true;
}

function applyTrayIcon(busy) {
  if (!tray) return;
  const base = getTrayIconBase();
  const icon = busy ? getTrayIconBusy() : base;
  try {
    tray.setImage(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  } catch {
    /* ignore */
  }
}

function syncTrayBlink(busy) {
  if (!busy) {
    stopTrayBlink();
    applyTrayIcon(false);
    return;
  }
  applyTrayIcon(true);
  if (trayBlinkTimer != null) return;
  // 轻微点亮/熄灭，托盘更容易注意到有任务
  trayBlinkTimer = setInterval(() => {
    if (!tray || bgActivities.size === 0) {
      stopTrayBlink();
      applyTrayIcon(false);
      return;
    }
    trayBlinkOn = !trayBlinkOn;
    applyTrayIcon(trayBlinkOn);
  }, 900);
}

function resolveApiLaunch() {
  if (!isPackaged()) {
    const py = process.env.TOOLBOX_PYTHON || "python";
    const args = ["-m", "tools.api", "--port", API_PORT];
    if (process.env.TOOLBOX_API_RELOAD !== "0") args.push("--reload");
    return {
      cmd: py,
      args,
      cwd: repoRoot(),
      env: { PYTHONPATH: repoRoot() },
    };
  }
  const res = resourcesDir();
  const candidates = [
    path.join(res, "toolbox-api", "toolbox-api.exe"),
    path.join(res, "toolbox-api.exe"),
    path.join(res, "app", "toolbox-api", "toolbox-api.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { cmd: p, args: ["--port", API_PORT], cwd: path.dirname(p) };
    }
  }
  const py = process.env.TOOLBOX_PYTHON || "python";
  return {
    cmd: py,
    args: ["-m", "tools.api", "--port", API_PORT],
    cwd: repoRoot(),
    env: { PYTHONPATH: repoRoot() },
  };
}

function fetchAuthorizedVersion(url, token) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${url}/version`,
      { headers: token ? { "X-Toolbox-Token": token } : {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`version ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(1500, () => {
      req.destroy();
      reject(new Error("version timeout"));
    });
  });
}

function fetchHealth(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}/health`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`health ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(1500, () => {
      req.destroy();
      reject(new Error("health timeout"));
    });
  });
}

function waitForHealth(url, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetchHealth(url)
        .then((h) => {
          const rev = Number(h.api_rev || 0);
          if (rev < NEED_API_REV) {
            reject(
              new Error(
                `检测到旧版 API（api_rev=${rev || 0}）。请托盘右键退出后重开，或结束占用 ${API_PORT} 端口的旧进程。`,
              ),
            );
            return;
          }
          resolve(h);
        })
        .catch(() => {
          if (Date.now() - started > timeoutMs) {
            reject(new Error("API 启动超时"));
            return;
          }
          setTimeout(tick, 300);
        });
    };
    tick();
  });
}

function toolboxDataDir() {
  let explicit = "";
  try {
    explicit = String(process.env.TOOLBOX_DATA_DIR || "").trim();
  } catch {
    explicit = "";
  }
  if (explicit) return explicit;

  // 统一写到安装目录/userdata（日志、报告、串口、拉取等）
  const install = toolboxInstallDir();
  const preferred = path.join(install, "userdata");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, ".toolbox_write_test");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
  } catch {
    // Program Files 等不可写时回退 LocalAppData
    const local =
      process.env.LOCALAPPDATA ||
      path.join(app.getPath("home"), "AppData", "Local");
    const fallback = path.join(local, APP_NAME);
    const legacy = path.join(local, LEGACY_DATA_DIR_NAME);
    try {
      if (!fs.existsSync(fallback) && fs.existsSync(legacy)) {
        fs.renameSync(legacy, fallback);
      }
    } catch {
      if (fs.existsSync(legacy) && !fs.existsSync(fallback)) return legacy;
    }
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      /* ignore */
    }
    return fallback;
  }

  // 从旧 LocalAppData 迁入（不覆盖）
  try {
    const local =
      process.env.LOCALAPPDATA ||
      path.join(app.getPath("home"), "AppData", "Local");
    const legacy = path.join(local, APP_NAME);
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(preferred)) {
      for (const name of ["config", "output", "logs", "vendor"]) {
        const src = path.join(legacy, name);
        const dst = path.join(preferred, name);
        if (!fs.existsSync(src)) continue;
        copyDirMerge(src, dst);
      }
      migrateSettingsJson(legacy, preferred);
    }
    const veryOld = path.join(local, LEGACY_DATA_DIR_NAME);
    if (
      fs.existsSync(veryOld) &&
      path.resolve(veryOld) !== path.resolve(preferred)
    ) {
      migrateSettingsJson(veryOld, preferred);
    }
    const keep = path.join(local, APP_NAME, "_keep_userdata");
    if (fs.existsSync(keep) && path.resolve(keep) !== path.resolve(preferred)) {
      for (const name of ["config", "output", "logs", "vendor"]) {
        copyDirMerge(path.join(keep, name), path.join(preferred, name));
      }
      migrateSettingsJson(keep, preferred);
    }
  } catch {
    /* ignore */
  }

  return preferred;
}

function migrateSettingsJson(legacyRoot, destDir) {
  const dest = path.join(destDir, "config", "settings.json");
  const srcs = [
    path.join(legacyRoot, "settings.json"),
    path.join(legacyRoot, "config", "settings.json"),
  ];
  const src = srcs.find((p) => fs.existsSync(p));
  if (!src) return;
  try {
    if (path.resolve(src) === path.resolve(dest)) return;
  } catch {
    /* ignore */
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    try {
      fs.copyFileSync(src, dest);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const old = JSON.parse(fs.readFileSync(src, "utf8"));
    const cur = JSON.parse(fs.readFileSync(dest, "utf8"));
    if (!old || typeof old !== "object" || !cur || typeof cur !== "object") {
      return;
    }
    let changed = false;
    for (const [k, v] of Object.entries(old)) {
      if (!(k in cur)) {
        cur[k] = v;
        changed = true;
      }
    }
    for (const key of ["adb_tools.shell_presets", "remote.login_accounts"]) {
      if (Array.isArray(old[key]) && old[key].length) {
        if (!Array.isArray(cur[key]) || !cur[key].length) {
          cur[key] = old[key];
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(dest, `${JSON.stringify(cur, null, 2)}\n`, "utf8");
    }
  } catch {
    /* ignore */
  }
}

function electronSettingsPath() {
  return path.join(toolboxDataDir(), "config", "settings.json");
}

/** @returns {Record<string, any>} */
function readElectronSettings() {
  try {
    const p = electronSettingsPath();
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, any>} patch */
function writeElectronSettings(patch) {
  const p = electronSettingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cur = readElectronSettings();
  const next = { ...cur, ...(patch && typeof patch === "object" ? patch : {}) };
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (Object.prototype.hasOwnProperty.call(patch || {}, "updateUrl")) {
    const f = path.join(toolboxDataDir(), "update-url.txt");
    const url = String(patch.updateUrl || "").trim();
    try {
      if (url) fs.writeFileSync(f, `${url}\n`, "utf8");
      else if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  return next;
}

function applyAlwaysOnTop(win, on) {
  if (!win || win.isDestroyed()) return;
  if (on) {
    win.setAlwaysOnTop(true, "screen-saver");
    try {
      win.moveTop();
    } catch {
      /* ignore */
    }
  } else {
    win.setAlwaysOnTop(false);
  }
}

const DEFAULT_WIN_W = 1180;
const DEFAULT_WIN_H = 760;
const MIN_WIN_W = 960;
const MIN_WIN_H = 600;

/** @returns {{ x: number, y: number, width: number, height: number, maximized: boolean } | null} */
function readSavedWindowBounds() {
  try {
    const s = readElectronSettings();
    const remember =
      typeof s.rememberWindowBounds === "boolean" ? s.rememberWindowBounds : true;
    if (!remember) return null;
    const b = s.windowBounds;
    if (!b || typeof b !== "object") return null;
    const width = Math.round(Number(b.width));
    const height = Math.round(Number(b.height));
    const x = Math.round(Number(b.x));
    const y = Math.round(Number(b.y));
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < MIN_WIN_W ||
      height < MIN_WIN_H ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return null;
    }
    return {
      x,
      y,
      width,
      height,
      maximized: Boolean(b.maximized),
    };
  } catch {
    return null;
  }
}

/** @param {import('electron').BrowserWindow} win */
function saveWindowBounds(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const s = readElectronSettings();
    const remember =
      typeof s.rememberWindowBounds === "boolean" ? s.rememberWindowBounds : true;
    if (!remember) return;
    if (win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b =
      maximized && typeof win.getNormalBounds === "function"
        ? win.getNormalBounds()
        : win.getBounds();
    writeElectronSettings({
      windowBounds: {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
        maximized,
      },
    });
  } catch {
    /* ignore */
  }
}

/** @param {{ x: number, y: number, width: number, height: number }} b */
function clampBoundsToDisplay(b) {
  try {
    const display = screen.getDisplayMatching(b);
    const wa = display.workArea;
    const width = Math.min(Math.max(b.width, MIN_WIN_W), wa.width);
    const height = Math.min(Math.max(b.height, MIN_WIN_H), wa.height);
    let x = b.x;
    let y = b.y;
    if (x + width < wa.x + 40) x = wa.x;
    if (y + height < wa.y + 40) y = wa.y;
    if (x > wa.x + wa.width - 40) x = wa.x + Math.max(0, wa.width - width);
    if (y > wa.y + wa.height - 40) y = wa.y + Math.max(0, wa.height - height);
    return { x, y, width, height };
  } catch {
    return {
      x: b.x,
      y: b.y,
      width: Math.max(b.width, MIN_WIN_W),
      height: Math.max(b.height, MIN_WIN_H),
    };
  }
}

function copyDirMerge(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirMerge(s, d);
    } else if (!fs.existsSync(d)) {
      try {
        fs.copyFileSync(s, d);
      } catch {
        /* ignore */
      }
    }
  }
}

function toolboxInstallDir() {
  return process.env.TOOLBOX_INSTALL_DIR || path.dirname(process.execPath);
}

function readUpdateFeedRaw() {
  const fromEnv = (process.env.TOOLBOX_UPDATE_URL || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const f = path.join(toolboxDataDir(), "update-url.txt");
    if (fs.existsSync(f)) {
      const line = fs
        .readFileSync(f, "utf8")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .find(Boolean);
      if (line) return line;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_UPDATE_URL;
}

/**
 * @returns {{ mode: 'http', url: string } | { mode: 'fs', dir: string }}
 */
function resolveUpdateFeed() {
  const raw = String(readUpdateFeedRaw() || "")
    .trim()
    .replace(/[\\/]+$/, "");
  if (!raw) return { mode: "http", url: DEFAULT_UPDATE_URL };

  if (/^https?:\/\//i.test(raw)) {
    return { mode: "http", url: raw };
  }

  // file://server/share/path 或 file:///C:/path → 本地/UNC 目录
  if (/^file:/i.test(raw)) {
    let p = raw.replace(/^file:\/\//i, "");
    if (p.startsWith("/")) p = p.slice(1);
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep */
    }
    p = p.replace(/\//g, "\\");
    if (/^[A-Za-z]:\\/.test(p)) {
      return { mode: "fs", dir: p };
    }
    const dir = p.startsWith("\\\\") ? p : `\\\\${p}`;
    return { mode: "fs", dir };
  }

  // //server/share 或 \\server\share 或盘符路径
  if (raw.startsWith("//")) {
    return { mode: "fs", dir: `\\\\${raw.slice(2).replace(/\//g, "\\")}` };
  }
  return { mode: "fs", dir: raw.replace(/\//g, "\\") };
}

function cmpVersion(a, b) {
  const pa = String(a || "")
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "")
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

function parseLatestYml(text) {
  const version = (text.match(/^version:\s*[\'\"]?([^\s\'\"]+)/m) || [])[1] || "";
  const fileName =
    (text.match(/^path:\s*[\'\"]?([^\s\'\"]+)/m) || [])[1] ||
    (text.match(/^\s*-?\s*url:\s*[\'\"]?([^\s\'\"]+)/m) || [])[1] ||
    "";
  const sha512 = (text.match(/^sha512:\s*(\S+)/m) || [])[1] || "";
  const size = Number((text.match(/^\s+size:\s*(\d+)/m) || [])[1] || 0);
  return { version, fileName, sha512, size };
}

function sha512FileBase64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

function copyFileWithProgress(src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(src).size || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    let done = 0;
    let lastPct = -1;
    rs.on("data", (chunk) => {
      done += chunk.length;
      if (!total) return;
      const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
      if (pct !== lastPct) {
        lastPct = pct;
        try {
          onProgress?.(pct, done, total);
        } catch {
          /* ignore */
        }
      }
    });
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", () => resolve({ size: done, total }));
    rs.pipe(ws);
  });
}

function broadcastUpdateStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("toolbox:update-status", payload);
    }
  } catch {
    /* ignore */
  }
}

function friendlyUpdateError(err, feedDir) {
  const msg = String(err?.message || err || "更新失败");
  if (
    msg.includes("ENOENT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EACCES") ||
    msg.includes("EPERM") ||
    msg.includes("network") ||
    msg.includes("无法访问") ||
    msg.includes("找不到")
  ) {
    return `无法访问更新目录，请确认本机可打开：\n${feedDir || DEFAULT_UPDATE_UNC}`;
  }
  if (msg.includes("only supports http") || msg.includes("file:")) {
    return `更新源需为 NAS 路径或 http(s)。当前目录：\n${feedDir || DEFAULT_UPDATE_UNC}`;
  }
  if (msg.length > 120) return `${msg.slice(0, 117)}…`;
  return msg;
}

function nativeAppPrompt(spec) {
  const title = String(spec.title || "提示");
  const body = String(spec.body || "");
  const tips = Array.isArray(spec.tips) ? spec.tips.map(String) : [];
  const primary = String(spec.primary || "确定");
  const secondary = String(spec.secondary || "取消");
  const win =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  return dialog
    .showMessageBox(win, {
      type: "info",
      title,
      message: title,
      detail: [body, ...tips].filter(Boolean).join("\n"),
      buttons: [primary, secondary],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => (response === 0 ? "primary" : "secondary"))
    .catch(() => "cancel");
}

/**
 * 更新提示：优先应用内弹窗；未显示则回退系统对话框（避免 ACK 后无界面卡死）。
 * @returns {Promise<'primary'|'secondary'|'cancel'>}
 */
function askAppPrompt(spec) {
  const mark = spec.mark || "info";
  const title = String(spec.title || "提示");
  const body = String(spec.body || "");
  const tips = Array.isArray(spec.tips) ? spec.tips.map(String) : [];
  const primary = String(spec.primary || "确定");
  const secondary = String(spec.secondary || "取消");
  const payload = { mark, title, body, tips, primary, secondary };

  return new Promise((resolve) => {
    try {
      showMainWindow();
    } catch {
      /* ignore */
    }
    const wc =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!wc || wc.isDestroyed()) {
      void nativeAppPrompt(payload).then(resolve);
      return;
    }

    let settled = false;
    let acked = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let ackTimer = null;
    const detach = () => {
      if (ackTimer != null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      ipcMain.removeListener("toolbox:app-prompt-ack", onAck);
      ipcMain.removeListener("toolbox:app-prompt-result", onResult);
    };
    const finish = (action) => {
      if (settled) return;
      settled = true;
      detach();
      const a = String(action || "cancel");
      if (a === "primary" || a === "secondary") resolve(a);
      else resolve("cancel");
    };
    const onAck = () => {
      acked = true;
      if (ackTimer != null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
    };
    const onResult = (_event, value) => finish(value);
    ipcMain.on("toolbox:app-prompt-ack", onAck);
    ipcMain.on("toolbox:app-prompt-result", onResult);

    // 前端须在真正渲染后 ACK；超时才回退系统框（优先保持与关闭确认同一套 UI）
    ackTimer = setTimeout(() => {
      if (acked || settled) return;
      try {
        wc.send("toolbox:app-prompt-dismiss");
      } catch {
        /* ignore */
      }
      detach();
      void nativeAppPrompt(payload).then(finish);
    }, 3000);

    const send = () => {
      try {
        wc.send("toolbox:app-prompt", payload);
      } catch {
        detach();
        void nativeAppPrompt(payload).then(finish);
      }
    };
    if (wc.isLoading()) {
      wc.once("did-finish-load", () => {
        if (!settled) setTimeout(send, 300);
      });
    } else {
      setTimeout(send, 50);
    }
  });
}

async function askConfirmUpdate(version) {
  const current = app.getVersion();
  const v = version || "";
  const action = await askAppPrompt({
    mark: "update",
    title: "发现新版本",
    body: v
      ? `检测到新版本 ${v}（当前 ${current}）。是否立即更新？`
      : `检测到新版本（当前 ${current}）。是否立即更新？`,
    tips: [
      "选择「下次再说」可继续使用，下次打开时再提示",
      "升级会保留登录账号、配置与报告（安装目录 userdata）",
    ],
    primary: "立即更新",
    secondary: "下次再说",
  });
  return action === "primary";
}

function markUpdateDeferred(version) {
  updateBusy = false;
  updateDeferredThisSession = true;
  const v = version || "";
  const payload = {
    state: "deferred",
    message: v
      ? `有新版本 ${v}，已推迟；下次打开再提示`
      : "已推迟更新；下次打开再提示",
    version: v,
  };
  broadcastUpdateStatus(payload);
  return payload;
}

async function promptInstallReady(version) {
  updateBusy = false;
  updateDownloaded = true;
  const v = version || pendingInstallerVersion || "";
  broadcastUpdateStatus({
    state: "ready",
    message: v ? `新版本 ${v} 已就绪，可重启安装` : "更新已就绪，可重启安装",
    version: v,
  });
  const action = await askAppPrompt({
    mark: "update",
    title: "更新就绪",
    body: v
      ? `新版本 ${v} 已准备完成，是否立即安装？`
      : "更新已准备完成，是否立即安装？",
    tips: [
      "将打开安装向导（有进度条），随后自动退出本程序",
      "请在安装向导中点「下一步」完成安装",
      "安装结束后请从桌面快捷方式打开（不要在安装程序里立刻启动）",
      "选择「下次再说」可继续使用，下次打开仍会提示",
    ],
    primary: "立即安装",
    secondary: "下次再说",
  });
  if (action === "primary") {
    broadcastUpdateStatus({
      state: "installing",
      message: "正在打开安装程序…",
      version: v,
    });
    setTimeout(() => quitAndInstallUpdate(), 30);
    return;
  }
  updateDeferredThisSession = true;
  broadcastUpdateStatus({
    state: "ready",
    message: v
      ? `新版本 ${v} 已就绪；下次打开再提示安装`
      : "更新已就绪；下次打开再提示安装",
    version: v,
  });
}

function killManagedApiHard() {
  managedApi = false;
  if (!apiProc) return;
  const pid = apiProc.pid;
  try {
    apiProc.kill();
  } catch {
    /* ignore */
  }
  apiProc = null;
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      /* ignore */
    }
  }
}

function forceQuitApp() {
  try {
    stopTrayBlink();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeAllListeners("close");
      mainWindow.destroy();
    }
  } catch {
    /* ignore */
  }
  mainWindow = null;
  killManagedApiHard();
  setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      process.exit(0);
    }
  }, 200);
}

/**
 * 直接打开安装包（GUI 程序，不要经过 cmd，避免黑窗口）。
 */
function quitAndInstallUpdate() {
  quitting = true;
  const installer = pendingInstallerPath;

  if (!installer || !fs.existsSync(installer)) {
    try {
      autoUpdater.quitAndInstall(false, false);
      return;
    } catch (err) {
      quitting = false;
      broadcastUpdateStatus({
        state: "error",
        message: `安装失败：${String(err?.message || err)}`,
      });
      return;
    }
  }

  broadcastUpdateStatus({
    state: "installing",
    message: "正在打开安装程序…",
    version: pendingInstallerVersion,
  });

  let opened = false;
  try {
    spawn(installer, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: path.dirname(installer),
    }).unref();
    opened = true;
  } catch {
    opened = false;
  }
  if (!opened) {
    try {
      void shell.openPath(installer);
    } catch (err) {
      quitting = false;
      broadcastUpdateStatus({
        state: "error",
        message: `无法打开安装程序：${String(err?.message || err)}`,
      });
      return;
    }
  }

  setTimeout(() => forceQuitApp(), 2000);
}

function setupAutoUpdater() {
  if (updaterWired || !app.isPackaged) return;
  updaterWired = true;

  // 先询问用户，再手动 downloadUpdate()
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  try {
    autoUpdater.disableDifferentialDownload = true;
  } catch {
    /* ignore */
  }

  autoUpdater.on("checking-for-update", () => {
    broadcastUpdateStatus({ state: "checking", message: "正在检查更新…" });
  });

  autoUpdater.on("update-available", (info) => {
    const v = info?.version || "";
    broadcastUpdateStatus({
      state: "available",
      message: v ? `发现新版本 ${v}` : "发现新版本",
      version: v,
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateBusy = false;
    broadcastUpdateStatus({
      state: "none",
      message: "已是最新版本",
      version: app.getVersion(),
    });
  });

  autoUpdater.on("download-progress", (p) => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
    broadcastUpdateStatus({
      state: "downloading",
      message: `下载中 ${pct}%`,
      percent: pct,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    void promptInstallReady(info?.version || "");
  });

  autoUpdater.on("error", (err) => {
    updateBusy = false;
    const detail = String(err?.message || err || "更新失败");
    broadcastUpdateStatus({
      state: "error",
      message: friendlyUpdateError(err),
      detail,
    });
  });
}

async function downloadFsUpdate(dir, info) {
  const src = path.join(dir, info.fileName);
  if (!fs.existsSync(src)) {
    updateBusy = false;
    const message = `NAS 上缺少安装包：${info.fileName}`;
    broadcastUpdateStatus({ state: "error", message });
    return { ok: false, state: "error", message };
  }

  broadcastUpdateStatus({
    state: "available",
    message: `正在从 NAS 复制 ${info.version}…`,
    version: info.version,
  });

  const dest = path.join(
    app.getPath("temp"),
    "toolbox-updates",
    info.fileName,
  );

  // 已复制过且校验通过则复用
  let reuse = false;
  if (fs.existsSync(dest) && info.sha512) {
    try {
      const dig = await sha512FileBase64(dest);
      reuse = dig === info.sha512;
    } catch {
      reuse = false;
    }
  }

  if (!reuse) {
    try {
      await copyFileWithProgress(src, dest, (pct) => {
        broadcastUpdateStatus({
          state: "downloading",
          message: `复制中 ${pct}%`,
          percent: pct,
          version: info.version,
        });
      });
      if (info.sha512) {
        const dig = await sha512FileBase64(dest);
        if (dig !== info.sha512) {
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          const message = "安装包校验失败，请重新发布到 NAS";
          broadcastUpdateStatus({ state: "error", message });
          updateBusy = false;
          return { ok: false, state: "error", message };
        }
      }
    } catch (err) {
      updateBusy = false;
      const message = friendlyUpdateError(err, dir);
      broadcastUpdateStatus({ state: "error", message, detail: String(err) });
      return { ok: false, state: "error", message };
    }
  }

  pendingInstallerPath = dest;
  pendingInstallerVersion = info.version;
  await promptInstallReady(info.version);
  return {
    ok: true,
    state: "ready",
    version: info.version,
    message: `新版本 ${info.version} 已就绪`,
  };
}

async function checkForUpdatesFromFs(dir, { manual = false } = {}) {
  const latestPath = path.join(dir, "latest.yml");
  broadcastUpdateStatus({
    state: "checking",
    message: manual ? "正在检查更新…" : "启动检查更新…",
  });

  let text;
  try {
    text = fs.readFileSync(latestPath, "utf8");
  } catch (err) {
    updateBusy = false;
    const message = friendlyUpdateError(
      new Error(`找不到 latest.yml（${String(err?.code || err?.message || err)}）`),
      dir,
    );
    broadcastUpdateStatus({ state: "error", message, detail: String(err) });
    return { ok: false, state: "error", message };
  }

  const info = parseLatestYml(text);
  if (!info.version || !info.fileName) {
    updateBusy = false;
    const message = "更新元数据无效（latest.yml）";
    broadcastUpdateStatus({ state: "error", message });
    return { ok: false, state: "error", message };
  }

  const current = app.getVersion();
  if (cmpVersion(info.version, current) <= 0) {
    updateBusy = false;
    const payload = {
      state: "none",
      message: "已是最新版本",
      version: current,
    };
    broadcastUpdateStatus(payload);
    return { ok: true, ...payload };
  }

  broadcastUpdateStatus({
    state: "available",
    message: `发现新版本 ${info.version}`,
    version: info.version,
  });

  const accept = await askConfirmUpdate(info.version);
  if (!accept) {
    return { ok: true, ...markUpdateDeferred(info.version) };
  }

  updateDeferredThisSession = false;
  return downloadFsUpdate(dir, info);
}

async function checkForUpdatesFromHttp(url, { manual = false } = {}) {
  setupAutoUpdater();
  try {
    autoUpdater.setFeedURL({ provider: "generic", url });
  } catch (err) {
    updateBusy = false;
    const message = `更新源无效：${String(err?.message || err)}`;
    broadcastUpdateStatus({ state: "error", message });
    return { ok: false, state: "error", message };
  }

  broadcastUpdateStatus({
    state: "checking",
    message: manual ? "正在检查更新…" : "启动检查更新…",
    url,
  });
  try {
    const result = await autoUpdater.checkForUpdates();
    const remote = result?.updateInfo?.version || "";
    const available =
      !!remote && cmpVersion(remote, app.getVersion()) > 0;

    if (!available) {
      updateBusy = false;
      const payload = {
        state: "none",
        message: "已是最新版本",
        version: app.getVersion(),
      };
      broadcastUpdateStatus(payload);
      return { ok: true, ...payload };
    }

    const accept = await askConfirmUpdate(remote);
    if (!accept) {
      return { ok: true, ...markUpdateDeferred(remote) };
    }

    updateDeferredThisSession = false;
    broadcastUpdateStatus({
      state: "available",
      message: `正在下载 ${remote}…`,
      version: remote,
    });
    await autoUpdater.downloadUpdate();
    return {
      ok: true,
      state: "downloading",
      version: remote,
    };
  } catch (err) {
    updateBusy = false;
    const message = friendlyUpdateError(err);
    broadcastUpdateStatus({
      state: "error",
      message,
      detail: String(err?.message || err),
    });
    return { ok: false, state: "error", message };
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) {
    const payload = {
      state: "idle",
      message: "开发模式不检查更新",
    };
    broadcastUpdateStatus(payload);
    return { ok: false, reason: "dev", ...payload };
  }
  if (!manual && updateDeferredThisSession) {
    return {
      ok: true,
      state: "deferred",
      message: "本会话已推迟更新",
    };
  }
  if (updateDownloaded) {
    await promptInstallReady(pendingInstallerVersion);
    return {
      ok: true,
      state: "ready",
      version: pendingInstallerVersion,
      message: pendingInstallerVersion
        ? `新版本 ${pendingInstallerVersion} 已就绪`
        : "更新已就绪",
    };
  }
  if (updateBusy) {
    return { ok: true, state: "busy", message: "正在检查或下载…" };
  }

  updateBusy = true;
  const feed = resolveUpdateFeed();
  try {
    if (feed.mode === "http") {
      return await checkForUpdatesFromHttp(feed.url, { manual });
    }
    return await checkForUpdatesFromFs(feed.dir, { manual });
  } catch (err) {
    updateBusy = false;
    const message = friendlyUpdateError(
      err,
      feed.mode === "fs" ? feed.dir : undefined,
    );
    broadcastUpdateStatus({ state: "error", message });
    return { ok: false, state: "error", message };
  }
}

async function startManagedApi(opts = {}) {
  if (process.env.TOOLBOX_API_MANAGED === "0") return;
  if (DEV_SERVER) return;
  if (apiBootPromise) return apiBootPromise;

  const silent = Boolean(opts && opts.silent);
  apiBootPromise = (async () => {
    const dataDir = toolboxDataDir();
    const installDir = toolboxInstallDir();
    try {
      fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "install_dir.txt"), `${installDir}\n`, "utf8");
    } catch {
      /* ignore */
    }

    // 仅当既有服务 API_TOKEN 一致且 api_rev >= NEED_API_REV 时才复用，否则清理后自起
    try {
      const existing = await fetchAuthorizedVersion(API_URL, API_TOKEN);
      if (Number(existing.api_rev || 0) >= NEED_API_REV) {
        managedApi = Boolean(apiProc);
        return;
      }
    } catch {
      /* token mismatch / offline / stale -> respawn */
    }

    const launch = resolveApiLaunch();
    if (process.platform === "win32") {
      try {
        const out = execSync(`netstat -ano -p tcp | findstr :${API_PORT}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[1].endsWith(`:${API_PORT}`) && parts[3] === "LISTENING") {
            const pid = Number(parts[4]);
            if (pid > 0 && pid !== process.pid) {
              execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true });
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (path.isAbsolute(launch.cmd) && !fs.existsSync(launch.cmd)) {
      if (!silent) {
        dialog.showErrorBox(
          APP_NAME,
          `找不到本机服务：\n${launch.cmd}\n\n请重新解压完整便携包后再运行。`,
        );
      }
      return;
    }

    let stdio = "ignore";
    try {
      const logPath = path.join(dataDir, "logs", "api", "toolbox-api.log");
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
      } catch {
        /* ignore */
      }
      const logFd = fs.openSync(logPath, "a");
      stdio = ["ignore", logFd, logFd];
    } catch {
      stdio = "ignore";
    }

    const proc = spawn(launch.cmd, launch.args, {
      cwd: launch.cwd,
      stdio,
      windowsHide: true,
      env: {
        ...process.env,
        TOOLBOX_API_PORT: API_PORT,
        TOOLBOX_API_TOKEN: API_TOKEN,
        TOOLBOX_DATA_DIR: dataDir,
        TOOLBOX_INSTALL_DIR: installDir,
        ...(launch.env || {}),
      },
    });
    apiProc = proc;
    managedApi = true;
    proc.on("exit", (code) => {
      if (apiProc === proc) {
        apiProc = null;
      }
      if (managedApi && !quitting) {
        console.error(`toolbox-api exited: ${code}`);
        const now = Date.now();
        apiAutoRestartTimes = apiAutoRestartTimes.filter((t) => now - t < 60000);
        if (apiAutoRestartTimes.length < 3) {
          apiAutoRestartTimes.push(now);
          setTimeout(() => {
            if (!quitting && !apiProc) {
              void startManagedApi({ silent: true });
            }
          }, 1200);
        }
      }
    });
    try {
      await waitForHealth(API_URL);
    } catch (err) {
      if (!silent) {
        dialog.showErrorBox(
          APP_NAME,
          `本机服务未能启动。\n${err.message}\n\n请托盘右键「退出」后重开。\n日志：安装目录\\userdata\\logs\\api\\toolbox-api.log`,
        );
      }
    }
  })().finally(() => {
    apiBootPromise = null;
  });

  return apiBootPromise;
}

function showMainWindow() {
  if (!app.isReady()) {
    app.whenReady().then(() => showMainWindow());
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  refreshTrayUi();
}

function activityLabels() {
  return [...bgActivities.values()];
}

function windowIsHidden() {
  return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible();
}

function trayTooltipText() {
  const labels = activityLabels();
  if (!labels.length) {
    return windowIsHidden()
      ? `${APP_NAME}（后台运行中）— 双击打开`
      : `${APP_NAME}`;
  }
  const brief = labels.slice(0, 3).join("、");
  const more = labels.length > 3 ? ` 等 ${labels.length} 项` : "";
  return `${APP_NAME}\n进行中：${brief}${more}\n双击打开窗口`;
}

function refreshTrayUi(opts = {}) {
  if (!tray) return;
  const labels = activityLabels();
  syncTrayBlink(labels.length > 0);
  try {
    tray.setToolTip(trayTooltipText());
  } catch {
    /* ignore */
  }
  const menu = Menu.buildFromTemplate([
    ...(labels.length
      ? [
          {
            label: `进行中：${labels.join("、")}`,
            enabled: false,
          },
          { type: "separator" },
        ]
      : []),
    {
      label: `打开 ${APP_NAME}`,
      click: () => showMainWindow(),
    },
    {
      label: "打开数据目录（配置/报告，升级保留）",
      click: () => {
        const dir = toolboxDataDir();
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          /* ignore */
        }
        shell.openPath(dir);
      },
    },
    {
      label: "打开安装目录",
      click: () => shell.openPath(toolboxInstallDir()),
    },
    {
      label: "检查更新",
      click: () => {
        void checkForUpdates({ manual: true });
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  try {
    tray.setContextMenu(menu);
  } catch {
    /* ignore */
  }

  if (opts.notify && labels.length && windowIsHidden() && process.platform === "win32") {
    const now = Date.now();
    if (now - lastActivityBalloonAt > 8000) {
      lastActivityBalloonAt = now;
      try {
        tray.displayBalloon({
          title: `${APP_NAME} 任务进行中`,
          content: `${labels.join("、")}\n双击托盘图标可打开窗口查看进度。`,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

function setBackgroundActivity(id, active, label) {
  const key = String(id || "").trim();
  if (!key) return;
  const wasActive = bgActivities.has(key);
  const prevLabel = bgActivities.get(key) || "";
  if (active) {
    bgActivities.set(key, String(label || key).trim() || key);
  } else {
    bgActivities.delete(key);
  }
  const nowActive = bgActivities.has(key);
  refreshTrayUi({
    notify: active && !wasActive && nowActive,
  });
  // 后台任务结束时提示一次
  if (
    wasActive &&
    !nowActive &&
    windowIsHidden() &&
    tray &&
    process.platform === "win32"
  ) {
    const now = Date.now();
    if (now - lastActivityBalloonAt > 3000) {
      lastActivityBalloonAt = now;
      try {
        tray.displayBalloon({
          title: `${APP_NAME} 任务结束`,
          content: `${prevLabel || key} 已结束。双击托盘打开查看结果。`,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  refreshTrayUi();
  if (tray && process.platform === "win32") {
    const labels = activityLabels();
    try {
      tray.displayBalloon({
        title: labels.length
          ? `${APP_NAME} 后台运行（有任务）`
          : `${APP_NAME} 已在后台运行`,
        content: labels.length
          ? `进行中：${labels.join("、")}\n双击托盘图标可打开窗口；右键可选「退出」。`
          : "双击右下角托盘图标可打开窗口；右键可选「退出」。",
      });
    } catch {
      /* ignore */
    }
  }
}

function normalizeCloseAction(value) {
  if (value === "tray" || value === "quit" || value === "cancel") return value;
  return "cancel";
}

/** 系统对话框兜底（页面未就绪时） */
async function nativeConfirmClose() {
  if (!mainWindow || mainWindow.isDestroyed()) return "cancel";
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: APP_NAME,
    message: "关闭窗口后将在后台运行",
    detail: "双击托盘图标可重新打开；托盘右键「退出」可结束程序。",
    buttons: ["后台运行", "退出程序", "取消"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 0) return "tray";
  if (result.response === 1) return "quit";
  return "cancel";
}

/** 优先走应用内弹窗，与界面风格一致 */
function askCloseAction() {
  return new Promise((resolve) => {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!wc || wc.isDestroyed() || wc.isLoading()) {
      void nativeConfirmClose().then(resolve);
      return;
    }

    let settled = false;
    let acked = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let ackTimer = null;
    const detach = () => {
      if (ackTimer != null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      ipcMain.removeListener("toolbox:close-prompt-ack", onAck);
      ipcMain.removeListener("toolbox:close-prompt-result", onResult);
    };
    const finish = (action) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(normalizeCloseAction(action));
    };
    const onAck = () => {
      acked = true;
      if (ackTimer != null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
    };
    const onResult = (_event, value) => finish(value);
    ipcMain.on("toolbox:close-prompt-ack", onAck);
    ipcMain.on("toolbox:close-prompt-result", onResult);

    // 页面未挂载监听时回退原生框，避免卡住
    ackTimer = setTimeout(() => {
      if (acked || settled) return;
      detach();
      void nativeConfirmClose().then(finish);
    }, 600);

    try {
      wc.send("toolbox:close-prompt");
    } catch {
      detach();
      void nativeConfirmClose().then(finish);
    }
  });
}

async function confirmCloseToTray() {
  if (!mainWindow || mainWindow.isDestroyed() || closePromptOpen) return;
  closePromptOpen = true;
  try {
    const s = readElectronSettings();
    const remembered =
      s.closeAction === "tray" || s.closeAction === "quit" ? s.closeAction : "";
    const action = remembered || (await askCloseAction());
    if (action === "tray") {
      hideToTray();
    } else if (action === "quit") {
      quitting = true;
      app.quit();
    }
  } finally {
    closePromptOpen = false;
  }
}

function createTray() {
  if (tray) return;
  const icon = getTrayIconBase();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  refreshTrayUi();
  tray.on("double-click", () => showMainWindow());
  tray.on("click", () => showMainWindow());
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

  const saved = readSavedWindowBounds();
  const clamped = saved
    ? clampBoundsToDisplay({
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
      })
    : null;

  mainWindow = new BrowserWindow({
    width: clamped?.width || DEFAULT_WIN_W,
    height: clamped?.height || DEFAULT_WIN_H,
    x: clamped ? clamped.x : undefined,
    y: clamped ? clamped.y : undefined,
    minWidth: MIN_WIN_W,
    minHeight: MIN_WIN_H,
    title: APP_NAME,
    backgroundColor: "#f3f4f6",
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    trafficLightPosition:
      process.platform === "darwin" ? { x: 14, y: 11 } : undefined,
    icon: path.join(__dirname, "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let saveBoundsTimer = null;
  const scheduleSaveBounds = () => {
    if (saveBoundsTimer != null) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      saveBoundsTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowBounds(mainWindow);
    }, 350);
  };
  mainWindow.on("resize", scheduleSaveBounds);
  mainWindow.on("move", scheduleSaveBounds);
  mainWindow.on("maximize", scheduleSaveBounds);
  mainWindow.on("unmaximize", scheduleSaveBounds);

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (saved?.maximized) mainWindow.maximize();
    } catch {
      /* ignore */
    }
    try {
      if (readElectronSettings().alwaysOnTop) {
        applyAlwaysOnTop(mainWindow, true);
      }
    } catch {
      /* ignore */
    }
    mainWindow.show();
    mainWindow.focus();
  });

  const emitMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send(
        "toolbox:window-maximized",
        mainWindow.isMaximized(),
      );
    } catch {
      /* ignore */
    }
  };
  mainWindow.on("maximize", emitMaximized);
  mainWindow.on("unmaximize", emitMaximized);

  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void confirmCloseToTray();
  });

  mainWindow.on("minimize", (e) => {
    try {
      if (readElectronSettings().minimizeToTray) {
        e.preventDefault();
        hideToTray();
      }
    } catch {
      /* ignore */
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const x = Number(params.x) || 0;
    const y = Number(params.y) || 0;
    const probe = `
      (() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return { skip: false, field: false, editable: false };
        if (el.closest(".xterm, .xterm-helper-textarea, .files-list, .files-ctx-menu"))
          return { skip: true, field: false, editable: false };
        const t = el.closest("input, textarea");
        if (!t) return { skip: false, field: false, editable: false };
        const tag = String(t.tagName || "").toLowerCase();
        const type = String(t.type || "").toLowerCase();
        if (tag === "input" && ["checkbox","radio","button","submit","reset","file","range","color","hidden"].includes(type))
          return { skip: false, field: false, editable: false };
        return {
          skip: false,
          field: true,
          editable: !t.disabled && !t.readOnly,
        };
      })()
    `;
    void mainWindow.webContents
      .executeJavaScript(probe, true)
      .catch(() => null)
      .then((info) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (info && info.skip) return;
        const type = String(params.formControlType || params.inputFieldType || "").toLowerCase();
        const typeLooksField =
          type.includes("textarea") ||
          type.startsWith("input") ||
          type === "plain" ||
          type === "password" ||
          type === "other";
        const isField =
          Boolean(info && info.field) ||
          Boolean(params.isEditable) ||
          typeLooksField;
        const editable =
          Boolean(info && info.editable) ||
          (Boolean(params.isEditable) && type !== "none");
        const hasText = Boolean((params.selectionText || "").trim());
        if (!isField && !hasText) return;

        const flags = params.editFlags || {};
        /** @type {import('electron').MenuItemConstructorOptions[]} */
        const items = isField
          ? [
              ...(editable
                ? [
                    { label: "撤销", role: "undo", enabled: Boolean(flags.canUndo) },
                    { label: "重做", role: "redo", enabled: Boolean(flags.canRedo) },
                    { type: "separator" },
                    { label: "剪切", role: "cut", enabled: Boolean(flags.canCut) },
                  ]
                : []),
              {
                label: "复制",
                role: "copy",
                enabled: Boolean(flags.canCopy) || hasText || isField,
              },
              ...(editable
                ? [
                    { label: "粘贴", role: "paste", enabled: Boolean(flags.canPaste) },
                    { label: "删除", role: "delete", enabled: Boolean(flags.canDelete) },
                  ]
                : []),
              { type: "separator" },
              {
                label: "全选",
                role: "selectAll",
                enabled: flags.canSelectAll !== false,
              },
            ]
          : [
              {
                label: "复制",
                role: "copy",
                enabled: Boolean(flags.canCopy) || hasText,
              },
            ];
        Menu.buildFromTemplate(items).popup({ window: mainWindow });
      });
  });

  const loadMainContent = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (DEV_SERVER) {
      mainWindow.loadURL(DEV_SERVER);
    } else {
      mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }
  };

  let crashTimes = [];
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    appendLauncherLog(
      `[renderer] render-process-gone reason=${details?.reason || "unknown"} exitCode=${details?.exitCode ?? "?"}`,
    );
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 30_000);
    crashTimes.push(now);
    if (crashTimes.length <= 3) {
      setTimeout(loadMainContent, 300);
    }
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_e, errorCode, errorDesc, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      appendLauncherLog(`[renderer] did-fail-load (${errorCode}): ${errorDesc}`);
      setTimeout(loadMainContent, 800);
    },
  );

  loadMainContent();
}

if (gotSingleLock) app.whenReady().then(async () => {
  try {
    const s = readElectronSettings();
    const customApi = String(s.apiUrl || "").trim();
    if (customApi) {
      API_URL = customApi.replace(/\/+$/, "");
    }
  } catch {
    /* ignore */
  }
  process.env.TOOLBOX_API_URL = API_URL;
  process.env.TOOLBOX_API_TOKEN = API_TOKEN;
  // 先起窗口再等 API，避免启动白屏空等（sidecar 冷启动可达十余秒）
  const apiBoot = startManagedApi();

  ipcMain.handle("toolbox:restart-api", async () => {
    try {
      await startManagedApi({ silent: true });
      await fetchAuthorizedVersion(API_URL, API_TOKEN);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err?.message || err || "重启失败") };
    }
  });

  const dragIcon = path.join(__dirname, "drag.png");
  ipcMain.on("toolbox:drag-start", (event, filePath) => {
    try {
      const p = String(filePath || "");
      if (!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return;
      event.sender.startDrag({
        file: p,
        icon: fs.existsSync(dragIcon)
          ? dragIcon
          : fs.existsSync(path.join(__dirname, "icon.png"))
            ? path.join(__dirname, "icon.png")
            : require("electron").nativeImage.createEmpty(),
      });
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle("toolbox:choose-directory", async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const fallback = path.join(toolboxDataDir(), "output", "adb_pulls");
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      /* ignore */
    }
    let defaultPath =
      (opts && opts.defaultPath && String(opts.defaultPath)) || fallback;
    try {
      if (!fs.existsSync(defaultPath)) defaultPath = fallback;
    } catch {
      defaultPath = fallback;
    }
    const result = await dialog.showOpenDialog(win || undefined, {
      title: (opts && opts.title) || "选择文件夹",
      defaultPath,
      buttonLabel: "选择此文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) return "";
    return result.filePaths[0];
  });

  ipcMain.handle("toolbox:choose-file", async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const defaultPath =
      (opts && opts.defaultPath && String(opts.defaultPath)) ||
      app.getPath("desktop");
    const filters = Array.isArray(opts?.filters) ? opts.filters : undefined;
    const result = await dialog.showOpenDialog(win || undefined, {
      title: (opts && opts.title) || "选择文件",
      defaultPath,
      properties: ["openFile"],
      filters,
    });
    if (result.canceled || !result.filePaths?.[0]) return "";
    return result.filePaths[0];
  });

  ipcMain.handle("toolbox:read-file-base64", async (_event, rawPath) => {
    const input = String(rawPath || "").trim();
    if (!input) return { ok: false, message: "路径为空" };
    try {
      if (!fs.existsSync(input) || !fs.statSync(input).isFile()) {
        return { ok: false, message: `文件不存在: ${input}` };
      }
      const st = fs.statSync(input);
      if (st.size > 80 * 1024 * 1024) {
        return { ok: false, message: "文件过大（>80MB），请缩小后再打开" };
      }
      const buf = fs.readFileSync(input);
      return {
        ok: true,
        path: input,
        name: path.basename(input),
        bytes: buf.length,
        dataBase64: buf.toString("base64"),
      };
    } catch (err) {
      return {
        ok: false,
        message: String(err?.message || err || "读取失败"),
      };
    }
  });

  ipcMain.handle("toolbox:save-file-base64", async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dataBase64 = String(opts?.dataBase64 || "");
    if (!dataBase64) {
      return { ok: false, canceled: false, message: "无文件内容" };
    }
    let dest = String(opts?.defaultPath || "").trim();
    const forceDialog = Boolean(opts?.forceDialog) || !dest;
    if (forceDialog) {
      const filters = Array.isArray(opts?.filters)
        ? opts.filters
        : [{ name: "All Files", extensions: ["*"] }];
      const result = await dialog.showSaveDialog(win || undefined, {
        title: (opts && opts.title) || "保存文件",
        defaultPath: dest || path.join(app.getPath("documents"), "file.bin"),
        filters,
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true, message: "已取消" };
      }
      dest = result.filePath;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(dataBase64, "base64"));
      return { ok: true, canceled: false, path: dest, message: `已保存 ${dest}` };
    } catch (err) {
      return {
        ok: false,
        canceled: false,
        message: String(err?.message || err || "保存失败"),
      };
    }
  });

  ipcMain.handle("toolbox:open-path", async (event, rawPath) => {
    const input = String(rawPath || "").trim();
    if (!input) return { ok: false, path: "", message: "路径为空" };
    let target = input;
    try {
      if (!fs.existsSync(target)) {
        const parent = path.dirname(target);
        if (parent && fs.existsSync(parent)) target = parent;
        else return { ok: false, path: input, message: `路径不存在: ${input}` };
      }
      target = fs.realpathSync.native
        ? fs.realpathSync.native(target)
        : fs.realpathSync(target);
    } catch (err) {
      return {
        ok: false,
        path: input,
        message: String(err?.message || err || "路径无效"),
      };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const st = fs.statSync(target);
      if (st.isFile()) {
        shell.showItemInFolder(target);
      } else {
        const errMsg = await shell.openPath(target);
        if (errMsg) {
          return { ok: false, path: target, message: errMsg };
        }
      }
      // frameless 窗口常压住新开的资源管理器，主动让出焦点
      if (win && !win.isDestroyed()) {
        try {
          win.blur();
        } catch {
          /* ignore */
        }
      }
      return { ok: true, path: target, message: `已打开 ${target}` };
    } catch (err) {
      return {
        ok: false,
        path: target,
        message: String(err?.message || err || "打开失败"),
      };
    }
  });

  ipcMain.handle("toolbox:default-pull-dir", async () => {
    const dir = path.join(toolboxDataDir(), "output", "adb_pulls");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    return dir;
  });

  ipcMain.handle("toolbox:default-gota-dir", async () => {
    const dir = path.join(toolboxDataDir(), "output", "gota");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    return dir;
  });

  ipcMain.handle("toolbox:hide-to-tray", async () => {
    hideToTray();
    return true;
  });

  ipcMain.on("toolbox:activity", (_event, payload = {}) => {
    setBackgroundActivity(
      payload.id,
      Boolean(payload.active),
      payload.label || "",
    );
  });

  ipcMain.handle("toolbox:check-for-updates", async () => {
    return checkForUpdates({ manual: true });
  });

  ipcMain.handle("toolbox:get-app-version", async () => app.getVersion());

  ipcMain.handle("toolbox:window-controls", async () => ({
    customTitlebar: process.platform !== "darwin",
    platform: process.platform,
  }));

  ipcMain.handle("toolbox:window-minimize", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });

  ipcMain.handle("toolbox:window-toggle-maximize", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle("toolbox:window-close", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  ipcMain.handle("toolbox:window-is-maximized", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win.isMaximized());
  });

  ipcMain.handle("toolbox:window-is-always-on-top", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop());
  });

  ipcMain.handle("toolbox:window-toggle-always-on-top", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    const next = !win.isAlwaysOnTop();
    applyAlwaysOnTop(win, next);
    try {
      writeElectronSettings({ alwaysOnTop: next });
    } catch {
      /* ignore */
    }
    return win.isAlwaysOnTop();
  });

  ipcMain.handle("toolbox:get-app-settings", async () => {
    const s = readElectronSettings();
    return {
      closeAction: s.closeAction === "tray" || s.closeAction === "quit" ? s.closeAction : "ask",
      minimizeToTray: Boolean(s.minimizeToTray),
      alwaysOnTop: Boolean(s.alwaysOnTop),
      rememberWindowBounds:
        typeof s.rememberWindowBounds === "boolean" ? s.rememberWindowBounds : true,
      apiUrl: String(s.apiUrl || ""),
      updateUrl: String(s.updateUrl || readUpdateFeedRaw() || ""),
    };
  });

  ipcMain.handle("toolbox:set-app-settings", async (event, patch) => {
    const p = patch && typeof patch === "object" ? patch : {};
    /** @type {Record<string, any>} */
    const write = {};
    if (p.closeAction === "tray" || p.closeAction === "quit" || p.closeAction === "ask") {
      write.closeAction = p.closeAction;
    }
    if (typeof p.minimizeToTray === "boolean") write.minimizeToTray = p.minimizeToTray;
    if (typeof p.alwaysOnTop === "boolean") write.alwaysOnTop = p.alwaysOnTop;
    if (typeof p.rememberWindowBounds === "boolean") {
      write.rememberWindowBounds = p.rememberWindowBounds;
    }
    if (typeof p.apiUrl === "string") write.apiUrl = p.apiUrl.trim();
    if (typeof p.updateUrl === "string") write.updateUrl = p.updateUrl.trim();
    const next = writeElectronSettings(write);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && typeof p.alwaysOnTop === "boolean") {
      applyAlwaysOnTop(win, Boolean(p.alwaysOnTop));
    }
    if (win && !win.isDestroyed() && p.rememberWindowBounds === true) {
      saveWindowBounds(win);
    }
    return {
      closeAction:
        next.closeAction === "tray" || next.closeAction === "quit"
          ? next.closeAction
          : "ask",
      minimizeToTray: Boolean(next.minimizeToTray),
      alwaysOnTop: Boolean(next.alwaysOnTop),
      rememberWindowBounds:
        typeof next.rememberWindowBounds === "boolean"
          ? next.rememberWindowBounds
          : true,
      apiUrl: String(next.apiUrl || ""),
      updateUrl: String(next.updateUrl || ""),
    };
  });

  ipcMain.handle("toolbox:clipboard-write", async (_event, text) => {
    try {
      clipboard.writeText(String(text ?? ""));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("toolbox:clipboard-read", async () => {
    try {
      return clipboard.readText() || "";
    } catch {
      return "";
    }
  });

  ipcMain.handle("toolbox:tide-oa-login", async () => {
    const { session } = require("electron");
    const oaSes = session.fromPartition("persist:tide-oa");
    return await new Promise((resolve) => {
      let settled = false;
      let captured = null;
      const loginWin = new BrowserWindow({
        width: 580,
        height: 760,
        parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
        modal: false,
        title: "登录 Tide OA（飞书扫码后自动完成）",
        autoHideMenuBar: true,
        icon: path.join(__dirname, "icon.ico"),
        webPreferences: {
          partition: "persist:tide-oa",
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        try {
          oaSes.webRequest.onBeforeSendHeaders(null);
        } catch {
          /* ignore */
        }
        try {
          if (!loginWin.isDestroyed()) loginWin.close();
        } catch {
          /* ignore */
        }
        resolve(payload);
      };

      oaSes.webRequest.onBeforeSendHeaders(
        { urls: ["https://cloud.seirobotics.net/*"] },
        (details, callback) => {
          try {
            const headers = details.requestHeaders || {};
            let tok = "";
            let wsid = "";
            for (const [k, v] of Object.entries(headers)) {
              const lk = k.toLowerCase();
              if (lk === "token" && typeof v === "string") tok = v.trim();
              if (lk === "wsid" && typeof v === "string") wsid = v.trim();
            }
            if (
              tok &&
              tok.length >= 16 &&
              tok.toLowerCase() !== "null" &&
              tok.toLowerCase() !== "undefined" &&
              !captured
            ) {
              captured = { ok: true, token: tok, wsid: wsid || "2" };
              setTimeout(() => finish(captured), 150);
            }
          } catch {
            /* ignore */
          }
          callback({ requestHeaders: details.requestHeaders });
        },
      );

      loginWin.on("closed", () => {
        if (!settled) {
          finish(
            captured || {
              ok: false,
              cancelled: true,
              message: "已取消 Tide OA 登录",
            },
          );
        }
      });

      loginWin.loadURL("https://cloud.seirobotics.net");
    });
  });

  createTray();
  createWindow();
  void apiBoot;

  // 刚装完立刻查更新会和 sidecar 冷启动抢磁盘，容易把电脑卡住
  function recentlyInstalled() {
    try {
      return Date.now() - fs.statSync(process.execPath).mtimeMs < 15 * 60 * 1000;
    } catch {
      return false;
    }
  }

  // 等页面加载完成再检查，确保更新弹窗能显示
  if (app.isPackaged && mainWindow && !mainWindow.isDestroyed() && !recentlyInstalled()) {
    const scheduleUpdateCheck = () => {
      setTimeout(() => {
        void checkForUpdates({ manual: false });
      }, 2500);
    };
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", scheduleUpdateCheck);
    } else {
      scheduleUpdateCheck();
    }
  }

  app.on("activate", () => {
    showMainWindow();
  });
});

if (gotSingleLock) {
  app.on("window-all-closed", () => {
    // 托盘常驻：窗口关闭不退出，仅托盘「退出」时 quitting=true
    if (!quitting) return;
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    managedApi = false;
    if (apiProc && !apiProc.killed) {
      try {
        apiProc.kill();
      } catch {
        /* ignore */
      }
      apiProc = null;
    }
    if (tray) {
      try {
        stopTrayBlink();
        tray.destroy();
      } catch {
        /* ignore */
      }
      tray = null;
    }
  });
}
