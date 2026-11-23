import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  APP_PREFS_EVENT,
  type AppPrefs,
  readAppPrefs,
  subscribeAppPrefs,
} from "../appPrefs";
import {
  SHELL_PREFS_EVENT,
  type ShellPrefs,
  readShellPrefs,
  shellFontCss,
  subscribeShellPrefs,
} from "../shellPrefs";

function applyPrefsToTerminal(
  term: Terminal,
  prefs: ShellPrefs,
  fit?: FitAddon | null,
) {
  try {
    term.options.fontSize = prefs.fontSize;
    term.options.lineHeight = prefs.lineHeight;
    term.options.fontFamily = shellFontCss(prefs.fontId);
    term.options.cursorBlink = prefs.cursorBlink;
  } catch {
    /* ignore */
  }
  try {
    term.clearTextureAtlas?.();
  } catch {
    /* ignore */
  }
  try {
    if (term.rows > 0) term.refresh(0, term.rows - 1);
  } catch {
    /* ignore */
  }
  const runFit = () => {
    try {
      fit?.fit();
    } catch {
      /* ignore */
    }
  };
  runFit();
  requestAnimationFrame(runFit);
}

export type ShellSearchHit = {
  index: number;
  count: number;
};

export type ShellTerminalHandle = {
  write: (text: string) => void;
  clear: () => void;
  focus: () => void;
  reset: () => void;
  fit: () => void;
  getText: () => string;
  getSelection: () => string;
  findNext: (query: string, opts?: { caseSensitive?: boolean }) => ShellSearchHit;
  findPrevious: (query: string, opts?: { caseSensitive?: boolean }) => ShellSearchHit;
  clearSearch: () => void;
  scrollToBottom: () => void;
  setFollow: (on: boolean) => void;
  getFollow: () => boolean;
};

type HistoryErase = "ctrlu" | "backspace";

type Props = {
  onData: (data: string) => void;
  disabled?: boolean;
  /**
   * Enter 键发出的字节。ADB 默认 "\\n"；串口可设为 "\\r" / "\\n" / "\\r\\n"。
   * 其它按键与粘贴原样转发，不整段改写换行。
   */
  enterPayload?: string;
  /** 上下键切换本地已发送行历史（默认开启） */
  localHistory?: boolean;
  /** 切换历史时如何清掉当前输入行 */
  historyErase?: HistoryErase;
  /** Ctrl+F：打开查找 */
  onFindShortcut?: () => void;
  /** Ctrl+S：保存输出 */
  onSaveShortcut?: () => void;
  /** 右键：清屏 */
  onClearShortcut?: () => void;
  /** 右键：重连 */
  onReconnectShortcut?: () => void;
  /** 贴底跟随；上翻后自动停随 */
  follow?: boolean;
  onFollowChange?: (follow: boolean) => void;
};

const HISTORY_MAX = 200;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function readXtermTheme() {
  const bg = cssVar("--term-bg", "#ffffff");
  const fg = cssVar("--term-fg", "#1a1d24");
  const cursor = cssVar("--term-cursor", "#0f766e");
  const muted = cssVar("--term-muted", "#6b7280");
  const info = cssVar("--info", "#2563eb");
  const danger = cssVar("--danger", "#dc2626");
  const warn = cssVar("--warn", "#d97706");
  return {
    background: bg,
    foreground: fg,
    cursor,
    selectionBackground: cssVar("--term-selection", "rgba(15, 118, 110, 0.28)"),
    black: "#1a1d24",
    brightBlack: muted,
    green: cssVar("--success", cursor),
    brightGreen: cursor,
    blue: info,
    brightBlue: info,
    cyan: info,
    yellow: warn,
    red: danger,
  };
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    const bridge = window.toolbox?.clipboardWriteText;
    if (bridge) {
      const ok = await bridge(text);
      if (ok) return true;
    }
  } catch {
    /* fall through */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return fallbackCopy(text);
  }
}

async function readClipboard(): Promise<string> {
  try {
    const bridge = window.toolbox?.clipboardReadText;
    if (bridge) {
      const t = await bridge();
      if (typeof t === "string" && t) return t;
    }
  } catch {
    /* fall through */
  }
  try {
    return (await navigator.clipboard.readText()) || "";
  } catch {
    return "";
  }
}

function closeCtxMenu(menu: HTMLDivElement | null) {
  if (!menu) return;
  menu.remove();
}

function bufferLineText(term: Terminal, row: number): string {
  return term.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

function serializeBuffer(term: Terminal): string {
  const buf = term.buffer.active;
  const parts: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const wrapped = i + 1 < buf.length && Boolean(buf.getLine(i + 1)?.isWrapped);
    parts.push(line.translateToString(!wrapped));
    if (!wrapped) parts.push("\n");
  }
  return parts.join("").replace(/\s+$/, "") + (parts.length ? "\n" : "");
}

type BufferHit = { row: number; col: number; len: number };

function collectHits(term: Terminal, query: string, caseSensitive: boolean): BufferHit[] {
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return [];
  const hits: BufferHit[] = [];
  const buf = term.buffer.active;
  for (let row = 0; row < buf.length; row++) {
    const raw = bufferLineText(term, row);
    if (!raw) continue;
    const hay = caseSensitive ? raw : raw.toLowerCase();
    let from = 0;
    while (from <= hay.length - needle.length) {
      const col = hay.indexOf(needle, from);
      if (col < 0) break;
      hits.push({ row, col, len: query.length });
      from = col + Math.max(1, needle.length);
    }
  }
  return hits;
}

function showHit(term: Terminal, hit: BufferHit) {
  try {
    term.select(hit.col, hit.row, hit.len);
    term.scrollToLine(Math.max(0, hit.row - 2));
  } catch {
    /* ignore */
  }
}

function emptyHit(): ShellSearchHit {
  return { index: -1, count: 0 };
}

function hitFromList(
  term: Terminal,
  hits: BufferHit[],
  backwards: boolean,
): ShellSearchHit {
  if (!hits.length) {
    try {
      term.clearSelection();
    } catch {
      /* ignore */
    }
    return emptyHit();
  }
  const sel = term.getSelectionPosition();
  let idx = 0;
  if (sel) {
    if (backwards) {
      idx = -1;
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (h.row < sel.start.y || (h.row === sel.start.y && h.col < sel.start.x)) {
          idx = i;
          break;
        }
      }
      if (idx < 0) idx = hits.length - 1;
    } else {
      idx = hits.findIndex(
        (h) => h.row > sel.start.y || (h.row === sel.start.y && h.col > sel.start.x),
      );
      if (idx < 0) idx = 0;
    }
  } else if (backwards) {
    idx = hits.length - 1;
  }
  showHit(term, hits[idx]);
  return { index: idx, count: hits.length };
}

const ShellTerminal = forwardRef<ShellTerminalHandle, Props>(function ShellTerminal(
  {
    onData,
    disabled = false,
    enterPayload = "\n",
    localHistory = true,
    historyErase = "ctrlu",
    onFindShortcut,
    onSaveShortcut,
    onClearShortcut,
    onReconnectShortcut,
    follow = true,
    onFollowChange,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const disabledRef = useRef(disabled);
  const enterPayloadRef = useRef(enterPayload);
  const localHistoryRef = useRef(localHistory);
  const historyEraseRef = useRef(historyErase);
  const onFindShortcutRef = useRef(onFindShortcut);
  const onSaveShortcutRef = useRef(onSaveShortcut);
  const onClearShortcutRef = useRef(onClearShortcut);
  const onReconnectShortcutRef = useRef(onReconnectShortcut);
  const followRef = useRef(follow);
  const onFollowChangeRef = useRef(onFollowChange);
  const ignoreScrollRef = useRef(false);
  const pinnedViewportYRef = useRef(0);
  onDataRef.current = onData;
  disabledRef.current = disabled;
  enterPayloadRef.current = enterPayload;
  localHistoryRef.current = localHistory;
  historyEraseRef.current = historyErase;
  onFindShortcutRef.current = onFindShortcut;
  onSaveShortcutRef.current = onSaveShortcut;
  onClearShortcutRef.current = onClearShortcut;
  onReconnectShortcutRef.current = onReconnectShortcut;
  followRef.current = follow;
  onFollowChangeRef.current = onFollowChange;

  function applyFollow(on: boolean) {
    if (followRef.current === on) return;
    followRef.current = on;
    onFollowChangeRef.current?.(on);
  }

  function pinViewport() {
    const term = termRef.current;
    if (!term) return;
    try {
      pinnedViewportYRef.current = term.buffer.active.viewportY;
    } catch {
      /* ignore */
    }
  }

  function restorePinnedViewport() {
    const term = termRef.current;
    if (!term) return;
    try {
      const maxY = term.buffer.active.baseY;
      const y = Math.max(0, Math.min(pinnedViewportYRef.current, maxY));
      ignoreScrollRef.current = true;
      term.scrollToLine(y);
      queueMicrotask(() => {
        ignoreScrollRef.current = false;
      });
    } catch {
      ignoreScrollRef.current = false;
    }
  }

  useImperativeHandle(ref, () => ({
    write(text: string) {
      const term = termRef.current;
      if (!term || !text) return;
      const stick = followRef.current;
      if (!stick) pinViewport();
      term.write(text, () => {
        try {
          if (stick) {
            ignoreScrollRef.current = true;
            term.scrollToBottom();
            queueMicrotask(() => {
              ignoreScrollRef.current = false;
            });
          } else {
            // 停随：锁住绝对视口，禁止相对底部补偿（否则新行会把画面往下拽）
            restorePinnedViewport();
          }
        } catch {
          ignoreScrollRef.current = false;
        }
      });
    },
    clear() {
      termRef.current?.clear();
    },
    focus() {
      termRef.current?.focus();
    },
    reset() {
      termRef.current?.reset();
    },
    fit() {
      const term = termRef.current;
      const addon = fitRef.current;
      if (!term || !addon) return;
      // 切回标签 / 显示时重新套用设置（display:none 期间改字号可能量不到）
      applyPrefsToTerminal(term, readShellPrefs(), addon);
      const stick = followRef.current;
      if (!stick) pinViewport();
      try {
        if (stick) {
          ignoreScrollRef.current = true;
          term.scrollToBottom();
          queueMicrotask(() => {
            ignoreScrollRef.current = false;
          });
        } else {
          restorePinnedViewport();
        }
      } catch {
        ignoreScrollRef.current = false;
      }
    },
    getText() {
      const term = termRef.current;
      return term ? serializeBuffer(term) : "";
    },
    getSelection() {
      return termRef.current?.getSelection() || "";
    },
    findNext(query, opts) {
      const term = termRef.current;
      const q = query.trim();
      if (!term || !q) return emptyHit();
      return hitFromList(term, collectHits(term, q, Boolean(opts?.caseSensitive)), false);
    },
    findPrevious(query, opts) {
      const term = termRef.current;
      const q = query.trim();
      if (!term || !q) return emptyHit();
      return hitFromList(term, collectHits(term, q, Boolean(opts?.caseSensitive)), true);
    },
    clearSearch() {
      try {
        termRef.current?.clearSelection();
      } catch {
        /* ignore */
      }
    },
    scrollToBottom() {
      try {
        ignoreScrollRef.current = true;
        termRef.current?.scrollToBottom();
        queueMicrotask(() => {
          ignoreScrollRef.current = false;
        });
      } catch {
        ignoreScrollRef.current = false;
      }
      applyFollow(true);
    },
    setFollow(on: boolean) {
      if (!on) pinViewport();
      applyFollow(on);
      if (on) {
        try {
          ignoreScrollRef.current = true;
          termRef.current?.scrollToBottom();
          queueMicrotask(() => {
            ignoreScrollRef.current = false;
          });
        } catch {
          ignoreScrollRef.current = false;
        }
      }
    },
    getFollow() {
      return followRef.current;
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const initPrefs = readShellPrefs();
    const initApp = readAppPrefs();
    const term = new Terminal({
      cursorBlink: initPrefs.cursorBlink,
      cursorStyle: "block",
      fontFamily: shellFontCss(initPrefs.fontId),
      fontSize: initPrefs.fontSize,
      lineHeight: initPrefs.lineHeight,
      scrollback: initApp.shellScrollback,
      disableStdin: false,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      term.focus();
    });
    termRef.current = term;
    fitRef.current = fit;

    const history: string[] = [];
    let histIdx = -1;
    let draft = "";
    let lineBuf = "";
    let ctxMenu: HTMLDivElement | null = null;
    let pasteGuardUntil = 0;

    function emit(data: string) {
      if (!data) return;
      onDataRef.current(data);
    }

    function pushHistory(line: string) {
      const text = line.replace(/\s+$/g, "");
      if (!text) return;
      if (history.length && history[history.length - 1] === text) return;
      history.push(text);
      if (history.length > HISTORY_MAX) history.shift();
    }

    function eraseCurrentLine() {
      if (!lineBuf) return;
      if (historyEraseRef.current === "backspace") {
        emit("\x7f".repeat(lineBuf.length));
      } else {
        emit("\x15"); // Ctrl+U
      }
      lineBuf = "";
    }

    function showHistoryLine(text: string) {
      eraseCurrentLine();
      lineBuf = text;
      if (text) emit(text);
    }

    function historyUp() {
      if (!history.length) return false;
      if (histIdx === -1) {
        draft = lineBuf;
        histIdx = history.length - 1;
      } else if (histIdx > 0) {
        histIdx -= 1;
      }
      showHistoryLine(history[histIdx] || "");
      return true;
    }

    function historyDown() {
      if (!history.length || histIdx === -1) return false;
      if (histIdx < history.length - 1) {
        histIdx += 1;
        showHistoryLine(history[histIdx] || "");
      } else {
        histIdx = -1;
        showHistoryLine(draft);
      }
      return true;
    }

    function noteIncoming(data: string) {
      if (data === "\x7f" || data === "\b") {
        lineBuf = lineBuf.slice(0, -1);
        return;
      }
      if (data === "\x15" || data === "\x03" || data === "\x04") {
        lineBuf = "";
        histIdx = -1;
        draft = "";
        return;
      }
      if (data.startsWith("\x1b")) {
        return;
      }
      if (data.length === 1) {
        if (data >= " ") lineBuf += data;
        return;
      }
      if (/[\r\n]/.test(data)) {
        lineBuf = "";
        histIdx = -1;
        draft = "";
      } else {
        lineBuf += data;
      }
    }

    function pasteText(text: string) {
      if (!text || disabledRef.current) return;
      // 防抖：Ctrl+V 自定义处理与 xterm 原生 paste 可能连发两次
      const now = performance.now();
      if (now < pasteGuardUntil) return;
      pasteGuardUntil = now + 100;
      if (localHistoryRef.current) noteIncoming(text);
      emit(text);
    }

    async function copySelection(): Promise<boolean> {
      const sel = term.getSelection();
      if (!sel) return false;
      return writeClipboard(sel);
    }

    async function pasteFromClipboard() {
      const text = await readClipboard();
      pasteText(text);
    }

    function dismissCtxMenu() {
      closeCtxMenu(ctxMenu);
      ctxMenu = null;
    }

    function showCtxMenu(clientX: number, clientY: number) {
      dismissCtxMenu();
      const hasSel = term.hasSelection() && Boolean(term.getSelection());
      const menu = document.createElement("div");
      menu.className = "shell-ctx-menu";
      menu.setAttribute("role", "menu");

      const mkBtn = (label: string, enabled: boolean, action: () => void) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shell-ctx-item";
        btn.textContent = label;
        btn.disabled = !enabled;
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dismissCtxMenu();
          action();
          term.focus();
        });
        menu.appendChild(btn);
      };

      mkBtn("复制", hasSel && !disabledRef.current, () => {
        void copySelection();
      });
      mkBtn("粘贴", !disabledRef.current, () => {
        void pasteFromClipboard();
      });
      const sep = document.createElement("div");
      sep.className = "shell-ctx-sep";
      menu.appendChild(sep);
      mkBtn("全选", true, () => {
        term.selectAll();
      });
      if (onFindShortcutRef.current) {
        mkBtn("查找", true, () => {
          onFindShortcutRef.current?.();
        });
      }
      if (onSaveShortcutRef.current) {
        mkBtn("保存", true, () => {
          onSaveShortcutRef.current?.();
        });
      }
      if (onClearShortcutRef.current) {
        mkBtn("清屏", true, () => {
          onClearShortcutRef.current?.();
        });
      }
      if (onReconnectShortcutRef.current) {
        mkBtn("重连", !disabledRef.current, () => {
          onReconnectShortcutRef.current?.();
        });
      }

      document.body.appendChild(menu);
      ctxMenu = menu;

      const pad = 6;
      const rect = menu.getBoundingClientRect();
      let left = clientX;
      let top = clientY;
      if (left + rect.width > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - rect.width - pad);
      }
      if (top + rect.height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - rect.height - pad);
      }
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }

    const disp = term.onData((data) => {
      if (disabledRef.current) return;
      if (!data) return;
      if (data === "\r") {
        if (localHistoryRef.current) {
          pushHistory(lineBuf);
          histIdx = -1;
          draft = "";
          lineBuf = "";
        }
        emit(enterPayloadRef.current || "\n");
        return;
      }
      if (localHistoryRef.current) noteIncoming(data);
      emit(data);
    });

    const scrollDisp = term.onScroll(() => {
      if (ignoreScrollRef.current) return;
      try {
        const buf = term.buffer.active;
        const atBottom = buf.baseY - buf.viewportY <= 0;
        if (!atBottom) {
          pinnedViewportYRef.current = buf.viewportY;
        }
        applyFollow(atBottom);
      } catch {
        /* ignore */
      }
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
      const key = ev.key.toLowerCase();

      // 复制：Ctrl+Shift+C，或 Ctrl+C（有选区时）
      if (ctrl && key === "c") {
        const sel = term.getSelection();
        if (sel) {
          void writeClipboard(sel);
          return false;
        }
        return true;
      }

      // 粘贴：Ctrl+V / Ctrl+Shift+V（须 preventDefault，否则 xterm 原生 paste 会再贴一次）
      if (ctrl && key === "v") {
        ev.preventDefault();
        ev.stopPropagation();
        void pasteFromClipboard();
        return false;
      }

      if (ctrl && key === "f") {
        onFindShortcutRef.current?.();
        return false;
      }
      if (ctrl && key === "s") {
        onSaveShortcutRef.current?.();
        return false;
      }

      if (ctrl && (ev.key === "l" || ev.key === "L")) {
        term.clear();
        return false;
      }
      if (
        localHistoryRef.current &&
        !disabledRef.current &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        !ev.isComposing
      ) {
        if (ev.key === "ArrowUp") {
          if (!history.length) return true;
          historyUp();
          return false;
        }
        if (ev.key === "ArrowDown") {
          if (!history.length || histIdx === -1) return true;
          historyDown();
          return false;
        }
      }
      return true;
    });

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY);
    };
    host.addEventListener("contextmenu", onContextMenu);

    // 接管原生 paste，避免与自定义 Ctrl+V 重复，并统一走 clipboard bridge
    const onPaste = (ev: ClipboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      if (text) pasteText(text);
      else void pasteFromClipboard();
    };
    host.addEventListener("paste", onPaste, true);

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        dismissCtxMenu();
        return;
      }
      const ae = document.activeElement;
      if (ae !== host && !host.contains(ae)) return;
      if (ev.key === "Insert" && ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
        if (term.hasSelection()) {
          ev.preventDefault();
          ev.stopPropagation();
          void copySelection();
        }
      } else if (ev.key === "Insert" && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        void pasteFromClipboard();
      }
    };
    // 只挂一层，避免 host + window 各触发一次导致 Shift+Insert 双贴
    window.addEventListener("keydown", onKeyDown, true);

    const onPointerDown = (ev: PointerEvent) => {
      if (ctxMenu && !ctxMenu.contains(ev.target as Node)) {
        dismissCtxMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);

    let lastW = 0;
    let lastH = 0;
    let fitTimer: number | null = null;
    const onResize = () => {
      dismissCtxMenu();
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w < 16 || h < 16) return;
      if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
      lastW = w;
      lastH = h;
      if (fitTimer != null) window.clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }, 40);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    window.addEventListener("resize", onResize);

    const applyThemeToTerm = () => {
      try {
        term.options.theme = readXtermTheme();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("toolbox-theme-change", applyThemeToTerm);
    const themeObs = new MutationObserver(applyThemeToTerm);
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const applyShellPrefs = (prefs: ShellPrefs) => {
      applyPrefsToTerminal(term, prefs, fit);
    };
    const unsubPrefs = subscribeShellPrefs(applyShellPrefs);
    const onShellPrefs = (ev: Event) => {
      const detail = (ev as CustomEvent<ShellPrefs>).detail;
      applyShellPrefs(detail || readShellPrefs());
    };
    window.addEventListener(SHELL_PREFS_EVENT, onShellPrefs);

    const applyScrollback = (prefs: AppPrefs) => {
      try {
        term.options.scrollback = prefs.shellScrollback;
      } catch {
        /* ignore */
      }
    };
    const unsubAppPrefs = subscribeAppPrefs(applyScrollback);
    const onAppPrefs = (ev: Event) => {
      const detail = (ev as CustomEvent<AppPrefs>).detail;
      applyScrollback(detail || readAppPrefs());
    };
    window.addEventListener(APP_PREFS_EVENT, onAppPrefs);

    return () => {
      if (fitTimer != null) window.clearTimeout(fitTimer);
      dismissCtxMenu();
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("paste", onPaste, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("toolbox-theme-change", applyThemeToTerm);
      window.removeEventListener(SHELL_PREFS_EVENT, onShellPrefs);
      window.removeEventListener(APP_PREFS_EVENT, onAppPrefs);
      unsubPrefs();
      unsubAppPrefs();
      themeObs.disconnect();
      disp.dispose();
      scrollDisp.dispose();
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = Boolean(disabled);
    if (!disabled) {
      requestAnimationFrame(() => term.focus());
    }
  }, [disabled]);

  return (
    <div
      className="shell-xterm"
      title="复制：Ctrl+C · 粘贴：Ctrl+V · 查找：Ctrl+F · 保存：Ctrl+S"
      onMouseDown={(e) => {
        // 右键留给菜单，避免 focus 干扰选区
        if (e.button !== 0) return;
        if (!disabledRef.current) termRef.current?.focus();
      }}
    >
      <div className="shell-xterm-fit" ref={hostRef} />
    </div>
  );
});

export default ShellTerminal;
