import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toErrorMessage } from "../../errors";
import { api, wsUrl } from "../../api/client";
import { reportActivity } from "../../activity";
import {
  patchAppPrefs,
  readAppPrefs,
  subscribeAppPrefs,
} from "../../appPrefs";
import { useDialog } from "../../components/dialog";
import { useToast } from "../../components/toast";
import { useStickyLogScroll } from "../../hooks/useStickyLogScroll";
import { Button, EmptyState } from "../../ui";

type Props = {
  deviceSn: string;
  snOk: boolean;
  /** true when logcat tab visible AND device page active（仅影响预览刷新，不停止后台抓取） */
  active: boolean;
  onAppend: (line: string) => void;
  onStatus: (msg: string | ((prev: string) => string)) => void;
};

const LOG_BUFFERS = [
  "",
  "main",
  "system",
  "kernel",
  "crash",
  "radio",
  "events",
  "all",
] as const;
const LOG_LEVELS = ["", "V", "D", "I", "W", "E", "F"] as const;
const DUMPSYS_PRESETS = [
  "activity",
  "window",
  "meminfo",
  "cpuinfo",
  "package",
  "display",
  "audio",
  "input",
  "power",
  "SurfaceFlinger",
  "media.player",
] as const;
const ROTATE_OPTIONS = [
  { value: 0, label: "不切分" },
  { value: 20, label: "20 MB" },
  { value: 50, label: "50 MB" },
  { value: 100, label: "100 MB" },
] as const;
const LOGCAT_FLUSH_MS = 250;
const LOGCAT_PREFS_KEY = "toolbox.logcat.prefs.v1";

type LogcatPrefs = {
  tag?: string;
  level?: string;
  buffer?: string;
  dumpsys?: string;
  pkgOrPid?: string;
  rotateMb?: number;
  wrapLines?: boolean;
};

type LogLineTone = "v" | "d" | "i" | "w" | "e" | "f" | "mark";

const THREADTIME_META_RE =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+\d+\s+([VDIWEFS])\s+([^:\s][^:]*?)\s*:/;
const BRIEF_META_RE = /^([VDIWEFS])\/([^\s(]+)\(\s*(\d+)\)/;
const THREADTIME_LV_RE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+([VDIWEFS])\b/;
const BRIEF_LV_RE = /^([VDIWEFS])\/[^\s(]+/;
const CRASH_TEXT_RE = /FATAL EXCEPTION|ANR in |AndroidRuntime.*FATAL|\bSIGSEGV\b|\bSIGABRT\b|tombstone/i;

function parseLogLineMeta(line: string): { pid: string; tag: string } {
  const m1 = THREADTIME_META_RE.exec(line);
  if (m1) return { pid: m1[1], tag: m1[3].trim() };
  const m2 = BRIEF_META_RE.exec(line);
  if (m2) return { pid: m2[3], tag: m2[2].trim() };
  return { pid: "", tag: "" };
}

function classifyLogLine(line: string): LogLineTone {
  if (line.startsWith("==== [MARK ")) return "mark";
  if (CRASH_TEXT_RE.test(line)) return "f";
  const m = THREADTIME_LV_RE.exec(line) || BRIEF_LV_RE.exec(line);
  if (m) {
    const ch = m[1];
    if (ch === "F") return "f";
    if (ch === "E") return "e";
    if (ch === "W") return "w";
    if (ch === "I") return "i";
    if (ch === "D") return "d";
  }
  return "v";
}

function isErrorTone(tone: LogLineTone): boolean {
  return tone === "e" || tone === "f";
}

function renderHighlightedLine(text: string, re: RegExp | null) {
  if (!text) return " ";
  if (!re) return text;
  const parts: Array<string | ReactNode> = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(text)) !== null && count < 12) {
    if (!m[0].length) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={count} className="logcat-hit">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    count += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

const LogcatLineRow = memo(function LogcatLineRow({
  idx,
  text,
  tone,
  activeJump,
  highlightRe,
}: {
  idx: number;
  text: string;
  tone: LogLineTone;
  activeJump: boolean;
  highlightRe: RegExp | null;
}) {
  return (
    <div
      data-line-idx={idx}
      className={`logcat-line is-${tone}${activeJump ? " is-jump" : ""}`}
    >
      {renderHighlightedLine(text, highlightRe)}
    </div>
  );
});

function readAutoSavePref(): boolean {
  try {
    return readAppPrefs().logcatAutoSave;
  } catch {
    return true;
  }
}

function readLogcatPrefs(): LogcatPrefs {
  try {
    const raw = localStorage.getItem(LOGCAT_PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as LogcatPrefs;
  } catch {
    return {};
  }
}

function shortPath(p: string, max = 56): string {
  const s = (p || "").trim();
  if (!s) return "（尚未开始）";
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

export default function LogcatPanel({
  deviceSn,
  snOk,
  active,
  onAppend,
  onStatus,
}: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const initPrefs = readLogcatPrefs();
  const [busy, setBusy] = useState(false);
  const [bugreportBusy, setBugreportBusy] = useState(false);
  const [bugreportProg, setBugreportProg] = useState<{
    elapsedSec: number;
    sizeBytes: number;
    percent: number | null;
    stage: string;
  } | null>(null);
  const bugreportAbortRef = useRef<AbortController | null>(null);
  const [tag, setTag] = useState(initPrefs.tag ?? "");
  const [level, setLevel] = useState(initPrefs.level ?? "");
  const [logBuffer, setLogBuffer] = useState(initPrefs.buffer ?? "");
  const [pkgOrPid, setPkgOrPid] = useState(initPrefs.pkgOrPid ?? "");
  const [installedPkgs, setInstalledPkgs] = useState<string[]>([]);
  const [pkgMenuOpen, setPkgMenuOpen] = useState(false);
  const [dumpsysMenuOpen, setDumpsysMenuOpen] = useState(false);
  const pkgComboRef = useRef<HTMLDivElement | null>(null);
  const dumpsysComboRef = useRef<HTMLDivElement | null>(null);
  const [rotateMb, setRotateMb] = useState<number>(initPrefs.rotateMb ?? 50);
  const [logcatLines, setLogcatLines] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState("");
  const [excludeFilter, setExcludeFilter] = useState("");
  const [filterRegex, setFilterRegex] = useState(false);
  const [filterCase, setFilterCase] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<"all" | "warn" | "err">("all");
  const [wrapLines, setWrapLines] = useState<boolean>(initPrefs.wrapLines ?? true);
  const [lineMenu, setLineMenu] = useState<{
    x: number;
    y: number;
    text: string;
    pid: string;
    tag: string;
  } | null>(null);
  const [errCursor, setErrCursor] = useState(-1);
  const [logAutoSave, setLogAutoSave] = useState(readAutoSavePref);
  const [logcatMaxLines, setLogcatMaxLines] = useState(
    () => readAppPrefs().logcatMaxLines,
  );
  const logcatMaxLinesRef = useRef(logcatMaxLines);
  logcatMaxLinesRef.current = logcatMaxLines;
  const [logRoot, setLogRoot] = useState("");
  const [logSession, setLogSession] = useState("");
  const [logSaveFile, setLogSaveFile] = useState("");
  const [dumpsysSvc, setDumpsysSvc] = useState(initPrefs.dumpsys ?? "activity");
  const [logLive, setLogLive] = useState(false);
  /** 与 wantLiveRef 同步，用于断线重连期间仍显示「停止」 */
  const [wantLive, setWantLive] = useState(false);
  const markSeqRef = useRef(0);
  const filterRestartInitRef = useRef(false);

  const logWs = useRef<WebSocket | null>(null);
  const logPending = useRef<string[]>([]);
  const pausedTailRef = useRef<string[]>([]);
  const [pausedNewCount, setPausedNewCount] = useState(0);
  const logFlushTimer = useRef<number | null>(null);
  /** 仅在持续抓取且未点停止时接收预览行 */
  const logAcceptRef = useRef(false);
  /** 用户意图：点「持续」后为 true，点「停止」或换设备后为 false；断线后据此自动续抓 */
  const wantLiveRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const restartAttemptRef = useRef(0);
  const startingRef = useRef(false);
  const snOkRef = useRef(snOk);
  snOkRef.current = snOk;
  const startLiveRef = useRef<() => Promise<void>>(async () => {});
  /** 切到其它页/标签时仍后台抓文件，只暂停预览刷 UI */
  const activeRef = useRef(active);
  activeRef.current = active;

  const logcatView = useMemo(() => {
    const rawInclude = logFilter.trim();
    const rawExclude = excludeFilter.trim();
    let regexErr = false;
    let incRe: RegExp | null = null;
    if (rawInclude && filterRegex) {
      try {
        incRe = new RegExp(rawInclude, filterCase ? "" : "i");
      } catch {
        regexErr = true;
      }
    }
    const incNeedle = filterCase ? rawInclude : rawInclude.toLowerCase();
    const excTokens = rawExclude
      ? rawExclude
          .split(/[,\s]+/)
          .map((t) => (filterCase ? t : t.toLowerCase()))
          .filter(Boolean)
      : [];

    const items: Array<{ text: string; tone: LogLineTone }> = [];
    const errorIndices: number[] = [];

    for (let i = 0; i < logcatLines.length; i++) {
      const line = logcatLines[i];
      const tone = classifyLogLine(line);
      if (tone !== "mark") {
        if (severityFilter === "err" && !isErrorTone(tone)) continue;
        if (severityFilter === "warn" && tone !== "w" && !isErrorTone(tone)) continue;
      }
      const hay = filterCase ? line : line.toLowerCase();
      if (rawInclude && !regexErr) {
        if (incRe) {
          if (!incRe.test(line)) continue;
        } else if (!hay.includes(incNeedle)) {
          continue;
        }
      }
      if (excTokens.length && tone !== "mark") {
        if (excTokens.some((ex) => hay.includes(ex))) continue;
      }
      const shownIdx = items.length;
      items.push({ text: line, tone });
      if (isErrorTone(tone)) errorIndices.push(shownIdx);
    }

    return {
      items,
      errorIndices,
      regexErr,
      shown: items.length,
      total: logcatLines.length,
    };
  }, [logcatLines, logFilter, excludeFilter, filterRegex, filterCase, severityFilter]);

  const logcatHighlightRe = useMemo(() => {
    const raw = logFilter.trim();
    if (!raw || logcatView.regexErr) return null;
    try {
      const pattern = filterRegex
        ? raw
        : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(pattern, filterCase ? "g" : "gi");
    } catch {
      return null;
    }
  }, [logFilter, filterRegex, filterCase, logcatView.regexErr]);

  const logcatScrollKey = `${logcatView.shown}:${logcatView.items[logcatView.items.length - 1]?.text || ""}`;
  const logcatScroll = useStickyLogScroll(logcatScrollKey);

  function dropLogcatPending() {
    if (logFlushTimer.current != null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    logPending.current = [];
  }

  function flushLogcatPending() {
    logFlushTimer.current = null;
    if (!logAcceptRef.current) {
      logPending.current = [];
      return;
    }
    const batch = logPending.current;
    if (!batch.length) return;
    logPending.current = [];
    const maxLines = logcatMaxLinesRef.current;

    // 停随（冻结预览）时不淘汰顶部行，避免 3000 行满后阅读位置被顶走/跳动；服务端仍正常落盘
    if (!logcatScroll.followRef.current) {
      const merged = pausedTailRef.current.concat(batch);
      pausedTailRef.current =
        merged.length > maxLines ? merged.slice(-maxLines) : merged;
      setPausedNewCount((c) => c + batch.length);
      return;
    }

    const carry = pausedTailRef.current;
    if (carry.length) {
      pausedTailRef.current = [];
      setPausedNewCount(0);
    }
    const combined = carry.length ? carry.concat(batch) : batch;
    setLogcatLines((prev) => {
      const next =
        prev.length + combined.length > maxLines
          ? prev.concat(combined).slice(-maxLines)
          : prev.concat(combined);
      return next;
    });
  }

  function enqueueLogcat(lines: string[]) {
    if (!logAcceptRef.current || !lines.length) return;
    // 页面不可见时不刷预览，服务端仍在写文件
    if (!activeRef.current) return;
    logPending.current.push(...lines);
    if (logFlushTimer.current == null) {
      logFlushTimer.current = window.setTimeout(flushLogcatPending, LOGCAT_FLUSH_MS);
    }
  }

  function clearLogcatView() {
    dropLogcatPending();
    pausedTailRef.current = [];
    setPausedNewCount(0);
    setLogcatLines([]);
  }

  useEffect(() => {
    if (!logcatScroll.follow || !pausedTailRef.current.length) return;
    const carry = pausedTailRef.current;
    pausedTailRef.current = [];
    setPausedNewCount(0);
    const maxLines = logcatMaxLinesRef.current;
    setLogcatLines((prev) => {
      const next =
        prev.length + carry.length > maxLines
          ? prev.concat(carry).slice(-maxLines)
          : prev.concat(carry);
      return next;
    });
  }, [logcatScroll.follow]);

  function clearRestartTimer() {
    if (restartTimerRef.current != null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }

  function scheduleLiveRestart(reason: string, immediate = false) {
    if (!wantLiveRef.current) return;
    if (!snOkRef.current) {
      clearRestartTimer();
      onStatus(`持续抓取中断（${reason}），等待设备重新上线…`);
      return;
    }
    if (immediate) {
      clearRestartTimer();
      restartAttemptRef.current = 0;
    }
    if (restartTimerRef.current != null) return;
    const attempt = restartAttemptRef.current;
    const delay = immediate
      ? 150
      : Math.min(10000, Math.round(700 * Math.pow(1.6, attempt)));
    onStatus(
      immediate
        ? "设备已重新上线，正在续抓…"
        : `持续抓取中断（${reason}），${Math.max(1, Math.round(delay / 1000))}s 后重试…`,
    );
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      if (!wantLiveRef.current) return;
      if (!snOkRef.current) {
        onStatus("等待设备重新上线后继续抓取…");
        return;
      }
      restartAttemptRef.current = Math.min(attempt + 1, 8);
      void startLiveRef.current();
    }, delay);
  }

  function stopLogcatLive(opts?: { closeWs?: boolean; userStop?: boolean }) {
    if (opts?.userStop !== false) {
      // 默认视为用户停止；自动重连路径会显式传 userStop:false
      wantLiveRef.current = false;
      setWantLive(false);
      clearRestartTimer();
      restartAttemptRef.current = 0;
    }
    logAcceptRef.current = false;
    dropLogcatPending();
    setLogLive(false);
    const ws = logWs.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* ignore */
      }
    }
    if (opts?.closeWs !== false) {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      logWs.current = null;
    }
  }

  useEffect(() => {
    const id = `logcat:${deviceSn || "none"}`;
    if (logLive && snOk) {
      const short =
        deviceSn.length <= 18 ? deviceSn : `${deviceSn.slice(0, 17)}…`;
      reportActivity(id, true, `Log抓取 ${short}`);
    } else if (wantLive) {
      reportActivity(id, true, `Log抓取重连中…`);
    } else {
      reportActivity(id, false);
    }
    return () => reportActivity(id, false);
  }, [logLive, wantLive, deviceSn, snOk]);

  function saveLogcatPreview() {
    const text = logcatLines.join("\n");
    if (!text) return;
    const ts = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14);
    const sn = (deviceSn || "device").replace(/[<>:"/\\|?*\s]+/g, "_").slice(0, 40);
    const buf = logBuffer.trim().replace(/[<>:"/\\|?*\s]+/g, "_");
    const stem =
      buf && buf !== "默认" ? `logcat_preview_${buf.slice(0, 24)}` : "logcat_preview";
    const parts = [stem];
    if (sn) parts.push(sn);
    const tg = tag.trim().replace(/[<>:"/\\|?*\s]+/g, "_");
    if (tg) parts.push(tg.slice(0, 40));
    const lv = level.trim().replace(/[<>:"/\\|?*\s]+/g, "_");
    if (lv) parts.push(lv.slice(0, 8));
    parts.push(ts);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = `${parts.join("_")}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    onStatus(`已导出预览 ${logcatLines.length} 行`);
  }

  async function refreshLogSession() {
    if (!snOk) {
      setLogRoot("");
      setLogSession("");
      return;
    }
    try {
      const r = await api.logcatSession(deviceSn);
      setLogRoot(r.root || "");
      setLogSession(r.session || "");
    } catch {
      /* ignore */
    }
  }

  async function ensureLogSession(forceNew = false) {
    if (!snOk) return "";
    const r = await api.logcatSessionEnsure(deviceSn, forceNew);
    setLogRoot(r.root || "");
    setLogSession(r.session || "");
    return r.session || "";
  }

  async function openLogDir(kind: "session" | "root" | "file" = "session") {
    const target =
      kind === "file"
        ? logSaveFile
        : kind === "root"
          ? logRoot
          : logSession || logRoot;
    if (!target) {
      onStatus("尚无保存目录");
      return;
    }
    try {
      const r = await api.openPath(target);
      onStatus(r.message);
    } catch (e) {
      onStatus(`打开日志目录失败：${toErrorMessage(e)}`);
    }
  }

  useEffect(() => {
    // 切回 Log 页时恢复预览跟随；不停止后台抓取
    if (active && logLive) logcatScroll.setFollow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (active && snOk) void refreshLogSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snOk, deviceSn]);

  useEffect(() => {
    stopLogcatLive({ userStop: true });
    clearLogcatView();
    setLogSaveFile("");
    setLogSession("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceSn]);

  useEffect(() => {
    // 设备重新上线且用户仍要持续抓取 → 立即自动续抓
    if (snOk && wantLiveRef.current && !logLive) {
      scheduleLiveRestart("设备已上线", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snOk]);

  useEffect(() => {
    return subscribeAppPrefs((p) => {
      setLogAutoSave(p.logcatAutoSave);
      setLogcatMaxLines(p.logcatMaxLines);
    });
  }, []);

  useEffect(() => {
    if (readAppPrefs().logcatAutoSave === logAutoSave) return;
    patchAppPrefs({ logcatAutoSave: logAutoSave });
  }, [logAutoSave]);

  useEffect(() => {
    try {
      localStorage.setItem(
        LOGCAT_PREFS_KEY,
        JSON.stringify({
          tag,
          level,
          buffer: logBuffer,
          dumpsys: dumpsysSvc,
          pkgOrPid,
          rotateMb,
          wrapLines,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [tag, level, logBuffer, dumpsysSvc, pkgOrPid, rotateMb, wrapLines]);

  useEffect(() => {
    if (!pkgMenuOpen && !dumpsysMenuOpen) return;
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (pkgMenuOpen && pkgComboRef.current && !pkgComboRef.current.contains(t)) {
        setPkgMenuOpen(false);
      }
      if (dumpsysMenuOpen && dumpsysComboRef.current && !dumpsysComboRef.current.contains(t)) {
        setDumpsysMenuOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setPkgMenuOpen(false);
        setDumpsysMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pkgMenuOpen, dumpsysMenuOpen]);

  const filteredPkgSuggestions = useMemo(() => {
    const q = pkgOrPid.trim().toLowerCase();
    if (!q || /^\d+$/.test(q)) return installedPkgs.slice(0, 40);
    return installedPkgs.filter((p) => p.toLowerCase().includes(q)).slice(0, 40);
  }, [installedPkgs, pkgOrPid]);

  const filteredDumpsysPresets = useMemo(() => {
    const q = dumpsysSvc.trim().toLowerCase();
    if (!q) return [...DUMPSYS_PRESETS];
    const hits = DUMPSYS_PRESETS.filter((s) => s.toLowerCase().includes(q));
    return hits.length ? hits : [...DUMPSYS_PRESETS];
  }, [dumpsysSvc]);
  useEffect(() => {
    if (!lineMenu) return;
    const close = () => setLineMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setLineMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [lineMenu]);

  useEffect(() => {
    if (!active || !snOk) {
      setInstalledPkgs([]);
      return;
    }
    let cancelled = false;
    void api
      .packages(deviceSn, "", "third")
      .then((r) => {
        if (!cancelled) setInstalledPkgs(r.packages || []);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [active, snOk, deviceSn]);

  useEffect(() => {
    if (!filterRestartInitRef.current) {
      filterRestartInitRef.current = true;
      return;
    }
    if (!wantLiveRef.current || !snOkRef.current) return;
    const t = window.setTimeout(() => {
      if (wantLiveRef.current && snOkRef.current) {
        onStatus("条件已变更，正在应用并重连 logcat…");
        void startLiveRef.current();
      }
    }, 450);
    return () => window.clearTimeout(t);
  }, [tag, level, logBuffer, pkgOrPid, rotateMb]);

  useEffect(() => {
    return () => {
      wantLiveRef.current = false;
      clearRestartTimer();
      try {
        logWs.current?.close();
      } catch {
        /* ignore */
      }
      logWs.current = null;
      if (logFlushTimer.current != null) {
        window.clearTimeout(logFlushTimer.current);
        logFlushTimer.current = null;
      }
      logPending.current = [];
    };
  }, []);

  async function wrap(label: string, fn: () => Promise<void>) {
    if (!snOk) return;
    setBusy(true);
    onStatus(label);
    try {
      await fn();
    } catch (e) {
      const op = label.replace(/…$/, "").trim();
      const raw = toErrorMessage(e);
      onStatus(op && !raw.startsWith(op) ? `${op}失败：${raw}` : raw);
    } finally {
      setBusy(false);
    }
  }

  function openLogWs(): Promise<WebSocket> {
    const cur = logWs.current;
    if (cur && cur.readyState === WebSocket.OPEN) return Promise.resolve(cur);
    if (cur && cur.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        const onOpen = () => {
          cur.removeEventListener("open", onOpen);
          cur.removeEventListener("error", onErr);
          resolve(cur);
        };
        const onErr = () => {
          cur.removeEventListener("open", onOpen);
          cur.removeEventListener("error", onErr);
          reject(new Error("Logcat WebSocket 失败"));
        };
        cur.addEventListener("open", onOpen);
        cur.addEventListener("error", onErr);
      });
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        wsUrl(`/adb/device/logcat/ws?device=${encodeURIComponent(deviceSn)}`),
      );
      logWs.current = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            text?: string;
            texts?: string[];
            path?: string;
            session?: string;
            auto_save?: boolean;
          };
          if (msg.type === "lines" && Array.isArray(msg.texts) && msg.texts.length) {
            enqueueLogcat(msg.texts);
          } else if (msg.type === "line" && msg.text != null) {
            enqueueLogcat([msg.text]);
          } else if (msg.type === "error" && msg.text) {
            onStatus(msg.text);
            // start 失败等：保持 wantLive，稍后自动重试
            logAcceptRef.current = false;
            setLogLive(false);
            if (wantLiveRef.current) scheduleLiveRestart(msg.text.slice(0, 40));
          } else if (msg.type === "started") {
            logAcceptRef.current = true;
            clearRestartTimer();
            restartAttemptRef.current = 0;
            setLogLive(true);
            logcatScroll.setFollow(true);
            if (msg.path) setLogSaveFile(msg.path);
            if (msg.session) setLogSession(msg.session);
            onStatus(
              msg.auto_save && msg.path
                ? `持续抓取中 → ${shortPath(msg.path, 48)}`
                : "持续抓取中…",
            );
          } else if (msg.type === "rotated" && msg.path) {
            setLogSaveFile(msg.path);
            onStatus(`日志已自动切分 → ${shortPath(msg.path, 48)}`);
            toast.push(`日志超过阈值，已自动切分新文件`, "info");
          } else if (msg.type === "ended") {
            logAcceptRef.current = false;
            dropLogcatPending();
            setLogLive(false);
            const detail = msg.text || "logcat 已中断";
            onStatus(detail);
            if (wantLiveRef.current) scheduleLiveRestart(detail.slice(0, 40));
          } else if (msg.type === "stopped") {
            logAcceptRef.current = false;
            dropLogcatPending();
            setLogLive(false);
            if (!wantLiveRef.current) {
              toast.push(
                logSaveFile
                  ? `已停止 logcat 抓取（已保存：${shortPath(logSaveFile, 48)}）`
                  : "已停止 logcat 实时抓取",
                "info",
              );
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("Logcat WebSocket 失败"));
      ws.onclose = () => {
        logAcceptRef.current = false;
        dropLogcatPending();
        setLogLive(false);
        if (logWs.current === ws) logWs.current = null;
        if (wantLiveRef.current) scheduleLiveRestart("连接断开");
      };
    });
  }

  async function startLogcatLive() {
    wantLiveRef.current = true;
    setWantLive(true);
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      if (!snOkRef.current) {
        onStatus("等待设备重新上线后继续抓取…");
        return;
      }
      const session = logAutoSave
        ? (await ensureLogSession(false)) || logSession
        : logSession;
      dropLogcatPending();
      const ws = await openLogWs();
      if (!wantLiveRef.current) return;
      const target = pkgOrPid.trim();
      const pidVal = /^\d+$/.test(target) ? target : "";
      const pkgVal = target && !pidVal ? target : "";
      ws.send(
        JSON.stringify({
          type: "start",
          tag,
          level,
          buffer: logBuffer,
          package: pkgVal,
          pid: pidVal,
          rotate_mb: logAutoSave ? rotateMb : 0,
          auto_save: logAutoSave,
          session,
        }),
      );
    } catch (e) {
      logAcceptRef.current = false;
      setLogLive(false);
      const msg = toErrorMessage(e);
      onStatus(msg);
      if (wantLiveRef.current) scheduleLiveRestart(msg.slice(0, 40));
    } finally {
      startingRef.current = false;
    }
  }
  startLiveRef.current = () => startLogcatLive();

  function formatBugreportSize(n: number): string {
    if (n <= 0) return "";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatElapsed(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  async function runBugreport() {
    if (!snOk || bugreportBusy) return;
    const ac = new AbortController();
    bugreportAbortRef.current = ac;
    setBugreportBusy(true);
    setBugreportProg({ elapsedSec: 0, sizeBytes: 0, percent: null, stage: "collect" });
    onStatus("生成 bugreport（可能较久，可继续抓取其他日志）…");
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      setBugreportProg((prev) =>
        prev && prev.elapsedSec !== elapsedSec ? { ...prev, elapsedSec } : prev,
      );
    }, 250);
    try {
      const session = (await ensureLogSession(false)) || logSession;
      const r = await api.bugreportStream(deviceSn, {
        session,
        signal: ac.signal,
        onProgress: (ev) => {
          setBugreportProg((prev) =>
            prev
              ? {
                  ...prev,
                  sizeBytes: ev.size_bytes,
                  percent: ev.percent,
                  stage: ev.stage,
                }
              : prev,
          );
        },
      });
      onAppend(`# ${r.message}`);
      if (r.session) setLogSession(r.session);
      if (r.saved_path) setLogSaveFile(r.saved_path);
      const okMsg = r.saved_path
        ? `bugreport → ${shortPath(r.saved_path, 48)}`
        : "bugreport 完成";
      onStatus(okMsg);
      toast.push(
        r.saved_path
          ? `bugreport 已保存：${shortPath(r.saved_path, 48)}`
          : "bugreport 已生成",
        "ok",
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast.push("已取消生成 bugreport", "info");
      } else {
        const msg = `生成 bugreport 失败：${toErrorMessage(e)}`;
        toast.push(msg, "err");
      }
    } finally {
      window.clearInterval(tick);
      if (bugreportAbortRef.current === ac) bugreportAbortRef.current = null;
      setBugreportBusy(false);
      setBugreportProg(null);
    }
  }

  async function runExport(
    label: string,
    doneLabel: string,
    fn: (session: string) => Promise<{
      message: string;
      session?: string;
      saved_path?: string;
    }>,
  ) {
    await wrap(label, async () => {
      const session = (await ensureLogSession(false)) || logSession;
      const r = await fn(session);
      onAppend(`# ${r.message}`);
      if (r.session) setLogSession(r.session);
      if (r.saved_path) setLogSaveFile(r.saved_path);
      onStatus(
        r.saved_path ? `${doneLabel} → ${shortPath(r.saved_path, 48)}` : `${doneLabel} 完成`,
      );
    });
  }

  const lineLabel =
    logcatView.shown !== logcatView.total
      ? `${logcatView.shown}/${logcatView.total}`
      : String(logcatView.total);
  const saveHint = logSession || logSaveFile;

  function parsePkgOrPid() {
    const target = pkgOrPid.trim();
    const pidVal = /^\d+$/.test(target) ? target : "";
    const pkgVal = target && !pidVal ? target : "";
    return { pid: pidVal, package: pkgVal };
  }

  async function fillForegroundPkg() {
    await wrap("获取当前前台应用…", async () => {
      const r = await api.foregroundApp(deviceSn);
      if (!r.package) {
        toast.push("未检测到前台应用（可能屏幕已熄灭）", "warn");
        onStatus("未检测到前台应用");
        return;
      }
      setPkgOrPid(r.package);
      onStatus(`已填入前台应用: ${r.package}`);
      toast.push(`已填入前台应用: ${r.package}`, "ok");
    });
  }

  async function clearAndRestartLive() {
    if (!snOk || busy) return;
    await wrap("清空缓冲并重录…", async () => {
      await api.logcatClear(deviceSn, logBuffer);
      clearLogcatView();
      await startLogcatLive();
      toast.push("已清空缓冲并重新开始抓取", "ok");
    });
  }

  function insertMark(note = "") {
    markSeqRef.current += 1;
    const label = note.trim() || `复现标记 #${markSeqRef.current}`;
    const ws = logWs.current;
    if (logLive && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "mark", note: label }));
      toast.push(`已写入标记：${label}`, "ok");
      return;
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const line = `==================== [MARK ${hh}:${mm}:${ss}] ${label} ====================`;
    setLogcatLines((prev) => {
      const next = [...prev, line];
      return next.length > logcatMaxLines ? next.slice(-logcatMaxLines) : next;
    });
    logcatScroll.setFollow(true);
    toast.push(`已插入标记：${label}`, "ok");
  }

  async function promptAndInsertMark() {
    const note = await dialog.prompt({
      title: "插入复现标记",
      message: "输入标记备注（留空将使用默认编号）：",
      placeholder: "例如：复现画面卡顿 / 切换片源前",
      okLabel: "插入标记",
      cancelLabel: "取消",
    });
    if (note === null) return;
    insertMark(note);
  }

  async function collectCrashScene() {
    await wrap("收集 ANR / Crash 现场…", async () => {
      const session = (await ensureLogSession(false)) || logSession;
      const r = await api.logcatCollectCrash(deviceSn, session);
      if (r.session) setLogSession(r.session);
      if (r.dir) setLogSaveFile(r.dir);
      onAppend(
        `[collect-crash] ${r.dir} (${r.count} 个文件)\n${(r.notes || []).join("\n")}`,
      );
      const msg = `已收集 ${r.count} 个现场文件 → ${shortPath(r.dir, 40)}`;
      onStatus(msg);
      toast.push(msg, r.ok ? "ok" : "warn");
    });
  }

  function jumpToError(delta: number) {
    const errs = logcatView.errorIndices;
    if (!errs.length) return;
    let nextPos = 0;
    if (errCursor >= 0) {
      const curAt = errs.indexOf(errCursor);
      if (curAt >= 0) {
        nextPos = (curAt + delta + errs.length) % errs.length;
      } else {
        nextPos = delta >= 0 ? 0 : errs.length - 1;
      }
    } else {
      nextPos = delta >= 0 ? 0 : errs.length - 1;
    }
    const targetIdx = errs[nextPos];
    setErrCursor(targetIdx);
    logcatScroll.setFollow(false);
    window.requestAnimationFrame(() => {
      const el = logcatScroll.ref.current?.querySelector(
        `[data-line-idx="${targetIdx}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "center" });
    });
  }

  const activeErrJump = errCursor;

  return (
    <div
      className="logcat-panel"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") {
          e.preventDefault();
          insertMark();
        }
      }}
    >
      <div className={`logcat-controls${busy ? " is-busy" : ""}`}>
        <div className="logcat-toolbar-row">
          <div className="logcat-filter-strip">
            <select
              className="field logcat-buf-select"
              value={logBuffer}
              disabled={!snOk || busy}
              onChange={(e) => setLogBuffer(e.target.value)}
              title="缓冲区（持续抓取中修改将自动应用）"
              aria-label="缓冲区"
            >
              {LOG_BUFFERS.map((b) => (
                <option key={b || "default"} value={b}>
                  {b || "默认"}
                </option>
              ))}
            </select>
            <input
              className="field logcat-tag-input"
              placeholder="Tag 过滤（多 Tag 用空格/逗号）"
              value={tag}
              disabled={!snOk || busy}
              onChange={(e) => setTag(e.target.value)}
              aria-label="Tag"
            />
            <div className="logcat-combo-wrap" ref={pkgComboRef}>
              <div className="logcat-combo logcat-pkg-combo">
                <div className="logcat-pkg-input-wrap">
                  <input
                    className="field mono logcat-pkg-input"
                    placeholder="包名或 PID"
                    value={pkgOrPid}
                    disabled={!snOk || busy}
                    onFocus={() => {
                      if (installedPkgs.length) setPkgMenuOpen(true);
                    }}
                    onChange={(e) => {
                      setPkgOrPid(e.target.value);
                      if (installedPkgs.length) setPkgMenuOpen(true);
                    }}
                    aria-label="包名或 PID"
                    title="按应用包名或 PID 过滤（留空抓全部）"
                  />
                  {pkgOrPid ? (
                    <button
                      type="button"
                      className="logcat-pkg-clear"
                      title="清空包名/PID"
                      onClick={() => {
                        setPkgOrPid("");
                        setPkgMenuOpen(false);
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn logcat-combo-btn"
                  disabled={!snOk || busy}
                  title="自动填入当前前台应用包名"
                  onClick={() => {
                    setPkgMenuOpen(false);
                    void fillForegroundPkg();
                  }}
                >
                  前台
                </button>
              </div>
              {pkgMenuOpen && filteredPkgSuggestions.length ? (
                <ul className="logcat-suggest-menu" role="listbox">
                  {filteredPkgSuggestions.map((p) => (
                    <li key={p}>
                      <button
                        type="button"
                        className={`logcat-suggest-item mono${pkgOrPid === p ? " active" : ""}`}
                        onClick={() => {
                          setPkgOrPid(p);
                          setPkgMenuOpen(false);
                        }}
                      >
                        {p}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          <div className="logcat-levels" role="group" aria-label="日志级别">
              {LOG_LEVELS.map((lv) => (
                <button
                  key={lv || "any"}
                  type="button"
                  data-lv={lv || "any"}
                  className={`logcat-lv${level === lv ? " active" : ""}`}
                  disabled={!snOk || busy}
                  onClick={() => setLevel(lv)}
                >
                  {lv || "全"}
                </button>
              ))}
            </div>
          </div>

          <div className="logcat-storage-strip">
            <label className="logcat-save" title="写入 userdata/logs/adb 本次目录">
              <input
                type="checkbox"
                checked={logAutoSave}
                disabled={wantLive}
                onChange={(e) => setLogAutoSave(e.target.checked)}
              />
              保存
            </label>
            {logAutoSave ? (
              <select
                className="field logcat-rotate-select"
                value={rotateMb}
                disabled={!snOk || busy}
                onChange={(e) => setRotateMb(Number(e.target.value) || 0)}
                title="持续抓取单文件达到大小后自动切分"
                aria-label="日志切分大小"
              >
                {ROTATE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              disabled={!snOk || busy || wantLive}
              onClick={() =>
                void wrap("新建保存目录…", async () => {
                  const session = await ensureLogSession(true);
                  setLogSaveFile("");
                  onStatus(session ? `新目录 ${shortPath(session, 48)}` : "已新建目录");
                })
              }
            >
              新目录
            </Button>
            <Button
              disabled={!snOk || busy || wantLive}
              onClick={() =>
                void wrap("清空缓冲区…", async () => {
                  const r = await api.logcatClear(deviceSn, logBuffer);
                  onStatus(r.message);
                })
              }
            >
              清缓冲
            </Button>
          </div>
        </div>

        <div className="logcat-toolbar-row logcat-toolbar-row-actions">
          <div className="logcat-primary">
            <Button
              disabled={!snOk || busy || wantLive}
              onClick={() =>
                void wrap("抓取 logcat…", async () => {
                  const session = logAutoSave
                    ? (await ensureLogSession(false)) || logSession
                    : logSession;
                  const targetFilter = parsePkgOrPid();
                  const r = await api.logcatDump(deviceSn, {
                    buffer: logBuffer,
                    tag,
                    level,
                    pid: targetFilter.pid,
                    package: targetFilter.package,
                    save: logAutoSave,
                    session,
                  });
                  const lines = r.text.split(/\r?\n/);
                  setLogcatLines(
                    lines.length > logcatMaxLines
                      ? lines.slice(-logcatMaxLines)
                      : lines,
                  );
                  logcatScroll.setFollow(true);
                  if (r.session) setLogSession(r.session);
                  if (r.saved_path) setLogSaveFile(r.saved_path);
                  onStatus(
                    r.saved_path
                      ? `已保存 ${shortPath(r.saved_path, 48)}${
                          r.truncated ? "（预览截断）" : ""
                        }`
                      : `抓取完成 ${r.chars} 字符${r.truncated ? "（已截断）" : ""}`,
                  );
                })
              }
            >
              抓取
            </Button>
            {!wantLive ? (
              <Button
                variant="primary"
                disabled={!snOk || busy}
                onClick={() => void startLogcatLive()}
              >
                持续
              </Button>
            ) : (
              <Button
                onClick={() => {
                  const wasLive = logLive;
                  stopLogcatLive({ closeWs: false, userStop: true });
                  if (!wasLive) {
                    toast.push("已停止 logcat 重连", "info");
                  }
                }}
              >
                {logLive ? "停止" : "停止重连"}
              </Button>
            )}
            <Button
              disabled={!snOk || busy}
              title="清空缓冲区并清空预览后立即持续抓取"
              onClick={() => void clearAndRestartLive()}
            >
              清屏重录
            </Button>
            <Button
              disabled={!snOk || (!logLive && !logcatLines.length)}
              title="点击直接插入时间戳标记 (Ctrl+M)；Shift+点击可输入自定义备注"
              onClick={(e) => {
                if (e.shiftKey) void promptAndInsertMark();
                else insertMark();
              }}
            >
              打标记
            </Button>
          </div>

          <div className="logcat-export">
            <div className="logcat-combo-wrap" ref={dumpsysComboRef}>
              <div className="logcat-dumpsys" title="填写或选择服务名后点 dumpsys 导出">
                <input
                  className="field logcat-dumpsys-input"
                  value={dumpsysSvc}
                  disabled={!snOk || busy}
                  onFocus={() => setDumpsysMenuOpen(true)}
                  onChange={(e) => setDumpsysSvc(e.target.value)}
                  placeholder="activity"
                  aria-label="dumpsys 服务名"
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || !snOk || busy) return;
                    e.preventDefault();
                    setDumpsysMenuOpen(false);
                    (e.currentTarget.parentElement?.querySelector(
                      ".logcat-dumpsys-btn",
                    ) as HTMLButtonElement | null)?.click();
                  }}
                />
                <Button
                  className="logcat-dumpsys-btn"
                  disabled={!snOk || busy}
                  onClick={() => {
                    setDumpsysMenuOpen(false);
                    void runExport(
                      `导出 dumpsys ${dumpsysSvc || "activity"}…`,
                      "dumpsys",
                      (session) =>
                        api.dumpsys(deviceSn, dumpsysSvc || "activity", true, { session }),
                    );
                  }}
                >
                  dumpsys
                </Button>
              </div>
              {dumpsysMenuOpen ? (
                <ul className="logcat-suggest-menu logcat-suggest-menu-sm" role="listbox">
                  {filteredDumpsysPresets.map((svc) => (
                    <li key={svc}>
                      <button
                        type="button"
                        className={`logcat-suggest-item mono${dumpsysSvc === svc ? " active" : ""}`}
                        onClick={() => {
                          setDumpsysSvc(svc);
                          setDumpsysMenuOpen(false);
                        }}
                      >
                        {svc}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button
              disabled={!snOk || busy}
              onClick={() =>
                void runExport("导出 getprop…", "getprop", (session) =>
                  api.getpropExport(deviceSn, true, { session }),
                )
              }
            >
              getprop
            </Button>
            <Button
              disabled={!snOk || busy}
              title="收集 crash logcat、ANR、Tombstones、activity/meminfo 与系统属性"
              onClick={() => void collectCrashScene()}
            >
              异常现场
            </Button>
            <Button
              disabled={!snOk || bugreportBusy}
              title="后台生成完整 bugreport（不影响同时抓取其他日志）"
              onClick={() => void runBugreport()}
            >
              {bugreportBusy ? "bugreport 生成中…" : "bugreport"}
            </Button>
          </div>
        </div>
      </div>

      {bugreportProg ? (
        <div className="logcat-bugreport-bar" role="status" aria-live="polite">
          <div className="logcat-bugreport-head">
            <span className="logcat-bugreport-title">正在生成 bugreport</span>
            <span className="logcat-bugreport-stage">
              {bugreportProg.stage === "pull"
                ? `正在拉取压缩包${bugreportProg.sizeBytes > 0 ? ` (${formatBugreportSize(bugreportProg.sizeBytes)})` : ""}`
                : "设备端正在收集系统状态与日志（通常需 1～3 分钟）"}
            </span>
            <span className="logcat-bugreport-meta">
              {bugreportProg.percent != null ? `${bugreportProg.percent}% · ` : ""}
              已耗时 {formatElapsed(bugreportProg.elapsedSec)}
            </span>
            <button
              type="button"
              className="logcat-bugreport-cancel"
              onClick={() => bugreportAbortRef.current?.abort()}
            >
              取消
            </button>
          </div>
          <div className="logcat-bugreport-track" aria-hidden>
            <span
              className={`logcat-bugreport-fill${bugreportProg.percent == null ? " indet" : ""}`}
              style={
                bugreportProg.percent != null
                  ? { width: `${Math.max(3, Math.min(100, bugreportProg.percent))}%` }
                  : undefined
              }
            />
          </div>
        </div>
      ) : null}

      <section className="logcat-log">
        <header className="logcat-log-head">
          <div className="logcat-log-title">
            <strong>日志预览</strong>
            <span className="logcat-log-badge">{lineLabel} 行</span>
            {logLive ? (
              <span className="logcat-log-badge is-live">
                <i className="logcat-live-dot" aria-hidden />
                LIVE
              </span>
            ) : null}
            {!logLive && wantLive ? (
              <span className="logcat-log-badge">重连中</span>
            ) : null}
            {logcatView.errorIndices.length > 0 ? (
              <span className="logcat-err-jump">
                <button
                  type="button"
                  className="logcat-err-count"
                  title="跳到下一条异常日志"
                  onClick={() => jumpToError(1)}
                >
                  异常 {logcatView.errorIndices.length}
                </button>
                <button
                  type="button"
                  className="logcat-err-step"
                  title="上一条异常"
                  onClick={() => jumpToError(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="logcat-err-step"
                  title="下一条异常"
                  onClick={() => jumpToError(1)}
                >
                  ↓
                </button>
              </span>
            ) : null}
            {saveHint ? (
              <button
                type="button"
                className="logcat-log-path"
                title={saveHint}
                onClick={() => void openLogDir(logSaveFile ? "file" : "session")}
              >
                {shortPath(saveHint, 36)}
              </button>
            ) : null}
          </div>
          <div className="logcat-log-actions">
            <button
              type="button"
              className={`logcat-flag-btn${wrapLines ? " on" : ""}`}
              title="长行自动折行（关闭可水平滚动对齐列）"
              aria-pressed={wrapLines}
              onClick={() => setWrapLines((v) => !v)}
            >
              折行
            </button>
            <Button
              className={logcatScroll.follow ? "on" : ""}
              title={
                logcatScroll.follow
                  ? "点击暂停跟随，冻结当前预览方便查看"
                  : "点击恢复跟随并同步最新日志"
              }
              onClick={() => {
                if (logcatScroll.follow) logcatScroll.setFollow(false);
                else logcatScroll.scrollToBottom();
              }}
            >
              {logcatScroll.follow
                ? "跟随"
                : pausedNewCount > 0
                  ? `停随 (+${pausedNewCount > 999 ? "999+" : pausedNewCount})`
                  : "停随"}
            </Button>
            <Button disabled={!logcatLines.length} onClick={() => saveLogcatPreview()}>
              导出
            </Button>
            <Button disabled={!logcatLines.length} onClick={() => clearLogcatView()}>
              清空
            </Button>
          </div>
        </header>

        <div className="logcat-preview-filterbar">
          <div className="logcat-quick-sev" role="group" aria-label="快捷级别筛选">
            <button
              type="button"
              className={`logcat-sev-chip${severityFilter === "all" ? " on" : ""}`}
              onClick={() => setSeverityFilter("all")}
            >
              全部
            </button>
            <button
              type="button"
              className={`logcat-sev-chip${severityFilter === "warn" ? " on" : ""}`}
              title="仅查看 W 及以上级别"
              onClick={() => setSeverityFilter("warn")}
            >
              W+
            </button>
            <button
              type="button"
              className={`logcat-sev-chip is-err-chip${severityFilter === "err" ? " on" : ""}`}
              title="仅查看 E / F / FATAL / ANR 异常日志"
              onClick={() => setSeverityFilter("err")}
            >
              仅异常
            </button>
          </div>

          <div className={`logcat-search-combo${logcatView.regexErr ? " is-invalid" : ""}`}>
            <input
              className="field logcat-search-input"
              placeholder="预览筛选关键词…"
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              aria-label="筛选日志"
              title={logcatView.regexErr ? "正则表达式语法有误" : "包含筛选"}
            />
            {logFilter ? (
              <button
                type="button"
                className="logcat-inline-clear"
                title="清除筛选"
                onClick={() => setLogFilter("")}
              >
                ×
              </button>
            ) : null}
            <button
              type="button"
              className={`logcat-inline-flag${filterRegex ? " on" : ""}`}
              title="正则匹配"
              aria-pressed={filterRegex}
              onClick={() => setFilterRegex((v) => !v)}
            >
              .*
            </button>
            <button
              type="button"
              className={`logcat-inline-flag${filterCase ? " on" : ""}`}
              title="区分大小写"
              aria-pressed={filterCase}
              onClick={() => setFilterCase((v) => !v)}
            >
              Aa
            </button>
          </div>

          <input
            className="field logcat-exclude-input"
            placeholder="排除关键词（空格分隔）…"
            value={excludeFilter}
            onChange={(e) => setExcludeFilter(e.target.value)}
            aria-label="排除关键词"
            title="排除包含这些词的行（多词用空格或逗号分隔）"
          />

          {logFilter || excludeFilter || severityFilter !== "all" ? (
            <button
              type="button"
              className="link-btn logcat-reset-filter"
              onClick={() => {
                setLogFilter("");
                setExcludeFilter("");
                setSeverityFilter("all");
              }}
            >
              重置筛选
            </button>
          ) : null}
        </div>
        {logcatView.items.length ? (
          <pre
            className={`log logcat-log-body logcat-lines-body${wrapLines ? "" : " is-nowrap"}`}
            ref={logcatScroll.ref}
            onScroll={logcatScroll.onScroll}
            onContextMenu={(e) => {
              const row = (e.target as HTMLElement | null)?.closest(
                "[data-line-idx]",
              ) as HTMLElement | null;
              if (!row) return;
              const idx = Number(row.dataset.lineIdx);
              const item = logcatView.items[idx];
              if (!item) return;
              e.preventDefault();
              const meta = parseLogLineMeta(item.text);
              const maxW = window.innerWidth - 200;
              const maxH = window.innerHeight - 240;
              setLineMenu({
                x: Math.max(8, Math.min(e.clientX, maxW)),
                y: Math.max(8, Math.min(e.clientY, maxH)),
                text: item.text,
                pid: meta.pid,
                tag: meta.tag,
              });
            }}
          >
            {logcatView.items.map((item, idx) => (
              <LogcatLineRow
                key={idx}
                idx={idx}
                text={item.text}
                tone={item.tone}
                activeJump={activeErrJump === idx}
                highlightRe={logcatHighlightRe}
              />
            ))}
          </pre>
        ) : logcatLines.length ? (
          <div className="logcat-log-empty">
            <EmptyState
              title="没有符合当前筛选条件的日志"
              description={`已缓存 ${logcatLines.length} 行日志，当前预览条件已全部过滤。`}
              action={
                <Button
                  onClick={() => {
                    setLogFilter("");
                    setExcludeFilter("");
                    setSeverityFilter("all");
                  }}
                >
                  重置预览筛选
                </Button>
              }
            />
          </div>
        ) : (
          <div className="logcat-log-empty">
            <EmptyState
              title={snOk ? "尚无 logcat 预览" : "未绑定设备"}
              description={
                snOk ? "点「抓取」或「持续」开始。" : "打开设备标签后可用。"
              }
            />
          </div>
        )}
      </section>

      {lineMenu ? (
        <div
          className="logcat-ctx-menu"
          style={{ left: lineMenu.x, top: lineMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="logcat-ctx-item"
            onClick={() => {
              const t = lineMenu.text;
              setLineMenu(null);
              void navigator.clipboard.writeText(t).then(
                () => toast.push("已复制日志行", "ok"),
                () => toast.push("复制失败", "err"),
              );
            }}
          >
            复制该行
          </button>
          {lineMenu.tag ? (
            <>
              <button
                type="button"
                className="logcat-ctx-item"
                onClick={() => {
                  const tg = lineMenu.tag;
                  setLineMenu(null);
                  setFilterRegex(false);
                  setLogFilter(tg);
                }}
              >
                预览筛选 Tag：{lineMenu.tag}
              </button>
              <button
                type="button"
                className="logcat-ctx-item"
                onClick={() => {
                  const tg = lineMenu.tag;
                  setLineMenu(null);
                  setTag(tg);
                }}
              >
                仅抓此 Tag 流：{lineMenu.tag}
              </button>
              <button
                type="button"
                className="logcat-ctx-item"
                onClick={() => {
                  const tg = lineMenu.tag;
                  setLineMenu(null);
                  setExcludeFilter((prev) =>
                    prev.trim() ? `${prev.trim()} ${tg}` : tg,
                  );
                }}
              >
                排除此 Tag：{lineMenu.tag}
              </button>
            </>
          ) : null}
          {lineMenu.pid ? (
            <button
              type="button"
              className="logcat-ctx-item"
              onClick={() => {
                const pid = lineMenu.pid;
                setLineMenu(null);
                setPkgOrPid(pid);
              }}
            >
              仅抓此 PID 流：{lineMenu.pid}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
