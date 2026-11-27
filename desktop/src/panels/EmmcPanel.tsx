import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { reportActivity } from "../activity";
import { useDialog } from "../components/dialog";
import { useStatusNotify, useToast } from "../components/toast";
import Modal from "../components/Modal";
import { useStickyLogScroll } from "../hooks/useStickyLogScroll";
import { Button, EmptyState } from "../ui";

type Props = {
  deviceSn: string;
  browseOnly?: boolean;
  /** 设备当前是否在线；断开后禁止启动测试 */
  deviceOnline?: boolean;
  /** 当前页且该会话在前台时才拉步骤和报告 */
  active?: boolean;
  /** 测试运行状态变化（供父级拦截关闭标签等） */
  onRunningChange?: (running: boolean) => void;
  /** 已有测试记录（启动过任务或已有日志）时通知外层，避免断连遮挡结果 */
  onTestedChange?: (tested: boolean) => void;
};

type Step = { id: string; label: string };

type HeaderDraft = {
  flow_no: string;
  import_project: string;
  internal_model: string;
  emmc_brand: string;
  emmc_capacity_gb: string;
  read_speed_mbs: string;
  write_speed_mbs: string;
  emmc_model: string;
  sw_test_userdebug: string;
  emmc_spec: string;
  gota_version: string;
  tester: string;
  test_time: string;
  remarks: string;
  ab_upgrade: boolean;
};

const EMPTY_HEADER: HeaderDraft = {
  flow_no: "",
  import_project: "",
  internal_model: "",
  emmc_brand: "",
  emmc_capacity_gb: "",
  read_speed_mbs: "",
  write_speed_mbs: "",
  emmc_model: "",
  sw_test_userdebug: "",
  emmc_spec: "",
  gota_version: "",
  tester: "",
  test_time: "",
  remarks: "",
  ab_upgrade: true,
};

function headerAbOn(
  header: Record<string, string | boolean> | undefined,
): boolean | null {
  if (!header || header.ab_upgrade === undefined || header.ab_upgrade === "") {
    return null;
  }
  const v = header.ab_upgrade;
  if (v === false || v === "false" || v === "0") return false;
  if (v === true || v === "true" || v === "1") return true;
  return Boolean(v);
}

function shortPath(p: string, max = 48): string {
  const s = (p || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

export default function EmmcPanel({
  deviceSn,
  browseOnly,
  deviceOnline = true,
  active = true,
  onRunningChange,
  onTestedChange,
}: Props) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [flowNo, setFlowNo] = useState(() => {
    try {
      return localStorage.getItem("emmc.lastFlowNo") || "";
    } catch {
      return "";
    }
  });
  const [importProject, setImportProject] = useState("");
  const [jobId, setJobId] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reportPath, setReportPath] = useState("");
  const setStatus = useStatusNotify();
  const toast = useToast();
  const dialog = useDialog();

  const [loopNum, setLoopNum] = useState("1000");
  const [stressMode, setStressMode] = useState<"count" | "minutes">("count");
  const [stressMinutes, setStressMinutes] = useState("60");
  const [iozoneMb, setIozoneMb] = useState("100");
  const [iozoneWriteMin, setIozoneWriteMin] = useState("100");
  const [iozoneReadMin, setIozoneReadMin] = useState("100");
  const [rebootMode, setRebootMode] = useState<"hours" | "count">("hours");
  const [rebootHours, setRebootHours] = useState("1");
  const [rebootCount, setRebootCount] = useState("10");
  const [bootTimeoutSec, setBootTimeoutSec] = useState("600");
  const [rpmbMin, setRpmbMin] = useState("720");
  const [otaMode, setOtaMode] = useState<"count" | "minutes">("count");
  const [otaCount, setOtaCount] = useState("500");
  const [otaRetry, setOtaRetry] = useState("3");
  const [otaMaxRun, setOtaMaxRun] = useState("1440");
  const [otaTimeout, setOtaTimeout] = useState("10");
  const [otaInterval, setOtaInterval] = useState("10");
  const [otaPath, setOtaPath] = useState("");
  const [stopOnFail, setStopOnFail] = useState(false);
  const [abUpgrade, setAbUpgrade] = useState(true);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [headerBusy, setHeaderBusy] = useState(false);
  const [headerStartPending, setHeaderStartPending] = useState(false);
  const [startLoginOpen, setStartLoginOpen] = useState(false);
  const [headerErr, setHeaderErr] = useState("");
  const [headerDraft, setHeaderDraft] = useState<HeaderDraft>(EMPTY_HEADER);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [feishuReportUrl, setFeishuReportUrl] = useState("");
  const [feishuUserName, setFeishuUserName] = useState("");
  const [feishuUserOpenId, setFeishuUserOpenId] = useState("");
  const [feishuMsg, setFeishuMsg] = useState("");
  const [oaLoggedIn, setOaLoggedIn] = useState(false);
  const [oaUserName, setOaUserName] = useState("");
  const [oaBusy, setOaBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState<{
    installed: boolean;
    state: string;
    current_round?: number;
    target_count?: number;
    success_rounds?: number;
    fail_rounds?: number;
    anomaly_count?: number;
    can_self_reboot?: boolean;
    ip?: string;
    adb_tcp_port?: string;
    last_boot_reason?: string;
    stop_reason?: string;
  } | null>(null);
  const feishuLoginCancelRef = useRef(false);
  const feishuPopupRef = useRef<Window | null>(null);
  const [stepResults, setStepResults] = useState<Record<string, string>>({});
  const [stepProgress, setStepProgress] = useState<
    Record<string, { current: number; total: number; text: string }>
  >({});
  const [currentStep, setCurrentStep] = useState("");
  const [stepsDone, setStepsDone] = useState(0);
  const [stepsTotal, setStepsTotal] = useState(0);
  const logCursorRef = useRef(0);
  const logText = useMemo(() => {
    const out: string[] = [];
    let suppressIozoneExtraRound = false;
    let iozoneRateSeen = false;
    for (const line of logs) {
      if (/第\s*[23]\s*次\s*iozone读写速度测试正在进行/.test(line)) {
        suppressIozoneExtraRound = true;
        continue;
      }
      if (suppressIozoneExtraRound) {
        if (
          line.includes("平均测试结果:") ||
          line.includes("测试结果:") ||
          line.includes("结果已写入") ||
          line.includes("测试日志图片:")
        ) {
          suppressIozoneExtraRound = false;
        } else {
          continue;
        }
      }
      if (/INFO\s+\{'write_rate':/.test(line)) {
        if (iozoneRateSeen) continue;
        iozoneRateSeen = true;
        continue;
      }
      out.push(
        line
          .replace(/第\s*1\s*次\s*iozone读写速度测试正在进行/, "iozone读写速度测试正在进行")
          .replace("INFO 平均测试结果:", "INFO 测试结果:")
          .replace(/平均\s*write_rate/g, "write_rate"),
      );
    }
    return out.join("\n");
  }, [logs]);
  const logScroll = useStickyLogScroll(logText);

  const snOk = Boolean(deviceSn) && !browseOnly && deviceOnline;
  const on = useMemo(
    () => ({
      stress: Boolean(selected.stress),
      iozone: Boolean(selected.iozone),
      reboot: Boolean(selected.reboot),
      rpmb: Boolean(selected.rpmb),
      ota: Boolean(selected.ota),
    }),
    [selected],
  );
  const pickedCount = useMemo(
    () => steps.filter((s) => selected[s.id]).length,
    [steps, selected],
  );
  const stressStats = useMemo(() => {
    let writePass = 0;
    let readPass = 0;
    let checkPass = 0;
    let writeFail = 0;
    let readFail = 0;
    let checkFail = 0;
    let fromSummary = false;
    for (const line of logs) {
      const summary = line.match(
        /成功次数\s+write=(\d+)\s+read=(\d+)\s+check=(\d+)\s*\|\s*失败次数\s+write=(\d+)\s+read=(\d+)\s+check=(\d+)/,
      );
      if (summary) {
        writePass = Number(summary[1]);
        readPass = Number(summary[2]);
        checkPass = Number(summary[3]);
        writeFail = Number(summary[4]);
        readFail = Number(summary[5]);
        checkFail = Number(summary[6]);
        fromSummary = true;
        continue;
      }
      if (fromSummary) continue;
      if (line.includes("DEBUG write successful")) writePass += 1;
      else if (line.includes("ERROR write fail")) writeFail += 1;
      else if (line.includes("DEBUG read successful")) readPass += 1;
      else if (line.includes("ERROR read fail")) readFail += 1;
      else if (line.includes("DEBUG check successful")) checkPass += 1;
      else if (line.includes("ERROR check fail")) checkFail += 1;
    }
    return { writePass, readPass, checkPass, writeFail, readFail, checkFail };
  }, [logs]);

  const stepsLoadedRef = useRef(false);

  useEffect(() => {
    if (!active || stepsLoadedRef.current) return;
    let cancelled = false;
    void api
      .emmcSteps()
      .then((r) => {
        if (cancelled) return;
        stepsLoadedRef.current = true;
        setSteps((prev) => (prev.length ? prev : r.steps));
        setSelected((prev) => {
          if (Object.keys(prev).length) return prev;
          const init: Record<string, boolean> = {};
          for (const s of r.steps) init[s.id] = s.id !== "ota";
          return init;
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(`加载 eMMC 步骤失败：${toErrorMessage(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [active, setStatus]);

  const reportLoadedRef = useRef("");

  useEffect(() => {
    if (!active) return;
    const flow = flowNo.trim();
    if (!flow || reportLoadedRef.current === flow) return;
    let cancelled = false;
    void api
      .emmcReport(flow)
      .then((r) => {
        if (cancelled) return;
        reportLoadedRef.current = flow;
        setReportPath(r.path || "");
        setImportProject(String(r.header?.import_project || ""));
        setFeishuReportUrl(r.feishu_report_url || "");
        const ab = headerAbOn(r.header);
        if (ab != null) setAbUpgrade(ab);
      })
      .catch(() => {
        /* 报告尚未创建时保持上次/默认 */
      });
    return () => {
      cancelled = true;
    };
  }, [active, flowNo]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api
      .emmcFeishuConfig(flowNo.trim())
      .then((cfg) => {
        if (cancelled) return;
        setFeishuUserName(cfg.user_name || "");
        setFeishuUserOpenId(cfg.user_open_id || "");
        if (flowNo.trim() && cfg.flow_report_url) {
          setFeishuReportUrl(cfg.flow_report_url);
        }
      })
      .catch(() => {
        /* 飞书配置查询失败时保持未登录展示 */
      });
    void api
      .emmcTideOaStatus()
      .then((oa) => {
        if (cancelled) return;
        setOaLoggedIn(Boolean(oa.logged_in));
        setOaUserName(oa.user_name || oa.email || "");
      })
      .catch(() => {
        /* Tide OA 状态查询失败时保持未登录展示 */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!jobId || !running) return;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = () => {
      if (cancelled) return;
      const delay = !active || document.hidden ? 4000 : 1000;
      timer = window.setTimeout(() => {
        void pollOnce();
      }, delay);
    };
    const pollOnce = async () => {
      if (cancelled) return;
      try {
        const r = await api.emmcStatus(jobId, logCursorRef.current);
        if (cancelled) return;
        const incoming = r.logs || [];
        if (typeof r.log_cursor === "number") {
          logCursorRef.current = r.log_cursor;
          if (incoming.length > 0) {
            setLogs((prev) => {
              const merged = prev.concat(incoming);
              return merged.length > 400 ? merged.slice(-400) : merged;
            });
          }
        } else {
          setLogs((prev) =>
            prev.length === incoming.length &&
            prev[0] === incoming[0] &&
            prev[prev.length - 1] === incoming[incoming.length - 1]
              ? prev
              : incoming,
          );
        }
        setRunning(r.running);
        if (!r.running) {
          setStopping(false);
        }
        if (r.report_path) {
          setReportPath((prev) => (prev === r.report_path ? prev : r.report_path));
        }
        if (r.step_results) {
          const next = r.step_results;
          setStepResults((prev) => {
            const keys = Object.keys(next);
            if (
              keys.length === Object.keys(prev).length &&
              keys.every((k) => prev[k] === next[k])
            ) {
              return prev;
            }
            return { ...next };
          });
        }
        if (r.step_progress) {
          const next = r.step_progress;
          setStepProgress((prev) => {
            const keys = Object.keys(next);
            if (
              keys.length === Object.keys(prev).length &&
              keys.every(
                (k) =>
                  prev[k]?.current === next[k]?.current &&
                  prev[k]?.total === next[k]?.total &&
                  prev[k]?.text === next[k]?.text,
              )
            ) {
              return prev;
            }
            return { ...next };
          });
        }
        setCurrentStep(r.current_step || "");
        setStepsDone(Number(r.steps_done) || 0);
        setStepsTotal(Number(r.steps_total) || 0);
        if (!r.running) {
          const rp = r.report_path || "";
          setStatus(
            r.error
              ? r.error
              : r.ok
                ? `完成 Pass · ${shortPath(rp, 40)}`
                : `完成 Fail · ${shortPath(rp, 40)}`,
          );
        }
      } catch {
        /* ignore poll */
      } finally {
        schedule();
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [jobId, running, active]);

  const onRunningChangeRef = useRef(onRunningChange);
  onRunningChangeRef.current = onRunningChange;

  useEffect(() => {
    onRunningChangeRef.current?.(running || starting);
    return () => onRunningChangeRef.current?.(false);
  }, [running, starting]);

  const onTestedChangeRef = useRef(onTestedChange);
  onTestedChangeRef.current = onTestedChange;
  const hasTested = Boolean(jobId) || logs.length > 0;

  useEffect(() => {
    onTestedChangeRef.current?.(hasTested);
    return () => onTestedChangeRef.current?.(false);
  }, [hasTested]);

  useEffect(() => {
    const id = `emmc:${deviceSn || "none"}`;
    const snOkLocal = Boolean(deviceSn) && !browseOnly && deviceOnline;
    if (running && snOkLocal) {
      const short =
        deviceSn.length <= 18 ? deviceSn : `${deviceSn.slice(0, 17)}…`;
      reportActivity(id, true, `eMMC测试 ${short}`);
    } else {
      reportActivity(id, false);
    }
    return () => reportActivity(id, false);
  }, [running, deviceSn, browseOnly, deviceOnline]);

  function parsePosInt(raw: string, label: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须为正整数`);
    return n;
  }

  function parseNonNegInt(raw: string, label: string): number {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label} 必须为非负整数`);
    return n;
  }

  function parsePosFloat(raw: string, label: string): number {
    const n = Number.parseFloat(raw.trim());
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须为正数`);
    return n;
  }

  function setAll(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const s of steps) next[s.id] = checked;
    setSelected(next);
  }

  async function openAny(path: string) {
    const trimmed = path.trim();
    if (!trimmed) {
      setStatus("路径为空");
      return;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      window.open(trimmed, "_blank", "noopener,noreferrer");
      setStatus(`已在浏览器打开 ${shortPath(trimmed)}`);
      return;
    }
    try {
      if (window.toolbox?.openPath) {
        const res = await window.toolbox.openPath(trimmed);
        if (res.ok) {
          setStatus(res.message || `已打开 ${shortPath(trimmed)}`);
          return;
        }
        const msg = res.message || "打开目录失败";
        setStatus(`打开路径失败：${msg}`);
        toast.push(`打开路径失败：${msg}`, "err");
        return;
      }
      const r = await api.openPath(trimmed);
      setStatus(r.message || `已打开 ${shortPath(trimmed)}`);
    } catch (e) {
      const msg = `打开路径失败：${toErrorMessage(e)}`;
      setStatus(msg);
      toast.push(msg, "err");
    }
  }

  async function openReportsDir() {
    try {
      const r = await api.emmcDirs();
      await openAny(r.reports_dir);
    } catch (e) {
      const msg = `打开本地报告目录失败：${toErrorMessage(e)}`;
      setStatus(msg);
      toast.push(msg, "err");
    }
  }

  async function openOnlineReport() {
    const url = feishuReportUrl.trim();
    if (!url) return;
    await openAny(url);
  }

  async function copyFlowLocalToFeishu() {
    const flow = flowNo.trim();
    if (!flow || !reportPath) return;
    if (!feishuUserOpenId) {
      setStatus("请先扫码登录飞书，再复制本地报告到飞书");
      void loginFeishuQr();
      return;
    }
    setFeishuBusy(true);
    setStatus(`正在将流程 ${flow} 的本地报告复制到飞书...`);
    try {
      const r = await api.emmcCopyFlowLocalToFeishu(flow);
      if (r.url) setFeishuReportUrl(r.url);
      const msg = r.url
        ? `已将流程 ${flow} 本地报告复制到飞书：${r.url}`
        : `已将流程 ${flow} 本地报告复制到飞书`;
      setStatus(msg);
      setFeishuMsg(msg);
    } catch (err) {
      setStatus(`复制本地报告到飞书失败：${toErrorMessage(err)}`);
    } finally {
      setFeishuBusy(false);
    }
  }

  async function openLogsDir() {
    try {
      const r = await api.emmcDirs();
      await openAny(r.logs_dir);
    } catch (e) {
      const msg = `打开日志目录失败：${toErrorMessage(e)}`;
      setStatus(msg);
      toast.push(msg, "err");
    }
  }

  async function openHeaderEditor(forStart = false, testerOverride = "") {
    const flow = flowNo.trim();
    setHeaderStartPending(forStart);
    setHeaderErr("");
    setHeaderBusy(true);
    try {
      let h: Record<string, string | boolean> = {};
      if (flow) {
        try {
          const r = await api.emmcReport(flow);
          setReportPath(r.path);
          h = r.header || {};
        } catch {
          /* 流程尚未建表时用空表头 */
        }
      }
      setHeaderDraft({
        flow_no: flow,
        import_project: String(h.import_project || ""),
        internal_model: String(h.internal_model || ""),
        emmc_brand: String(h.emmc_brand || ""),
        emmc_capacity_gb: String(h.emmc_capacity_gb || ""),
        read_speed_mbs: String(h.read_speed_mbs || ""),
        write_speed_mbs: String(h.write_speed_mbs || ""),
        emmc_model: String(h.emmc_model || ""),
        sw_test_userdebug: String(h.sw_test_userdebug || ""),
        emmc_spec: String(h.emmc_spec || ""),
        gota_version: String(h.gota_version || ""),
        tester: String(testerOverride || h.tester || feishuUserName || ""),
        test_time:
          String(h.test_time || "") ||
          new Date().toISOString().slice(0, 19).replace("T", " "),
        remarks: String(h.remarks || ""),
        ab_upgrade: h.ab_upgrade !== false,
      });
      const ab = headerAbOn(h);
      if (ab != null) setAbUpgrade(ab);
      setHeaderOpen(true);
      if (oaLoggedIn && flow && !String(h.import_project || "").trim()) {
        void pullHeaderFromOa(flow);
      }
    } catch (e) {
      setStatus(`读取报告表头失败：${toErrorMessage(e)}`);
    } finally {
      setHeaderBusy(false);
    }
  }

  async function saveHeader() {
    const flow = headerDraft.flow_no.trim();
    const project = headerDraft.import_project.trim();
    if (!flow) {
      const msg = "请填写流程号（必填）";
      setHeaderErr(msg);
      toast.push(msg, "warn");
      return;
    }
    if (!project) {
      const msg = "请填写「导入项目」（必填）";
      setHeaderErr(msg);
      toast.push(msg, "warn");
      return;
    }
    setHeaderErr("");
    setHeaderBusy(true);
    const shouldStart = headerStartPending;
    try {
      const { flow_no: _omit, ...metaFields } = headerDraft;
      const r = await api.emmcSaveReportHeader({
        flow_no: flow,
        ...metaFields,
      });
      setFlowNo(flow);
      setImportProject(project);
      try {
        localStorage.setItem("emmc.lastFlowNo", flow);
      } catch {
        /* ignore */
      }
      reportLoadedRef.current = flow;
      setReportPath(r.path);
      setHeaderOpen(false);
      setHeaderStartPending(false);
      setAbUpgrade(Boolean(headerDraft.ab_upgrade));
      setStatus(r.message);
      setLogs((prev) => [...prev, `INFO ${r.message}`]);
      if (shouldStart) {
        await executeStart(flow, Boolean(headerDraft.ab_upgrade));
      }
    } catch (e) {
      const msg = `保存报告表头失败：${toErrorMessage(e)}`;
      setHeaderErr(msg);
      setStatus(msg);
    } finally {
      setHeaderBusy(false);
    }
  }

  function cancelFeishuLogin() {
    feishuLoginCancelRef.current = true;
    try {
      if (feishuPopupRef.current && !feishuPopupRef.current.closed) {
        feishuPopupRef.current.close();
      }
    } catch {
      /* ignore */
    }
    void window.toolbox?.closeOAuthWindow?.();
    feishuPopupRef.current = null;
    setFeishuBusy(false);
  }

  async function loginFeishuQr(): Promise<string | null> {
    feishuLoginCancelRef.current = false;
    setFeishuBusy(true);
    setFeishuMsg("");
    try {
      await api.emmcSaveFeishuConfig({
        flow_no: flowNo.trim() || "1",
        report_url: feishuReportUrl.trim() || undefined,
        notify_enabled: true,
      });
      const r = await api.emmcFeishuOAuthUrl();
      if (feishuLoginCancelRef.current) return null;
      setFeishuMsg(`请在弹出的飞书页面扫码确认（回调地址：${r.redirect_uri}）`);
      let electronWinClosed = false;
      let popup: Window | null = null;
      if (window.toolbox?.openOAuthWindow) {
        void window.toolbox
          .openOAuthWindow({
            url: r.url,
            title: "飞书扫码登录",
            callbackPrefix: r.redirect_uri,
          })
          .then(() => {
            electronWinClosed = true;
          });
      } else {
        popup = window.open(r.url, "_blank", "width=520,height=700");
        feishuPopupRef.current = popup;
      }
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (feishuLoginCancelRef.current) return null;
        const popupClosed = electronWinClosed || Boolean(popup && popup.closed);
        if (i % 3 === 2 || popupClosed) {
          const cfg = await api.emmcFeishuConfig(flowNo.trim() || "1");
          if (feishuLoginCancelRef.current) return null;
          if (cfg.user_logged_in) {
            const name = cfg.user_name || cfg.user_open_id || "";
            setFeishuUserName(cfg.user_name || "");
            setFeishuUserOpenId(cfg.user_open_id || "");
            const okMsg = `飞书已登录：${name}`;
            setFeishuMsg(okMsg);
            setStatus(okMsg);
            return name;
          }
          if (popupClosed) {
            setFeishuMsg("已取消飞书扫码登录");
            setStatus("已取消飞书扫码登录");
            return null;
          }
        }
      }
      setFeishuMsg("飞书登录等待超时，请重试");
      return null;
    } catch (e) {
      setFeishuMsg(toErrorMessage(e));
      return null;
    } finally {
      feishuPopupRef.current = null;
      setFeishuBusy(false);
    }
  }

  async function logoutFeishu() {
    setFeishuBusy(true);
    try {
      await api.emmcFeishuLogout(flowNo.trim() || "1");
      setFeishuUserName("");
      setFeishuUserOpenId("");
      setFeishuMsg("已退出当前飞书账号");
    } catch (e) {
      setFeishuMsg(toErrorMessage(e));
    } finally {
      setFeishuBusy(false);
    }
  }

  async function loginTideOa() {
    if (!window.toolbox?.tideOaLogin) {
      toast.push("请在桌面端客户端中使用 Tide OA 自动扫码登录", "warn");
      return;
    }
    setOaBusy(true);
    setStatus("请在弹出的 Tide OA 窗口完成飞书扫码登录...");
    try {
      const res = await window.toolbox.tideOaLogin();
      if (!res?.ok || !res.token) {
        setStatus(res?.message || "已取消 Tide OA 登录");
        return;
      }
      const saved = await api.emmcTideOaSaveToken(res.token, res.wsid || "2");
      setOaLoggedIn(Boolean(saved.logged_in));
      const name = saved.user_name || saved.email || "已登录";
      setOaUserName(name);
      const okMsg = `Tide OA 已登录：${name}`;
      setStatus(okMsg);
      toast.push(okMsg, "ok");
    } catch (e) {
      const msg = `Tide OA 登录失败：${toErrorMessage(e)}`;
      setStatus(msg);
      toast.push(msg, "err");
    } finally {
      setOaBusy(false);
    }
  }

  async function logoutTideOa() {
    setOaBusy(true);
    try {
      await api.emmcTideOaLogout();
      setOaLoggedIn(false);
      setOaUserName("");
      setStatus("已退出 Tide OA 登录");
    } catch (e) {
      setStatus(`退出 Tide OA 失败：${toErrorMessage(e)}`);
    } finally {
      setOaBusy(false);
    }
  }

  useEffect(() => {
    if (!active || !snOk) {
      setAgentStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.emmcAgentStatus(deviceSn);
        if (cancelled) return;
        if (!running && r.installed && r.state !== "IDLE") {
          const resetRes = await api.emmcAgentReset(deviceSn);
          if (!cancelled && resetRes.status) {
            setAgentStatus(resetRes.status as typeof agentStatus);
            return;
          }
        }
        setAgentStatus(r);
      } catch {
        /* ignore */
      }
    })();
    const timer = window.setInterval(() => {
      void refreshAgentStatus(true);
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, snOk, deviceSn]);

  async function refreshAgentStatus(silent = false) {
    if (!snOk) return;
    try {
      const r = await api.emmcAgentStatus(deviceSn);
      setAgentStatus(r);
    } catch (e) {
      if (!silent) toast.push(`查询设备端 Agent 失败：${toErrorMessage(e)}`, "err");
    }
  }

  async function pullHeaderFromOa(flowRaw?: string) {
    const flow = (flowRaw ?? headerDraft.flow_no).trim();
    if (!flow) {
      toast.push("请先填写流程号", "warn");
      return;
    }
    if (!oaLoggedIn) {
      toast.push("请先登录 Tide OA", "warn");
      void loginTideOa();
      return;
    }
    setOaBusy(true);
    setHeaderErr("");
    try {
      const r = await api.emmcTideOaFetchFlow(flow);
      const h = r.header || {};
      const filledCount = Object.values(h).filter((v) => String(v || "").trim()).length;
      setHeaderDraft((prev) => ({
        ...prev,
        import_project: h.import_project || prev.import_project,
        internal_model: h.internal_model || prev.internal_model,
        emmc_brand: h.emmc_brand || prev.emmc_brand,
        emmc_capacity_gb: h.emmc_capacity_gb || prev.emmc_capacity_gb,
        read_speed_mbs: h.read_speed_mbs || prev.read_speed_mbs,
        write_speed_mbs: h.write_speed_mbs || prev.write_speed_mbs,
        emmc_model: h.emmc_model || prev.emmc_model,
        sw_test_userdebug: h.sw_test_userdebug || prev.sw_test_userdebug,
        emmc_spec: h.emmc_spec || prev.emmc_spec,
        gota_version: h.gota_version || prev.gota_version,
      }));
      if (filledCount > 0) {
        toast.push(`已从 Tide OA 自动填充 ${filledCount} 个字段`, "ok");
      } else {
        toast.push("已查到 Tide OA 流程，但未匹配到可填充字段", "warn");
      }
    } catch (e) {
      const msg = `从 Tide OA 拉取失败：${toErrorMessage(e)}`;
      setHeaderErr(msg);
      toast.push(msg, "err");
    } finally {
      setOaBusy(false);
    }
  }

  async function start() {
    if (!snOk) return;
    const picked = steps.filter((s) => selected[s.id]).map((s) => s.id);
    if (!picked.length) {
      toast.push("请至少选择一项测试", "warn");
      return;
    }
    try {
      const cfg = await api.emmcFeishuConfig(flowNo.trim() || "1");
      if (cfg.user_logged_in) {
        setFeishuUserName(cfg.user_name || "");
        setFeishuUserOpenId(cfg.user_open_id || "");
        await openHeaderEditor(true, cfg.user_name || "");
        return;
      }
    } catch {
      /* 飞书配置查询失败时照常弹登录提示 */
    }
    setFeishuMsg("");
    setStartLoginOpen(true);
  }

  async function executeStart(flowOverride?: string, abOverride?: boolean) {
    if (!snOk) return;
    const picked = steps.filter((s) => selected[s.id]).map((s) => s.id);
    if (!picked.length) {
      setStatus("请至少选择一项");
      return;
    }
    const flow = (flowOverride ?? flowNo).trim() || "1";
    let abOn = abOverride ?? abUpgrade;
    if (abOverride === undefined) {
      try {
        const info = await api.emmcReport(flow);
        const ab = headerAbOn(info.header);
        if (ab != null) {
          abOn = ab;
          setAbUpgrade(ab);
        }
      } catch {
        /* 报告尚未创建时沿用本页已知的 A/B 状态 */
      }
    }
    if (picked.includes("ota") && !abOn) {
      const onlyOta = picked.every((id) => id === "ota");
      if (onlyOta) {
        const msg =
          "当前报告未勾选 A/B 升级，OTA 不会执行。请在「填写报告头部」勾选 A/B 升级，或再勾选其他测试项。";
        setStatus("无法启动：未勾选 A/B 升级");
        await dialog.alert({ title: "无法开始", message: msg });
        return;
      }
      const go = await dialog.confirm({
        title: "将跳过 OTA",
        message:
          "当前报告未勾选 A/B 升级，OTA 测试将被跳过。是否继续执行其余测试项？",
        confirmLabel: "继续",
        cancelLabel: "取消",
      });
      if (!go) {
        setStatus("已取消启动");
        return;
      }
    }
    setStarting(true);
    setStatus("启动中…");
    try {
      const params: {
        loop_num?: number;
        stress_max_run_minutes?: number | null;
        iozone_file_size_mb?: number;
        samsung_emmc?: boolean;
        iozone_write_min_mbs?: number;
        iozone_read_min_mbs?: number;
        reboot_run_hours?: number | null;
        reboot_boot_timeout_sec?: number;
        reboot_count?: number | null;
        rpmb_run_minutes?: number;
        ota_upgrade_count?: number;
        ota_file_path?: string | null;
        ota_retry_limit?: number;
        ota_max_run_minutes?: number;
        ota_timeout_minutes?: number;
        ota_round_interval_minutes?: number;
      } = {};
      if (on.stress) {
        if (stressMode === "minutes") {
          params.stress_max_run_minutes = parsePosFloat(
            stressMinutes,
            "读写压力时长",
          );
          params.loop_num = 0;
        } else {
          params.loop_num = parsePosInt(loopNum, "循环次数");
          params.stress_max_run_minutes = 0;
        }
      }
      if (on.iozone) {
        params.iozone_file_size_mb = parsePosInt(iozoneMb, "iozone 文件大小");
        params.samsung_emmc = false;
        params.iozone_write_min_mbs = parsePosFloat(
          iozoneWriteMin,
          "写入达标 MB/s",
        );
        params.iozone_read_min_mbs = parsePosFloat(
          iozoneReadMin,
          "读取达标 MB/s",
        );
      }
      if (on.reboot) {
        params.reboot_boot_timeout_sec = parsePosInt(
          bootTimeoutSec,
          "开机超时",
        );
        if (rebootMode === "count") {
          params.reboot_count = parsePosInt(rebootCount, "reboot 次数");
          params.reboot_run_hours = null;
        } else {
          params.reboot_run_hours = parsePosFloat(rebootHours, "reboot 时长");
          params.reboot_count = 0;
        }
      }
      if (on.rpmb) params.rpmb_run_minutes = parsePosFloat(rpmbMin, "RPMB 时长");
      if (on.ota && abOn) {
        const otaFile = otaPath.trim();
        if (!otaFile) {
          setStatus("OTA 路径不能为空，请选择升级包");
          return;
        }
        if (otaMode === "count") {
          params.ota_upgrade_count = parsePosInt(otaCount, "OTA 轮数");
          params.ota_max_run_minutes = 0;
        } else {
          params.ota_upgrade_count = 0;
          params.ota_max_run_minutes = parsePosInt(otaMaxRun, "最大运行");
        }
        params.ota_retry_limit = parseNonNegInt(otaRetry, "每轮重试");
        params.ota_timeout_minutes = parsePosInt(otaTimeout, "单轮超时");
        params.ota_round_interval_minutes = parseNonNegInt(
          otaInterval,
          "轮次间隔",
        );
        params.ota_file_path = otaFile;
      }
      const sendSteps = abOn ? picked : picked.filter((id) => id !== "ota");
      if (!on.reboot && agentStatus?.installed && agentStatus.state !== "IDLE") {
        void api
          .emmcAgentReset(deviceSn)
          .then((res) => {
            if (res.status) setAgentStatus(res.status as typeof agentStatus);
          })
          .catch(() => {});
      }
      const r = await api.emmcStart(
        deviceSn,
        sendSteps,
        flow,
        params,
        stopOnFail,
      );
      setJobId(r.job_id);
      setStopping(false);
      setRunning(true);
      logCursorRef.current = 0;
      setLogs([]);
      setStepResults({});
      setStepProgress({});
      setCurrentStep(sendSteps[0] || "");
      setStepsDone(0);
      setStepsTotal(sendSteps.length);
      setReportPath(r.report_path || "");
      if (r.feishu_report_url) {
        setFeishuReportUrl(r.feishu_report_url);
        toast.push(
          `已复制飞书在线报告，后续结果将自动写入：${r.feishu_report_url}`,
          "ok",
        );
      } else if (r.feishu_report_warn) {
        toast.push(`飞书模板复制失败（将继续本地测试）：${r.feishu_report_warn}`, "warn");
      }
      setStatus(
        r.report_path
          ? `任务 ${r.job_id} 运行中 · ${shortPath(r.report_path, 36)}`
          : `任务 ${r.job_id} 运行中…`,
      );
    } catch (e) {
      const msg = toErrorMessage(e);
      setStatus(msg.startsWith("无法") ? msg : `无法启动：${msg}`);
      await dialog.alert({ title: "无法开始", message: msg });
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!jobId || stopping) return;
    setStopping(true);
    setStatus("正在停止 eMMC 测试...");
    try {
      await api.emmcStop(jobId);
      setStatus("已请求停止 eMMC 测试，等待当前步骤退出...");
    } catch (e) {
      setStopping(false);
      setStatus(`停止 eMMC 测试失败：${toErrorMessage(e)}`);
    }
  }

  const currentLabel =
    steps.find((s) => s.id === currentStep)?.label || currentStep || "";
  const pipelineDone = running
    ? stepsDone
    : Object.values(stepResults).filter((v) => v === "Pass" || v === "Fail")
        .length;
  const pipelineTotal = running
    ? stepsTotal || pickedCount
    : pickedCount || stepsTotal;

  return (
    <div className="tool-panel emmc-panel">
      <div className="emmc-layout">
        <aside className="emmc-side">
          <div className="emmc-card emmc-control-card">
            <div className="emmc-run-bar">
              <span
                className={`shell-live-dot${running ? "" : " off"}`}
                title={running ? "运行中" : "未运行"}
              />
              {feishuUserOpenId ? (
                <button
                  type="button"
                  className="emmc-login-pill is-logged"
                  disabled={feishuBusy || running}
                  onClick={() => {
                    void (async () => {
                      const ok = await dialog.confirm({
                        title: "退出飞书登录",
                        message: "确定退出当前飞书账号吗？",
                        detail: feishuUserName || feishuUserOpenId,
                        note: "退出后将无法自动生成飞书在线报告与发送飞书通知。",
                        confirmLabel: "退出登录",
                        cancelLabel: "取消",
                        danger: true,
                      });
                      if (ok) void logoutFeishu();
                    })();
                  }}
                  title="已登录飞书，点击退出登录"
                >
                  飞书已登录：{feishuUserName || feishuUserOpenId}
                </button>
              ) : (
                <button
                  type="button"
                  className="emmc-login-pill is-unlogged"
                  disabled={feishuBusy || running}
                  onClick={() => void loginFeishuQr()}
                  title="点击扫码登录飞书"
                >
                  {feishuBusy ? "飞书登录中…" : "飞书未登录 · 点击登录"}
                </button>
              )}
              {oaLoggedIn ? (
                <button
                  type="button"
                  className="emmc-login-pill is-logged"
                  disabled={oaBusy || running}
                  onClick={() => {
                    void (async () => {
                      const ok = await dialog.confirm({
                        title: "退出 Tide OA 登录",
                        message: "确定退出当前 Tide OA 登录吗？",
                        detail: oaUserName || "已就绪",
                        note: "退出后将无法从 Tide OA 自动拉取流程报告头部信息。",
                        confirmLabel: "退出登录",
                        cancelLabel: "取消",
                        danger: true,
                      });
                      if (ok) void logoutTideOa();
                    })();
                  }}
                  title="已登录 Tide OA，点击退出"
                >
                  OA已登录：{oaUserName || "已就绪"}
                </button>
              ) : (
                <button
                  type="button"
                  className="emmc-login-pill is-unlogged"
                  disabled={oaBusy || running}
                  onClick={() => void loginTideOa()}
                  title="点击打开 Tide OA 窗口，飞书扫码后自动保存凭证"
                >
                  {oaBusy ? "OA登录中…" : "OA未登录 · 点击登录"}
                </button>
              )}
              <div className="emmc-run-actions">
                <Button
                  variant="primary"
                  disabled={!snOk || running || starting || !pickedCount}
                  onClick={() => void start()}
                >
                  {starting ? "启动中" : "开始"}
                </Button>
                <Button
                  disabled={!running || stopping}
                  loading={stopping}
                  onClick={() => void stop()}
                >
                  {stopping ? "停止中" : "停止"}
                </Button>
              </div>
            </div>
            <div className="emmc-report-strip">
              <div className="emmc-flow-summary">
                <span>
                  流程号：<strong>{flowNo.trim() || "未设置"}</strong>
                </span>
                <span>
                  项目：<strong>{importProject.trim() || "—"}</strong>
                </span>
              </div>
              <div className="emmc-report-actions">
                <Button
                  disabled={!flowNo.trim() || !reportPath || feishuBusy || running}
                  title={
                    !flowNo.trim() || !reportPath
                      ? "当前流程尚无本地报告"
                      : "将当前流程的本地报告复制并同步到飞书"
                  }
                  onClick={() => void copyFlowLocalToFeishu()}
                >
                  复制本地报告到飞书
                </Button>
                <Button
                  disabled={!feishuReportUrl.trim() || feishuBusy}
                  title={
                    feishuReportUrl.trim()
                      ? feishuReportUrl.trim()
                      : "当前流程尚未生成飞书在线报告"
                  }
                  onClick={() => void openOnlineReport()}
                >
                  在线报告
                </Button>
                <Button onClick={() => void openReportsDir()}>本地报告目录</Button>
                <Button onClick={() => void openLogsDir()}>日志目录</Button>
              </div>
              {reportPath ? (
                <button
                  type="button"
                  className="emmc-path-btn"
                  title={reportPath}
                  onClick={() => void openAny(reportPath)}
                >
                  {shortPath(reportPath, 52)}
                </button>
              ) : (
                <span className="emmc-hint">同流程号汇总 · 点击开始时填写报告头部</span>
              )}
              {feishuReportUrl ? (
                <button
                  type="button"
                  className="emmc-path-btn"
                  title={`点击在浏览器打开复制后的飞书在线报告：${feishuReportUrl}`}
                  onClick={() => void openAny(feishuReportUrl)}
                >
                  飞书在线报告：{shortPath(feishuReportUrl, 44)}
                </button>
              ) : null}
            </div>
          </div>

          <div className="emmc-card">
            <div className="emmc-card-head">
              <span>
                测试项
                <span className="emmc-meta">
                  {" "}
                  · {pickedCount}/{steps.length || "—"}
                  {running || pipelineDone > 0
                    ? ` · 进度 ${pipelineDone}/${pipelineTotal || "—"}`
                    : ""}
                </span>
              </span>
              <div className="emmc-btn-row tight">
                <Button
                  disabled={!snOk || running || !steps.length}
                  onClick={() => setAll(true)}
                >
                  全选
                </Button>
                <Button
                  disabled={!snOk || running || !steps.length}
                  onClick={() => setAll(false)}
                >
                  清空
                </Button>
              </div>
            </div>
            <div className="emmc-steps">
              {!steps.length ? (
                <EmptyState
                  title={snOk ? "暂无测试项" : "未绑定设备"}
                  description={
                    snOk
                      ? "正在加载或当前固件未返回步骤列表。"
                      : "打开设备会话后可配置 eMMC 测试。"
                  }
                />
              ) : null}
              {steps.map((s, idx) => {
                const verdict =
                  stepResults[s.id] ||
                  (currentStep === s.id && running ? "running" : "");
                const verdictClass =
                  verdict === "Pass"
                    ? "pass"
                    : verdict === "Fail"
                      ? "fail"
                      : verdict === "running"
                        ? "running"
                        : "";
                const sp = stepProgress[s.id];
                const rawCur = Number(sp?.current) || 0;
                const rawTot = Number(sp?.total) || 0;
                const spText = (sp?.text || "").trim();
                const isIozone = s.id === "iozone";
                const spTot = rawTot > 0 ? rawTot : isIozone ? 1 : 0;
                const spCur = rawTot > 0 ? rawCur : isIozone ? (verdict === "Pass" ? 1 : 0) : rawCur;
                const rawProgress =
                  spText ||
                  (spTot > 0
                    ? `${spCur}/${spTot} 次`
                    : isIozone && verdict === "Pass"
                      ? "1/1 次"
                      : isIozone && verdict === "Fail"
                        ? "0/1 次"
                        : "");
                const itemProgress =
                  rawProgress === "执行中" || rawProgress === "进行中"
                    ? ""
                    : rawProgress;
                const itemPct =
                  spTot > 0
                    ? Math.min(100, Math.round((100 * spCur) / spTot))
                    : verdict === "Pass"
                      ? 100
                      : verdict === "running"
                        ? 5
                        : 0;
                const showItemBar =
                  Boolean(selected[s.id]) &&
                  (verdict === "running" ||
                    verdict === "Pass" ||
                    verdict === "Fail") &&
                  (spTot > 0 || Boolean(itemProgress) || verdict === "running");
                return (
                  <label
                    key={s.id}
                    className={`emmc-step${selected[s.id] ? " on" : ""}${
                      verdictClass ? ` result-${verdictClass}` : ""
                    }`}
                  >
                    <span className="emmc-step-idx">{idx + 1}</span>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[s.id])}
                      disabled={!snOk || running}
                      onChange={(e) =>
                        setSelected((prev) => ({
                          ...prev,
                          [s.id]: e.target.checked,
                        }))
                      }
                    />
                    <span className="emmc-step-main">
                      <span className="emmc-step-label">{s.label}</span>
                      {s.id === "ota" && !abUpgrade ? (
                        <span className="emmc-step-note">
                          未勾 A/B，开始时会跳过
                        </span>
                      ) : null}
                      {showItemBar ? (
                        <span
                          className="emmc-step-bar"
                          title={itemProgress || undefined}
                        >
                          <span className="emmc-step-bar-track">
                            <span
                              className={`emmc-step-bar-fill${
                                verdict === "running" ? " is-running" : ""
                              }${verdict === "Fail" ? " is-fail" : ""}`}
                              style={{ width: `${itemPct}%` }}
                            />
                          </span>
                          {itemProgress && verdict !== "running" ? (
                            <span className="emmc-step-bar-text">
                              {itemProgress}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    {verdict === "running" ? (
                      <span
                        className="emmc-step-verdict is-running"
                        title={itemProgress ? `进行中 · ${itemProgress}` : "测试进行中"}
                      >
                        {itemProgress || "进行中"}
                      </span>
                    ) : verdict ? (
                      <span
                        className={`emmc-step-verdict is-${verdictClass}`}
                        title={
                          itemProgress
                            ? `${verdict} · ${itemProgress}`
                            : verdict === "Pass"
                              ? "该项通过"
                              : "该项失败"
                        }
                      >
                        {verdict}
                      </span>
                    ) : (
                      <span className="emmc-step-verdict is-idle">—</span>
                    )}
                  </label>
                );
              })}
            </div>
            <label className="emmc-check emmc-stop-on-fail">
              <input
                type="checkbox"
                checked={stopOnFail}
                disabled={!snOk || running}
                onChange={(e) => setStopOnFail(e.target.checked)}
              />
              任一项失败时停止后续步骤
            </label>
          </div>

          <div className="emmc-card emmc-params-card">
            <div className="emmc-card-head">
              <span>测试参数</span>
              <span className="emmc-meta">随勾选项显示</span>
            </div>
            <div className="emmc-param-rows">
              {steps.map((step) => {
                if (!selected[step.id]) return null;
                if (step.id === "iozone") {
                  return (
                    <div key={step.id} className="emmc-param-row">
                      <div className="emmc-param-row-head">
                        <span className="emmc-param-name">{step.label}</span>
                      </div>
                      <div className="emmc-param-body">
                        <label className="emmc-param">
                          <span>文件大小</span>
                          <div className="emmc-param-input">
                            <input
                              className="field"
                              value={iozoneMb}
                              disabled={!snOk || running}
                              onChange={(e) => setIozoneMb(e.target.value)}
                            />
                            <span className="emmc-param-unit">MB</span>
                          </div>
                        </label>
                        <div
                          className="emmc-param-group"
                          title="Pass 判定：读写速率均需达标"
                        >
                          <span className="emmc-param-group-label">Pass 标准</span>
                          <div className="emmc-param-group-fields">
                            <label className="emmc-param">
                              <span>写入 ≥</span>
                              <div className="emmc-param-input">
                                <input
                                  className="field"
                                  value={iozoneWriteMin}
                                  disabled={!snOk || running}
                                  onChange={(e) =>
                                    setIozoneWriteMin(e.target.value)
                                  }
                                />
                                <span className="emmc-param-unit">MB/s</span>
                              </div>
                            </label>
                            <label className="emmc-param">
                              <span>读取 ≥</span>
                              <div className="emmc-param-input">
                                <input
                                  className="field"
                                  value={iozoneReadMin}
                                  disabled={!snOk || running}
                                  onChange={(e) =>
                                    setIozoneReadMin(e.target.value)
                                  }
                                />
                                <span className="emmc-param-unit">MB/s</span>
                              </div>
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                if (step.id === "stress") {
                  return (
                    <div key={step.id} className="emmc-param-row">
                      <div className="emmc-param-row-head">
                        <span className="emmc-param-name">{step.label}</span>
                        <div
                          className="emmc-reboot-mode"
                          title="次数与时长二选一"
                        >
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`stress-mode-${deviceSn || "browse"}`}
                              checked={stressMode === "count"}
                              disabled={!snOk || running}
                              onChange={() => setStressMode("count")}
                            />
                            按次数
                          </label>
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`stress-mode-${deviceSn || "browse"}`}
                              checked={stressMode === "minutes"}
                              disabled={!snOk || running}
                              onChange={() => setStressMode("minutes")}
                            />
                            按时长
                          </label>
                        </div>
                      </div>
                      <div className="emmc-param-body">
                        {stressMode === "count" ? (
                          <label className="emmc-param">
                            <span>循环次数</span>
                            <input
                              className="field"
                              value={loopNum}
                              disabled={!snOk || running}
                              onChange={(e) => setLoopNum(e.target.value)}
                            />
                          </label>
                        ) : (
                          <label className="emmc-param">
                            <span>时长</span>
                            <div className="emmc-param-input">
                              <input
                                className="field"
                                value={stressMinutes}
                                disabled={!snOk || running}
                                onChange={(e) =>
                                  setStressMinutes(e.target.value)
                                }
                              />
                              <span className="emmc-param-unit">分钟</span>
                            </div>
                          </label>
                        )}
                        <div
                          className="emmc-stress-stats"
                          title="write / read / check 成功与失败次数"
                        >
                          {(
                            [
                              ["write", stressStats.writePass, stressStats.writeFail],
                              ["read", stressStats.readPass, stressStats.readFail],
                              ["check", stressStats.checkPass, stressStats.checkFail],
                            ] as const
                          ).map(([name, pass, fail]) => (
                            <div key={name} className="emmc-stress-stat">
                              <span className="emmc-stress-stat-name">{name}</span>
                              <span className="emmc-stress-stat-pass">{pass}</span>
                              <span className="emmc-stress-stat-sep">/</span>
                              <span
                                className={`emmc-stress-stat-fail${
                                  fail > 0 ? " has-fail" : ""
                                }`}
                              >
                                {fail}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                }
                if (step.id === "reboot") {
                  return (
                    <div key={step.id} className="emmc-param-row">
                      <div className="emmc-param-row-head">
                        <span className="emmc-param-name">{step.label}</span>
                        <div
                          className="emmc-reboot-mode"
                          title="次数与时长二选一"
                        >
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`reboot-mode-${deviceSn || "browse"}`}
                              checked={rebootMode === "hours"}
                              disabled={!snOk || running}
                              onChange={() => setRebootMode("hours")}
                            />
                            按时长
                          </label>
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`reboot-mode-${deviceSn || "browse"}`}
                              checked={rebootMode === "count"}
                              disabled={!snOk || running}
                              onChange={() => setRebootMode("count")}
                            />
                            按次数
                          </label>
                        </div>
                      </div>
                      <div className="emmc-param-body">
                        {rebootMode === "hours" ? (
                          <label className="emmc-param">
                            <span>时长</span>
                            <div className="emmc-param-input">
                              <input
                                className="field"
                                value={rebootHours}
                                disabled={!snOk || running}
                                onChange={(e) => setRebootHours(e.target.value)}
                              />
                              <span className="emmc-param-unit">小时</span>
                            </div>
                          </label>
                        ) : (
                          <label className="emmc-param">
                            <span>次数</span>
                            <input
                              className="field"
                              value={rebootCount}
                              disabled={!snOk || running}
                              onChange={(e) => setRebootCount(e.target.value)}
                            />
                          </label>
                        )}
                        <label className="emmc-param">
                          <span>开机超时</span>
                          <div className="emmc-param-input">
                            <input
                              className="field"
                              value={bootTimeoutSec}
                              disabled={!snOk || running}
                              onChange={(e) => setBootTimeoutSec(e.target.value)}
                            />
                            <span className="emmc-param-unit">秒</span>
                          </div>
                        </label>
                      </div>
                      {agentStatus ? (
                        <div className="emmc-btn-row tight" style={{ marginTop: 6, alignItems: "center" }}>
                          <span className="emmc-hint">
                            {!agentStatus.installed
                              ? "默认联动设备端 Agent（开始 Reboot 时自动安装并同步）"
                              : `设备端 Agent：${agentStatus.state} · 第 ${agentStatus.current_round ?? 0} 轮`}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                }
                if (step.id === "ota") {
                  return (
                    <div key={step.id} className="emmc-param-row emmc-param-row-ota">
                      <div className="emmc-param-row-head">
                        <span className="emmc-param-name">{step.label}</span>
                        <div
                          className="emmc-reboot-mode"
                          title="次数与时长二选一"
                        >
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`ota-mode-${deviceSn || "browse"}`}
                              checked={otaMode === "count"}
                              disabled={!snOk || running}
                              onChange={() => setOtaMode("count")}
                            />
                            按次数
                          </label>
                          <label className="emmc-check">
                            <input
                              type="radio"
                              name={`ota-mode-${deviceSn || "browse"}`}
                              checked={otaMode === "minutes"}
                              disabled={!snOk || running}
                              onChange={() => setOtaMode("minutes")}
                            />
                            按时长
                          </label>
                        </div>
                      </div>
                      <div className="emmc-param-body emmc-param-body-ota">
                        <div className="emmc-ota-grid">
                          {otaMode === "count" ? (
                            <label className="emmc-param">
                              <span>升级轮次</span>
                              <input
                                className="field"
                                value={otaCount}
                                disabled={!snOk || running}
                                onChange={(e) => setOtaCount(e.target.value)}
                              />
                            </label>
                          ) : (
                            <label className="emmc-param">
                              <span>最大运行</span>
                              <div className="emmc-param-input">
                                <input
                                  className="field"
                                  value={otaMaxRun}
                                  disabled={!snOk || running}
                                  onChange={(e) => setOtaMaxRun(e.target.value)}
                                />
                                <span className="emmc-param-unit">分</span>
                              </div>
                            </label>
                          )}
                          <label className="emmc-param">
                            <span>每轮重试</span>
                            <input
                              className="field"
                              value={otaRetry}
                              disabled={!snOk || running}
                              onChange={(e) => setOtaRetry(e.target.value)}
                            />
                          </label>
                          <label className="emmc-param">
                            <span>单轮超时</span>
                            <div className="emmc-param-input">
                              <input
                                className="field"
                                value={otaTimeout}
                                disabled={!snOk || running}
                                onChange={(e) => setOtaTimeout(e.target.value)}
                              />
                              <span className="emmc-param-unit">分</span>
                            </div>
                          </label>
                          <label className="emmc-param">
                            <span>轮次间隔</span>
                            <div className="emmc-param-input">
                              <input
                                className="field"
                                value={otaInterval}
                                disabled={!snOk || running}
                                onChange={(e) => setOtaInterval(e.target.value)}
                              />
                              <span className="emmc-param-unit">分</span>
                            </div>
                          </label>
                        </div>
                        <label className="emmc-param emmc-param-wide">
                          <span>OTA 包路径</span>
                          <div className="emmc-path-field">
                            <input
                              className="field mono"
                              value={otaPath}
                              disabled={!snOk || running}
                              onChange={(e) => setOtaPath(e.target.value)}
                              placeholder="请选择 OTA 升级包"
                            />
                            <button
                              type="button"
                              className="btn"
                              disabled={!snOk || running}
                              onClick={() =>
                                void (async () => {
                                  const pick = window.toolbox?.chooseFile;
                                  if (!pick) {
                                    setStatus("当前环境不支持文件选择");
                                    return;
                                  }
                                  const file = await pick({
                                    title: "选择 OTA 升级包",
                                    filters: [
                                      {
                                        name: "OTA / ZIP",
                                        extensions: ["zip", "bin", "img"],
                                      },
                                      { name: "所有文件", extensions: ["*"] },
                                    ],
                                  });
                                  if (file) setOtaPath(file);
                                })()
                              }
                            >
                              浏览
                            </button>
                          </div>
                        </label>
                      </div>
                    </div>
                  );
                }
                if (step.id === "rpmb") {
                  return (
                    <div key={step.id} className="emmc-param-row">
                      <div className="emmc-param-row-head">
                        <span className="emmc-param-name">{step.label}</span>
                      </div>
                      <div className="emmc-param-body">
                        <label className="emmc-param">
                          <span>时长</span>
                          <div className="emmc-param-input">
                            <input
                              className="field"
                              value={rpmbMin}
                              disabled={!snOk || running}
                              onChange={(e) => setRpmbMin(e.target.value)}
                            />
                            <span className="emmc-param-unit">分钟</span>
                          </div>
                        </label>
                      </div>
                    </div>
                  );
                }
                return null;
              })}
              {!pickedCount ? (
                <div className="emmc-hint emmc-hint-block">
                  勾选上方测试项后显示对应参数
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <div className="emmc-log-card">
          <div className="emmc-log-head">
            <div className="emmc-log-title">
              <span>运行日志</span>
              {running ? (
                <span className="emmc-log-badge is-running">
                  {currentLabel ? `进行中 · ${currentLabel}` : "运行中"}
                </span>
              ) : logs.length ? (
                <span className="emmc-log-badge">{logs.length} 行</span>
              ) : null}
            </div>
            <div className="emmc-log-head-actions">
              <Button
                className={logScroll.follow ? "on" : ""}
                title={
                  logScroll.follow
                    ? "贴底跟随中；上翻可暂停"
                    : "已停随；点此或滚回底部继续跟随"
                }
                onClick={() => {
                  if (logScroll.follow) logScroll.setFollow(false);
                  else logScroll.scrollToBottom();
                }}
              >
                {logScroll.follow ? "跟随" : "停随"}
              </Button>
              <Button disabled={!logs.length} onClick={() => setLogs([])}>
                清空
              </Button>
            </div>
          </div>
          {logText ? (
            <pre
              className="log emmc-log"
              ref={logScroll.ref}
              onScroll={logScroll.onScroll}
            >
              {logText}
            </pre>
          ) : (
            <div className="emmc-log-empty">
              <EmptyState
                title={snOk ? "尚无测试日志" : "未绑定设备"}
                description={
                  snOk
                    ? "开始后在此显示 eMMC 日志。"
                    : "打开设备标签后可启动测试。"
                }
              />
            </div>
          )}
        </div>
      </div>

      <Modal
        open={headerOpen}
        size="lg"
        onClose={() => {
          setHeaderOpen(false);
          setHeaderStartPending(false);
        }}
        title={`测试报告头部 · 流程 ${headerDraft.flow_no.trim() || "—"}`}
        footer={
          <>
            <Button
              onClick={() => {
                setHeaderOpen(false);
                setHeaderStartPending(false);
              }}
            >
              取消
            </Button>
            <Button
              disabled={headerBusy || oaBusy || !headerDraft.flow_no.trim()}
              loading={oaBusy}
              onClick={() => void pullHeaderFromOa()}
            >
              从 OA 拉取
            </Button>
            <Button
              variant="primary"
              disabled={headerBusy}
              loading={headerBusy}
              onClick={() => void saveHeader()}
            >
              {headerStartPending ? "保存并开始测试" : "保存报告头部"}
            </Button>
          </>
        }
      >
        <div className="emmc-header-grid">
          <div className="emmc-param emmc-param-wide">
            <span
              className="emmc-hint"
              style={{ color: "var(--danger)", fontWeight: 500, lineHeight: 1.5 }}
            >
              注意：请务必填写准确流程号！流程号是本地 Excel 与飞书在线报告的唯一汇总标识；若填错或多设备未填同一流程号，会导致测试结果分散到不同报告或覆盖旧测试数据，无法自动汇总。
            </span>
          </div>
          {(
            [
              ["flow_no", "流程号 *"],
              ["import_project", "导入项目 *"],
              ["internal_model", "内部型号"],
              ["emmc_brand", "eMMC 品牌"],
              ["emmc_capacity_gb", "容量 GB"],
              ["read_speed_mbs", "读速 MB/s"],
              ["write_speed_mbs", "写速 MB/s"],
              ["emmc_model", "eMMC 型号"],
              ["sw_test_userdebug", "SW(userdebug)"],
              ["emmc_spec", "eMMC Spec"],
              ["gota_version", "GOTA 版本"],
              ["tester", "测试人"],
              ["test_time", "测试时间"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className={
                key === "sw_test_userdebug" ||
                key === "emmc_spec" ||
                key === "gota_version"
                  ? "emmc-param emmc-param-wide"
                  : "emmc-param"
              }
            >
              <span>{label}</span>
              <input
                className="field"
                value={headerDraft[key]}
                disabled={headerBusy}
                onBlur={() => {
                  if (
                    key === "flow_no" &&
                    oaLoggedIn &&
                    headerDraft.flow_no.trim() &&
                    !headerDraft.import_project.trim()
                  ) {
                    void pullHeaderFromOa(headerDraft.flow_no);
                  }
                }}
                onChange={(e) =>
                  setHeaderDraft((prev) => ({
                    ...prev,
                    [key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
          <label className="emmc-param emmc-param-wide">
            <span>备注</span>
            <input
              className="field"
              value={headerDraft.remarks}
              disabled={headerBusy}
              onChange={(e) =>
                setHeaderDraft((prev) => ({
                  ...prev,
                  remarks: e.target.value,
                }))
              }
            />
          </label>
          <label className="emmc-check">
            <input
              type="checkbox"
              checked={headerDraft.ab_upgrade}
              disabled={headerBusy}
              onChange={(e) =>
                setHeaderDraft((prev) => ({
                  ...prev,
                  ab_upgrade: e.target.checked,
                }))
              }
            />
            A/B 升级（需 OTA）
          </label>
          {headerErr ? (
            <div className="emmc-param emmc-param-wide">
              <span className="emmc-hint" style={{ color: "var(--danger)" }}>
                {headerErr}
              </span>
            </div>
          ) : null}
        </div>
      </Modal>
      <Modal
        open={startLoginOpen}
        title="飞书账号登录提示"
        onClose={() => {
          cancelFeishuLogin();
          setStartLoginOpen(false);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                cancelFeishuLogin();
                setStartLoginOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              onClick={() => {
                cancelFeishuLogin();
                setStartLoginOpen(false);
                void openHeaderEditor(true);
              }}
            >
              暂不登录，继续
            </Button>
            <Button
              variant="primary"
              disabled={feishuBusy}
              loading={feishuBusy}
              onClick={() => {
                void (async () => {
                  const name = await loginFeishuQr();
                  if (name) {
                    setStartLoginOpen(false);
                    await openHeaderEditor(true, name);
                  }
                })();
              }}
            >
              扫码登录飞书
            </Button>
          </>
        }
      >
        <div className="emmc-header-grid">
          <div className="emmc-param emmc-param-wide">
            <p className="emmc-hint" style={{ margin: 0, lineHeight: 1.6 }}>
              扫码登录飞书后，将自动填写测试人、生成飞书在线报告并私聊通知进度。
            </p>
            <p
              className="emmc-hint"
              style={{ margin: 0, lineHeight: 1.6, color: "var(--danger)", fontWeight: 500 }}
            >
              注意：不登录将仅生成本地报告，不会生成飞书在线报告，也没有飞书通知。
            </p>
            {feishuMsg ? <span className="emmc-hint">{feishuMsg}</span> : null}
          </div>
        </div>
      </Modal>
    </div>
  );
}
