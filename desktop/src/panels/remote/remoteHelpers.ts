export type Action = {
  label: string;
  kind: string;
  keycode: number;
  hint: string;
  confirm: string;
};

export type LoginAccount = {
  id: string;
  label: string;
  username: string;
  password: string;
  next: string;
};

export const EMPTY_ACCOUNT_DRAFT = (): LoginAccount => ({
  id: "",
  label: "",
  username: "",
  password: "",
  next: "down",
});

export const NEXT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "down", label: "下键" },
  { value: "tab", label: "Tab" },
  { value: "enter", label: "Enter" },
  { value: "none", label: "无" },
];

export const KEY_MAP: Record<string, number> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Escape: 4,
  Home: 3,
  " ": 62,
  Tab: 61,
  PageUp: 92,
  PageDown: 93,
};

/** 录屏断线后等待重连（默认 5 分钟） */
export const RECONNECT_TIMEOUT_SEC = 300; // fallback; runtime uses appPrefs.scrcpyReconnectSec

/** 可打印字符（字母/数字/标点）走 adb input text */
export function isInjectableChar(key: string): boolean {
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  // 空格已走 KEYCODE_SPACE；其余可见 ASCII / 常见可打印字符
  return code > 32 && code !== 127;
}

export function formatRemain(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export const DPAD_LAYOUT: Array<Array<string | null>> = [
  ["主页", "返回", "设置"],
  [null, "上", null],
  ["左", "确定", "右"],
  [null, "下", "Enter"],
];

/** 方向盘展示字形（title 仍用中文标签） */
export const DPAD_GLYPH: Record<string, string> = {
  上: "▲",
  下: "▼",
  左: "◀",
  右: "▶",
  确定: "OK",
};

const NAMED_KEYCODES: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89,
  MEDIA_FAST_FORWARD: 90,
  MUTE: 164,
  SETTINGS: 176,
  TV_INPUT: 178,
  PROG_RED: 183,
  PROG_GREEN: 184,
  PROG_YELLOW: 185,
  PROG_BLUE: 186,
  APP_SWITCH: 187,
  ASSIST: 219,
  SLEEP: 223,
  WAKEUP: 224,
  VOICE_ASSIST: 231,
  PASTE: 279,
};

export function parseKeycodeInput(raw: string): number | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
  }
  const key = s.startsWith("KEYCODE_") ? s.slice("KEYCODE_".length) : s;
  return NAMED_KEYCODES[key] ?? null;
}

export type KeyMacro = {
  id: string;
  label: string;
  sequence: string;
};

export const DEFAULT_MACROS: KeyMacro[] = [
  { id: "recent", label: "多任务", sequence: "187" },
  { id: "dev_down", label: "连下3次", sequence: "20*3" },
  { id: "back_home", label: "退回桌面", sequence: "4,4,3" },
];

export function parseMacroSequence(seq: string): number[] {
  const out: number[] = [];
  for (const part of seq.split(/[\s,，;]+/).filter(Boolean)) {
    const m = part.match(/^(.+?)\*(\d+)$/);
    if (m) {
      const code = parseKeycodeInput(m[1]);
      const count = Math.min(20, Math.max(1, Number(m[2]) || 1));
      if (code != null) {
        for (let i = 0; i < count; i++) out.push(code);
      }
      continue;
    }
    const code = parseKeycodeInput(part);
    if (code != null) out.push(code);
  }
  return out;
}

const MACRO_STORAGE_KEY = "toolbox.remote.macros.v1";

export function loadMacros(): KeyMacro[] {
  try {
    const raw = localStorage.getItem(MACRO_STORAGE_KEY);
    if (!raw) return DEFAULT_MACROS;
    const arr = JSON.parse(raw) as KeyMacro[];
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_MACROS;
  } catch {
    return DEFAULT_MACROS;
  }
}

export function saveMacros(macros: KeyMacro[]): void {
  try {
    localStorage.setItem(MACRO_STORAGE_KEY, JSON.stringify(macros));
  } catch {
    /* ignore */
  }
}

export type Shot = {
  mime: string;
  b64: string;
  width?: number;
  height?: number;
};

export function parseDataUrl(url: string): Shot | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

export function shotExt(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "png";
}

export function shotFileName(device: string, mime: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `screenshot_${device}_${ts}.${shotExt(mime)}`;
}
