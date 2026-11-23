import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { reportActivity } from "../activity";
import { useStatusNotify, useToast } from "../components/toast";
import { Button } from "../ui";

type Props = {
  deviceSn: string;
  deviceOnline?: boolean;
  /** 当前标签且 Monkey 页可见时才探测设备端残留进程 */
  active?: boolean;
  onRunningChange?: (running: boolean) => void;
};

type MonkeyPrefs = {
  eventCount: string;
  throttleMs: string;
  seed: string;
  packages: string[];
  verbose: number;
  ignoreCrashes: boolean;
  ignoreTimeouts: boolean;
  ignoreSecurity: boolean;
  killAfterError: boolean;
  forever: boolean;
};

const PREFS_KEY = "toolbox.monkey.prefs.v2";

/** 目标包上限（与后端 monkey -p 上限一致） */
const MAX_PKGS = 50;

/** 一直运行：用上限事件数近似“直到手动停止”（约可跑很久） */
const FOREVER_EVENT_COUNT = "10000000";

const EVENT_PRESETS = [
  { label: "1千", value: "1000" },
  { label: "1万", value: "10000" },
  { label: "5万", value: "50000" },
  { label: "10万", value: "100000" },
] as const;

const THROTTLE_PRESETS = [
  { label: "0", value: "0" },
  { label: "100", value: "100" },
  { label: "300", value: "300" },
  { label: "500", value: "500" },
] as const;

const DEFAULT_PREFS: MonkeyPrefs = {
  eventCount: "10000",
  throttleMs: "300",
  seed: "",
  packages: [],
  verbose: 1,
  ignoreCrashes: true,
  ignoreTimeouts: true,
  ignoreSecurity: true,
  killAfterError: false,
  forever: false,
};

function shortSn(sn: string, max = 18): string {
  const s = sn.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function loadPrefs(): MonkeyPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<MonkeyPrefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      packages: Array.isArray(parsed.packages)
        ? parsed.packages.map(String).filter(Boolean).slice(0, MAX_PKGS)
        : [],
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: MonkeyPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "<1 秒";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `约 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `约 ${min} 分 ${rem} 秒` : `约 ${min} 分钟`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m ? `约 ${hr} 小时 ${m} 分` : `约 ${hr} 小时`;
}

function parseInjected(line: string): number | null {
  const m =
    line.match(/Events?\s+injected:\s*(\d+)/i) ||
    line.match(/Sending\s+Touch\s+\(ACTION_DOWN\):\s*(\d+)/i) ||
    line.match(/:\s*Sending\s+event\s+#(\d+)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function buildPreviewCmd(opts: {
  eventCount: string;
  throttleMs: string;
  seed: string;
  packages: string[];
  verbose: number;
  ignoreCrashes: boolean;
  ignoreTimeouts: boolean;
  ignoreSecurity: boolean;
  killAfterError: boolean;
}): string {
  const parts = ["monkey"];
  for (const p of opts.packages.slice(0, MAX_PKGS)) {
    if (/^[A-Za-z0-9._]+$/.test(p)) parts.push("-p", p);
  }
  const seedRaw = opts.seed.trim();
  if (seedRaw && /^-?\d+$/.test(seedRaw)) parts.push("-s", seedRaw);
  const throttle = Number.parseInt(opts.throttleMs.trim(), 10);
  if (Number.isFinite(throttle) && throttle > 0) {
    parts.push("--throttle", String(throttle));
  }
  if (opts.ignoreCrashes) parts.push("--ignore-crashes");
  if (opts.ignoreTimeouts) parts.push("--ignore-timeouts");
  if (opts.ignoreSecurity) parts.push("--ignore-security-exceptions");
  if (opts.killAfterError) parts.push("--kill-process-after-error");
  const v = Math.max(0, Math.min(3, opts.verbose | 0));
  if (v) parts.push("-" + "v".repeat(v));
  const count = Number.parseInt(opts.eventCount.trim(), 10);
  parts.push(Number.isFinite(count) && count > 0 ? String(count) : "?");
  return parts.join(" ");
}

export default function MonkeyPanel({
  deviceSn,
  deviceOnline = true,
  active = true,
  onRunningChange,
}: Props) {
  const setStatus = useStatusNotify();
  const toast = useToast();
  const snOk = Boolean(deviceSn) && deviceOnline;

  const initial = useRef(loadPrefs()).current;
  const [eventCount, setEventCount] = useState(initial.eventCount);
  const [throttleMs, setThrottleMs] = useState(initial.throttleMs);
  const [seed, setSeed] = useState(initial.seed);
  const [selectedPkgs, setSelectedPkgs] = useState<string[]>(initial.packages);
  const [pkgDraft, setPkgDraft] = useState("");
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [verbose, setVerbose] = useState(initial.verbose);
  const [ignoreCrashes, setIgnoreCrashes] = useState(initial.ignoreCrashes);
  const [ignoreTimeouts, setIgnoreTimeouts] = useState(initial.ignoreTimeouts);
  const [ignoreSecurity, setIgnoreSecurity] = useState(initial.ignoreSecurity);
  const [killAfterError, setKillAfterError] = useState(initial.killAfterError);
  const [forever, setForever] = useState(Boolean(initial.forever));
  const finiteEventCountRef = useRef(
    initial.forever && initial.eventCount === FOREVER_EVENT_COUNT
      ? "10000"
      : initial.eventCount || "10000",
  );

  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [pkgFilter, setPkgFilter] = useState("");
  const [pkgScope, setPkgScope] = useState<"third" | "all">("third");
  const [pkgBusy, setPkgBusy] = useState(false);

  const [jobId, setJobId] = useState("");
  const [running, setRunning] = useState(false);
  const [deviceMonkey, setDeviceMonkey] = useState(false);
  const [devicePids, setDevicePids] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [injected, setInjected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);

  const logCursorRef = useRef(0);
  const logElRef = useRef<HTMLPreElement | null>(null);
  const stickBottomRef = useRef(true);

  const onRunningChangeRef = useRef(onRunningChange);
  onRunningChangeRef.current = onRunningChange;

  const live = running || deviceMonkey;

  const eventNum = Number.parseInt(eventCount.trim(), 10);
  const throttleNum = Number.parseInt(throttleMs.trim(), 10);
  const etaLabel = forever
    ? "直到手动停止"
    : formatDuration(
        Number.isFinite(eventNum) &&
          eventNum > 0 &&
          Number.isFinite(throttleNum) &&
          throttleNum >= 0
          ? eventNum * throttleNum
          : NaN,
      );
  const progressPct =
    !forever &&
    running &&
    Number.isFinite(eventNum) &&
    eventNum > 0 &&
    injected > 0
      ? Math.min(100, Math.round((injected / eventNum) * 100))
      : null;

  const effectiveEventCount = forever ? FOREVER_EVENT_COUNT : eventCount;

  const previewCmd = useMemo(
    () =>
      buildPreviewCmd({
        eventCount: effectiveEventCount,
        throttleMs,
        seed,
        packages: selectedPkgs,
        verbose,
        ignoreCrashes,
        ignoreTimeouts,
        ignoreSecurity,
        killAfterError,
      }),
    [
      effectiveEventCount,
      throttleMs,
      seed,
      selectedPkgs,
      verbose,
      ignoreCrashes,
      ignoreTimeouts,
      ignoreSecurity,
      killAfterError,
    ],
  );
  const shownCmd = command || previewCmd;

  const filteredCatalog = useMemo(() => {
    const q = pkgFilter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((p) => p.toLowerCase().includes(q));
  }, [catalog, pkgFilter]);

  const selectedPkgSet = useMemo(() => new Set(selectedPkgs), [selectedPkgs]);
  const selectedInFilter = useMemo(
    () => filteredCatalog.filter((p) => selectedPkgSet.has(p)).length,
    [filteredCatalog, selectedPkgSet],
  );
  const filterAllSelected =
    filteredCatalog.length > 0 && selectedInFilter === filteredCatalog.length;

  useEffect(() => {
    savePrefs({
      eventCount: forever ? finiteEventCountRef.current : eventCount,
      throttleMs,
      seed,
      packages: selectedPkgs,
      verbose,
      ignoreCrashes,
      ignoreTimeouts,
      ignoreSecurity,
      killAfterError,
      forever,
    });
  }, [
    eventCount,
    throttleMs,
    seed,
    selectedPkgs,
    verbose,
    ignoreCrashes,
    ignoreTimeouts,
    ignoreSecurity,
    killAfterError,
    forever,
  ]);

  useEffect(() => {
    onRunningChangeRef.current?.(live);
    return () => onRunningChangeRef.current?.(false);
  }, [live]);

  useEffect(() => {
    const id = `monkey:${deviceSn || "none"}`;
    if (live && snOk) {
      reportActivity(
        id,
        true,
        deviceMonkey && !running
          ? `Monkey(设备) ${shortSn(deviceSn)}`
          : `Monkey ${shortSn(deviceSn)}`,
      );
    } else {
      reportActivity(id, false);
    }
    return () => reportActivity(id, false);
  }, [live, running, deviceMonkey, deviceSn, snOk]);

  useEffect(() => {
    setJobId("");
    setRunning(false);
    setStopping(false);
    setDeviceMonkey(false);
    setDevicePids([]);
    setMessage("");
    setCommand("");
    setLogs([]);
    setInjected(0);
    logCursorRef.current = 0;
    setCatalog([]);
    setCatalogLoaded(false);
    setPkgFilter("");
    setTagsExpanded(false);
  }, [deviceSn]);

  useEffect(() => {
    if (!snOk) {
      setDeviceMonkey(false);
      setDevicePids([]);
      return;
    }
    // 页签不可见且没有进行中的 Monkey 时不探测，避免后台空转 adb
    if (!active && !running && !stopping && !deviceMonkey) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const r = await api.monkeyActive(deviceSn);
        if (cancelled) return;
        const dm = Boolean(r.device_monkey?.running);
        const pids = r.device_monkey?.pids || [];
        setDeviceMonkey((prev) => (prev === dm ? prev : dm));
        setDevicePids((prev) =>
          prev.length === pids.length && prev.every((id, i) => id === pids[i])
            ? prev
            : pids,
        );

        if (r.active && r.job) {
          if (!running) {
            setJobId(r.job.job_id);
            setRunning(Boolean(r.job.running));
            setMessage(r.job.message || "");
            setCommand(r.job.command || "");
            const lines = r.job.logs || [];
            setLogs(lines);
            logCursorRef.current = r.job.log_cursor ?? lines.length;
            let maxInj = 0;
            for (const line of lines) {
              const n = parseInjected(line);
              if (n != null && n > maxInj) maxInj = n;
            }
            setInjected(maxInj);
            if (r.job.event_count) {
              const ec = String(r.job.event_count);
              setEventCount(ec);
              setForever(ec === FOREVER_EVENT_COUNT);
            }
            if (typeof r.job.throttle_ms === "number") {
              setThrottleMs(String(r.job.throttle_ms));
            }
            if (r.job.packages?.length) setSelectedPkgs(r.job.packages);
          }
        } else if (!running && dm) {
          setMessage(
            pids.length
              ? `设备上已有 Monkey（PID: ${pids.join(", ")}），可直接停止`
              : "设备上已有 Monkey，可直接停止",
          );
        } else if (!running && !dm && !stopping) {
          setMessage((prev) =>
            prev.includes("设备上已有") || prev.includes("可直接停止")
              ? ""
              : prev,
          );
        }
      } catch {
        /* ignore */
      }
    };
    void sync();
    // 无本机任务时定期探测设备端残留 monkey
    const t = window.setInterval(() => {
      if (!cancelled) void sync();
    }, running ? 8000 : 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snOk, deviceSn, running, stopping, active, deviceMonkey]);

  useEffect(() => {
    if (!jobId || !running) return;
    let cancelled = false;
    let inflight = false;
    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const r = await api.monkeyJob(jobId, logCursorRef.current);
        if (cancelled) return;
        setMessage(r.message || "");
        if (r.command) setCommand(r.command);
        setRunning(Boolean(r.running));
        if (!r.running) setStopping(false);
        if (r.logs?.length) {
          let maxInj = 0;
          for (const line of r.logs) {
            const n = parseInjected(line);
            if (n != null && n > maxInj) maxInj = n;
          }
          if (maxInj) setInjected((prev) => Math.max(prev, maxInj));
          setLogs((prev) => {
            const next = [...prev, ...r.logs];
            return next.length > 2500 ? next.slice(-2000) : next;
          });
        }
        logCursorRef.current = r.log_cursor;
        if (!r.running) {
          const msg =
            r.message ||
            (r.state === "done"
              ? "Monkey 完成"
              : r.state === "stopped"
                ? "Monkey 已停止"
                : "Monkey 结束");
          setStatus(msg);
        }
      } catch {
        /* ignore poll */
      } finally {
        inflight = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [jobId, running, setStatus]);

  useEffect(() => {
    const el = logElRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

  function parsePosInt(raw: string, label: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须为正整数`);
    return n;
  }

  function parseNonNegInt(raw: string, label: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${label} 必须为非负整数`);
    }
    return n;
  }

  function addPackage(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!/^[A-Za-z0-9._]+$/.test(name)) {
      setStatus(`非法包名: ${name}`);
      return;
    }
    if (selectedPkgs.includes(name)) {
      setPkgDraft("");
      return;
    }
    if (selectedPkgs.length >= MAX_PKGS) {
      toast.push(`最多只能选择 ${MAX_PKGS} 个目标包（已达上限）`, "warn");
      return;
    }
    setSelectedPkgs((prev) => [...prev, name]);
    setPkgDraft("");
  }

  function togglePackage(name: string) {
    if (selectedPkgs.includes(name)) {
      setSelectedPkgs((prev) => prev.filter((p) => p !== name));
      return;
    }
    if (selectedPkgs.length >= MAX_PKGS) {
      toast.push(`最多只能选择 ${MAX_PKGS} 个目标包（已达上限）`, "warn");
      return;
    }
    setSelectedPkgs((prev) => [...prev, name]);
  }

  function selectFilteredPackages() {
    const filtered = filteredCatalog;
    if (!filtered.length) return;
    if (selectedPkgs.length >= MAX_PKGS) {
      toast.push(`最多只能选择 ${MAX_PKGS} 个目标包（已达上限）`, "warn");
      return;
    }
    const keep = selectedPkgs.filter((p) => !filtered.includes(p));
    const room = Math.max(0, MAX_PKGS - keep.length);
    const take = filtered.slice(0, room);
    setSelectedPkgs([...keep, ...take]);
    if (take.length < filtered.length) {
      toast.push(
        `最多只能选择 ${MAX_PKGS} 个目标包，已选当前列表前 ${take.length} 个`,
        "warn",
      );
    } else {
      setStatus(`已全选当前 ${take.length} 个包`);
    }
  }

  function deselectFilteredPackages() {
    if (!filteredCatalog.length) return;
    const drop = new Set(filteredCatalog);
    setSelectedPkgs((prev) => prev.filter((p) => !drop.has(p)));
  }

  async function loadCatalog(scope: "third" | "all" = pkgScope) {
    if (!snOk || live) return;
    setPkgBusy(true);
    try {
      const r = await api.packages(deviceSn, "", scope);
      const pkgs = (r.packages || []).map(String).filter(Boolean);
      setCatalog(pkgs);
      setCatalogLoaded(true);
      setStatus(`已载入 ${pkgs.length} 个${scope === "third" ? "第三方" : ""}包`);
    } catch (e) {
      setStatus(`加载应用列表失败：${toErrorMessage(e)}`);
    } finally {
      setPkgBusy(false);
    }
  }

  async function copyText(text: string, okMsg: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMsg);
    } catch {
      setStatus("复制失败");
    }
  }

  async function start() {
    if (!snOk || live || busy) return;
    setBusy(true);
    try {
      // 启动前再确认设备上没有残留 monkey
      try {
        const active = await api.monkeyActive(deviceSn);
        if (active.device_monkey?.running) {
          const pids = active.device_monkey.pids || [];
          setDeviceMonkey(true);
          setDevicePids(pids);
          const msg = pids.length
            ? `设备上已有 Monkey（PID: ${pids.join(", ")}），请先停止`
            : "设备上已有 Monkey，请先停止";
          setMessage(msg);
          setStatus(msg);
          return;
        }
      } catch {
        /* continue */
      }
      const count = forever
        ? Number.parseInt(FOREVER_EVENT_COUNT, 10)
        : parsePosInt(eventCount, "事件数");
      const throttle = parseNonNegInt(throttleMs, "事件间隔");
      let seedVal: number | null = null;
      const seedRaw = seed.trim();
      if (seedRaw) {
        const n = Number.parseInt(seedRaw, 10);
        if (!Number.isFinite(n)) throw new Error("Seed 必须为整数");
        seedVal = n;
      }
      const r = await api.monkeyStart(deviceSn, {
        event_count: count,
        throttle_ms: throttle,
        packages: selectedPkgs,
        seed: seedVal,
        verbose,
        ignore_crashes: ignoreCrashes,
        ignore_timeouts: ignoreTimeouts,
        ignore_security: ignoreSecurity,
        kill_process_after: killAfterError,
      });
      logCursorRef.current = 0;
      setLogs([]);
      setInjected(0);
      setJobId(r.job_id);
      setRunning(true);
      setDeviceMonkey(false);
      setStopping(false);
      setMessage(r.message || "Monkey 已启动");
      setCommand(r.command || "");
      setStatus(r.message || "Monkey 已启动");
    } catch (e) {
      setStatus(`启动 Monkey 失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function detectDeviceMonkey(quiet = false) {
    if (!snOk) return;
    if (!quiet) setDetectBusy(true);
    try {
      const r = await api.monkeyActive(deviceSn);
      const dm = Boolean(r.device_monkey?.running);
      const pids = r.device_monkey?.pids || [];
      setDeviceMonkey(dm);
      setDevicePids(pids);
      if (r.active && r.job && !running) {
        setJobId(r.job.job_id);
        setRunning(Boolean(r.job.running));
      }
      if (!quiet) {
        setStatus(
          dm
            ? pids.length
              ? `检测到 Monkey（PID: ${pids.join(", ")}）`
              : "检测到设备上有 Monkey"
            : "设备上未发现 Monkey 进程",
        );
      }
      if (!running && dm) {
        setMessage(
          pids.length
            ? `设备上已有 Monkey（PID: ${pids.join(", ")}），可直接停止`
            : "设备上已有 Monkey，可直接停止",
        );
      }
    } catch (e) {
      if (!quiet) setStatus(`检测 Monkey 状态失败：${toErrorMessage(e)}`);
    } finally {
      if (!quiet) setDetectBusy(false);
    }
  }

  async function stop() {
    if ((!live && !jobId) || stopping) return;
    setStopping(true);
    setBusy(true);
    try {
      // 统一走设备停止：会停本机任务（若有）并清理设备残留
      const r = await api.monkeyStopDevice(deviceSn);
      setDeviceMonkey(Boolean(r.device_monkey?.running));
      setDevicePids(r.device_monkey?.pids || []);
      setMessage(r.message || "已停止 Monkey");
      setStatus(r.message || "已停止 Monkey");
      if (r.job_id) setJobId(r.job_id);
      if (!r.device_monkey?.running) {
        setRunning(false);
      }
    } catch (e) {
      setStatus(`停止 Monkey 失败：${toErrorMessage(e)}`);
    } finally {
      setStopping(false);
      setBusy(false);
    }
  }

  const residual = deviceMonkey && !running;
  const statusHint = !snOk
    ? deviceSn
      ? "设备离线"
      : "未选设备"
    : stopping
      ? message || "正在停止…"
      : residual
        ? devicePids.length
          ? `残留 PID ${devicePids.join(", ")}`
          : "设备上有残留 Monkey"
        : message || (running ? (forever ? "一直运行中" : "运行中") : "就绪");

  return (
    <div className="tool-panel monkey-panel">
      {residual ? (
        <div className="mk-banner">
          <span>
            <strong>设备残留 Monkey</strong>
            {devicePids.length ? ` · PID ${devicePids.join(", ")}` : null}
          </span>
          <Button variant="primary" disabled={stopping} onClick={() => void stop()}>
            {stopping ? "停止中…" : "停止残留"}
          </Button>
        </div>
      ) : null}

      <div className={`mk-controls${busy ? " is-busy" : ""}`}>
        <div className="mk-toolbar-row">
          <div className="mk-scope" role="tablist" aria-label="运行模式">
            <button
              type="button"
              role="tab"
              aria-selected={!forever}
              className={!forever ? "active" : undefined}
              disabled={live}
              onClick={() => {
                if (forever) {
                  setEventCount(finiteEventCountRef.current || "10000");
                  setForever(false);
                }
              }}
            >
              固定次数
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={forever}
              className={forever ? "active" : undefined}
              disabled={live}
              onClick={() => {
                if (!forever) {
                  if (eventCount !== FOREVER_EVENT_COUNT) {
                    finiteEventCountRef.current = eventCount || "10000";
                  }
                  setEventCount(FOREVER_EVENT_COUNT);
                  setForever(true);
                }
              }}
            >
              一直运行
            </button>
          </div>

          <div className="mk-param-strip">
            {!forever ? (
              <div className="mk-param-group">
                <span className="mk-param-label">事件</span>
                <input
                  className="field mk-param-input"
                  inputMode="numeric"
                  value={eventCount}
                  disabled={live}
                  aria-label="事件数"
                  onChange={(e) => setEventCount(e.target.value)}
                />
                <div className="mk-chips">
                  {EVENT_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      className={eventCount === p.value ? "active" : undefined}
                      disabled={live}
                      onClick={() => setEventCount(p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <span className="mk-param-label">事件 ∞</span>
            )}
            <div className="mk-param-group">
              <span className="mk-param-label">间隔 ms</span>
              <input
                className="field mk-param-input mk-param-sm"
                inputMode="numeric"
                value={throttleMs}
                disabled={live}
                aria-label="间隔毫秒"
                onChange={(e) => setThrottleMs(e.target.value)}
              />
              <div className="mk-chips">
                {THROTTLE_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={throttleMs === p.value ? "active" : undefined}
                    disabled={live}
                    onClick={() => setThrottleMs(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="mk-toolbar-row mk-toolbar-row-actions">
          {!live && !residual ? (
            <span className="mk-status-hint" title={statusHint}>
              {statusHint}
              {etaLabel !== "—" ? ` · ${etaLabel}` : ""}
            </span>
          ) : (
            <span className="mk-status-hint is-live" title={statusHint}>
              {statusHint}
              {progressPct != null ? ` · ${progressPct}%` : ""}
              {forever && running && injected > 0 ? ` · ${injected}` : ""}
            </span>
          )}
          <Button disabled={!snOk || detectBusy || stopping} onClick={() => void detectDeviceMonkey(false)}>
            {detectBusy ? "检查中…" : "检查"}
          </Button>
          <Button variant="primary" disabled={!snOk || live || busy} onClick={() => void start()}>
            开始
          </Button>
          <Button disabled={!snOk || !live || stopping} onClick={() => void stop()}>
            {stopping ? "停止中…" : "停止"}
          </Button>
        </div>
      </div>

      {progressPct != null ? (
        <div className="mk-progress" aria-hidden>
          <span style={{ width: `${progressPct}%` }} />
        </div>
      ) : null}

      <details className="mk-advanced">
        <summary>高级选项与命令</summary>
        <div className="mk-advanced-body">
          <div className="mk-adv-grid">
            <label className="mk-adv-field">
              <span>Seed</span>
              <input
                className="field"
                inputMode="numeric"
                value={seed}
                disabled={live}
                placeholder="随机"
                onChange={(e) => setSeed(e.target.value)}
              />
            </label>
            <label className="mk-adv-field">
              <span>详细级别</span>
              <select
                className="field"
                value={verbose}
                disabled={live}
                onChange={(e) => setVerbose(Number.parseInt(e.target.value, 10) || 0)}
              >
                <option value={0}>静默</option>
                <option value={1}>-v</option>
                <option value={2}>-vv</option>
                <option value={3}>-vvv</option>
              </select>
            </label>
          </div>
          <div className="mk-flags">
            <label>
              <input
                type="checkbox"
                checked={ignoreCrashes}
                disabled={live}
                onChange={(e) => setIgnoreCrashes(e.target.checked)}
              />
              忽略崩溃
            </label>
            <label>
              <input
                type="checkbox"
                checked={ignoreTimeouts}
                disabled={live}
                onChange={(e) => setIgnoreTimeouts(e.target.checked)}
              />
              忽略超时
            </label>
            <label>
              <input
                type="checkbox"
                checked={ignoreSecurity}
                disabled={live}
                onChange={(e) => setIgnoreSecurity(e.target.checked)}
              />
              忽略安全异常
            </label>
            <label>
              <input
                type="checkbox"
                checked={killAfterError}
                disabled={live}
                onChange={(e) => setKillAfterError(e.target.checked)}
              />
              出错后杀进程
            </label>
          </div>
          <div className="mk-cmd">
            <code title={shownCmd}>{shownCmd}</code>
            <Button disabled={!shownCmd} onClick={() => void copyText(shownCmd, "已复制命令")}>
              复制
            </Button>
          </div>
        </div>
      </details>

      <div className="mk-body">
        <section className="mk-pkg">
          <header className="mk-pkg-head">
            <strong>目标包</strong>
            <span className="mk-pkg-head-meta">
              {selectedPkgs.length > 3 ? (
                <button
                  type="button"
                  className="mk-link"
                  onClick={() => setTagsExpanded((v) => !v)}
                >
                  {tagsExpanded ? "收起已选" : `已选 ${selectedPkgs.length}/${MAX_PKGS}`}
                </button>
              ) : (
                <span>
                  {selectedPkgs.length
                    ? `${selectedPkgs.length}/${MAX_PKGS}`
                    : "未选 = 系统级"}
                </span>
              )}
              {selectedPkgs.length ? (
                <button
                  type="button"
                  className="mk-link"
                  disabled={live}
                  onClick={() => {
                    setSelectedPkgs([]);
                    setTagsExpanded(false);
                  }}
                >
                  清空
                </button>
              ) : null}
            </span>
          </header>

          {selectedPkgs.length > 0 && (selectedPkgs.length <= 3 || tagsExpanded) ? (
            <div className={`mk-tags${selectedPkgs.length > 3 ? " expanded" : ""}`}>
              {selectedPkgs.map((pkg) => (
                <button
                  key={pkg}
                  type="button"
                  disabled={live}
                  title={`${pkg}（点击移除）`}
                  onClick={() => togglePackage(pkg)}
                >
                  <span className="mk-tag-name">{pkg}</span>
                  <i aria-hidden>×</i>
                </button>
              ))}
            </div>
          ) : null}

          <div className="mk-pkg-strip">
            <div className="mk-scope mk-scope-sm" role="tablist" aria-label="包范围">
              <button
                type="button"
                role="tab"
                aria-selected={pkgScope === "third"}
                className={pkgScope === "third" ? "active" : undefined}
                disabled={live || pkgBusy}
                onClick={() => {
                  setPkgScope("third");
                  if (catalogLoaded) void loadCatalog("third");
                }}
              >
                第三方
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={pkgScope === "all"}
                className={pkgScope === "all" ? "active" : undefined}
                disabled={live || pkgBusy}
                onClick={() => {
                  setPkgScope("all");
                  if (catalogLoaded) void loadCatalog("all");
                }}
              >
                全部
              </button>
            </div>
            <div className="mk-pkg-search-wrap">
              <input
                className="field mk-pkg-search"
                value={pkgFilter}
                disabled={!catalog.length}
                placeholder={catalog.length ? "搜索包名…" : "先载入列表"}
                onChange={(e) => setPkgFilter(e.target.value)}
              />
              {pkgFilter ? (
                <button
                  type="button"
                  className="mk-search-clear"
                  title="清除搜索"
                  onClick={() => setPkgFilter("")}
                >
                  ×
                </button>
              ) : null}
            </div>
            <Button disabled={!snOk || live || pkgBusy} onClick={() => void loadCatalog()}>
              {pkgBusy ? "…" : catalog.length ? "刷新" : "载入"}
            </Button>
          </div>

          <div className="mk-list-wrap">
            {catalog.length ? (
              <>
                <div className="mk-list-meta">
                  <span>
                    {filteredCatalog.length}/{catalog.length}
                    {selectedInFilter ? ` · 已选 ${selectedInFilter}` : ""}
                  </span>
                  <div className="mk-list-actions">
                    {!filterAllSelected ? (
                      <button
                        type="button"
                        className="mk-link"
                        disabled={live || !filteredCatalog.length}
                        onClick={selectFilteredPackages}
                      >
                        全选当前
                      </button>
                    ) : null}
                    {selectedInFilter > 0 ? (
                      <button
                        type="button"
                        className="mk-link"
                        disabled={live}
                        onClick={deselectFilteredPackages}
                      >
                        取消全选
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mk-list" role="listbox" aria-label="包列表">
                  {filteredCatalog.length ? (
                    filteredCatalog.map((pkg) => {
                      const on = selectedPkgSet.has(pkg);
                      return (
                        <button
                          key={pkg}
                          type="button"
                          role="option"
                          aria-selected={on}
                          className={on ? "on" : undefined}
                          disabled={live}
                          onClick={() => togglePackage(pkg)}
                        >
                          <span className={`mk-check${on ? " on" : ""}`} />
                          <span>{pkg}</span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="mk-empty">无匹配包名</div>
                  )}
                </div>
              </>
            ) : (
              <div className="mk-empty">
                <span>点击上方「载入」获取设备应用</span>
              </div>
            )}
          </div>

          <div className="mk-add">
            <input
              className="field"
              value={pkgDraft}
              disabled={live}
              placeholder="手动添加 com.example.app"
              onChange={(e) => setPkgDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPackage(pkgDraft);
                }
              }}
            />
            <Button disabled={live || !pkgDraft.trim()} onClick={() => addPackage(pkgDraft)}>
              添加
            </Button>
          </div>
        </section>

        <section className="mk-log">
          <header className="mk-log-head">
            <div className="mk-log-title">
              <strong>输出</strong>
              {running ? (
                <span className="mk-badge live">
                  {forever
                    ? injected > 0
                      ? `${injected}`
                      : "LIVE"
                    : progressPct != null
                      ? `${progressPct}%`
                      : "LIVE"}
                </span>
              ) : residual ? (
                <span className="mk-badge warn">残留</span>
              ) : logs.length ? (
                <span className="mk-badge">{logs.length}</span>
              ) : null}
            </div>
            <div className="mk-log-actions">
              <Button disabled={!logs.length} onClick={() => void copyText(logs.join("\n"), "已复制日志")}>
                复制
              </Button>
              <Button
                disabled={!logs.length}
                onClick={() => {
                  setLogs([]);
                  setInjected(0);
                }}
              >
                清空
              </Button>
            </div>
          </header>
          {logs.length ? (
            <pre
              ref={logElRef}
              className="mk-log-body"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickBottomRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
            >
              {logs.join("\n")}
            </pre>
          ) : (
            <div className="mk-log-empty">
              {residual
                ? "检测到残留进程，点「停止残留」即可清理。"
                : "配置参数后点「开始」，日志会显示在这里。"}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
