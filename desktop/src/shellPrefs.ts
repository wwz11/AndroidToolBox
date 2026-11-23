/** Shell / 串口终端显示偏好（localStorage 持久化）。 */

export const SHELL_PREFS_KEY = "toolbox.shell.prefs.v1";
export const SHELL_PREFS_EVENT = "toolbox-shell-prefs-change";

export type ShellFontId = "consolas" | "cascadia" | "courier" | "mono";

export type ShellPrefs = {
  fontSize: number;
  lineHeight: number;
  fontId: ShellFontId;
  cursorBlink: boolean;
};

export const SHELL_FONT_OPTIONS: {
  id: ShellFontId;
  label: string;
  css: string;
}[] = [
  {
    id: "consolas",
    label: "Consolas",
    css: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  },
  {
    id: "cascadia",
    label: "Cascadia Mono",
    css: '"Cascadia Mono", Consolas, "Courier New", monospace',
  },
  {
    id: "courier",
    label: "Courier New",
    css: '"Courier New", Consolas, monospace',
  },
  {
    id: "mono",
    label: "系统等宽",
    css: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
];

export const DEFAULT_SHELL_PREFS: ShellPrefs = {
  fontSize: 13,
  lineHeight: 1.25,
  fontId: "consolas",
  cursorBlink: true,
};

const FONT_IDS = new Set<ShellFontId>(SHELL_FONT_OPTIONS.map((f) => f.id));

type PrefsListener = (prefs: ShellPrefs) => void;
const prefsListeners = new Set<PrefsListener>();

export function subscribeShellPrefs(listener: PrefsListener): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SHELL_PREFS.fontSize;
  return Math.min(22, Math.max(10, Math.round(n)));
}

export function clampLineHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SHELL_PREFS.lineHeight;
  return Math.min(1.8, Math.max(1.0, Math.round(n * 20) / 20));
}

export function shellFontCss(id: ShellFontId): string {
  return (
    SHELL_FONT_OPTIONS.find((f) => f.id === id)?.css ||
    SHELL_FONT_OPTIONS[0].css
  );
}

export function normalizeShellPrefs(raw: Partial<ShellPrefs> | null | undefined): ShellPrefs {
  const fontId = FONT_IDS.has(raw?.fontId as ShellFontId)
    ? (raw!.fontId as ShellFontId)
    : DEFAULT_SHELL_PREFS.fontId;
  return {
    fontSize: clampFontSize(Number(raw?.fontSize)),
    lineHeight: clampLineHeight(Number(raw?.lineHeight)),
    fontId,
    cursorBlink:
      typeof raw?.cursorBlink === "boolean"
        ? raw.cursorBlink
        : DEFAULT_SHELL_PREFS.cursorBlink,
  };
}

export function readShellPrefs(): ShellPrefs {
  try {
    const raw = localStorage.getItem(SHELL_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SHELL_PREFS };
    return normalizeShellPrefs(JSON.parse(raw) as Partial<ShellPrefs>);
  } catch {
    return { ...DEFAULT_SHELL_PREFS };
  }
}

function notifyShellPrefs(prefs: ShellPrefs) {
  for (const fn of [...prefsListeners]) {
    try {
      fn(prefs);
    } catch {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(
      new CustomEvent(SHELL_PREFS_EVENT, { detail: prefs }),
    );
  } catch {
    /* ignore */
  }
}

export function writeShellPrefs(next: ShellPrefs): ShellPrefs {
  const prefs = normalizeShellPrefs(next);
  try {
    localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  notifyShellPrefs(prefs);
  return prefs;
}

export function patchShellPrefs(patch: Partial<ShellPrefs>): ShellPrefs {
  return writeShellPrefs({ ...readShellPrefs(), ...patch });
}
