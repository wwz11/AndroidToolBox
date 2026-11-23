import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../../errors";
import { api, type ApkAnalyzeInfo, type ApkCompareInfo } from "../../api/client";
import ApkAnalyzeModal, {
  type ApkAnalyzeView,
} from "../../components/ApkAnalyzeModal";
import Modal from "../../components/Modal";
import { useDialog } from "../../components/dialog";
import { useToast } from "../../components/toast";
import { Button, EmptyState } from "../../ui";

type Props = {
  deviceSn: string;
  snOk: boolean;
  /** true when apps tab is visible AND device page active */
  active: boolean;
  onAppend: (line: string) => void;
  onStatus: (msg: string) => void;
};

type PkgScope = "all" | "third" | "system";
type ApkJobStatus = "queued" | "installing" | "ok" | "fail";
type ApkJob = {
  id: string;
  file: File;
  name: string;
  size: number;
  status: ApkJobStatus;
  message?: string;
  analysis?: ApkAnalyzeView;
};

const PKG_SCOPES: { key: PkgScope; label: string }[] = [
  { key: "third", label: "第三方" },
  { key: "system", label: "系统" },
  { key: "all", label: "全部" },
];

const EXPORT_DIR_KEY = "toolbox.apps.exportDir.v1";

function readExportDir(): string {
  try {
    return localStorage.getItem(EXPORT_DIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveExportDir(dir: string) {
  try {
    if (dir) localStorage.setItem(EXPORT_DIR_KEY, dir);
    else localStorage.removeItem(EXPORT_DIR_KEY);
  } catch {
    /* ignore */
  }
}

/** 模糊匹配评分（子串优先，其次按顺序子序列）；未命中返回 -1。 */
function fuzzyScorePkg(pkg: string, token: string): number {
  if (!token) return 0;
  const t = pkg.toLowerCase();
  const q = token.toLowerCase();
  const subIdx = t.indexOf(q);
  if (subIdx >= 0) {
    return 1000 - subIdx + (subIdx === 0 ? 120 : 0) + q.length * 10;
  }
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prev === ti - 1 ? 18 : 6;
      if (ti === 0 || t[ti - 1] === ".") score += 10;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? Math.max(1, score - Math.floor(t.length / 10)) : -1;
}

function filterPackagesFuzzy(packages: string[], query: string): string[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return packages;
  const scored: Array<{ pkg: string; score: number; idx: number }> = [];
  packages.forEach((pkg, idx) => {
    let total = 0;
    for (const tk of tokens) {
      const s = fuzzyScorePkg(pkg, tk);
      if (s < 0) return;
      total += s;
    }
    scored.push({ pkg, score: total, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((item) => item.pkg);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function apkViewFromResponse(
  r: {
    filename?: string;
    package?: string;
    version_name?: string;
    version_code?: string;
    min_sdk?: string;
    target_sdk?: string;
    md5?: string;
    abis?: string[];
    permissions?: string[];
    info?: ApkAnalyzeInfo;
    compare_info?: ApkCompareInfo;
    compare?: string;
    report?: string;
  },
  fallbackName = "",
): ApkAnalyzeView {
  const info: ApkAnalyzeInfo = {
    ...(r.info || {}),
    filename: r.info?.filename || r.filename || fallbackName,
    package: r.info?.package || r.package || "",
    version_name: r.info?.version_name || r.version_name || "",
    version_code: r.info?.version_code || r.version_code || "",
    min_sdk: r.info?.min_sdk || r.min_sdk || "",
    target_sdk: r.info?.target_sdk || r.target_sdk || "",
    md5: r.info?.md5 || r.md5 || "",
    abis: r.info?.abis || r.abis || [],
    permissions: r.info?.permissions || r.permissions || [],
  };
  return {
    info,
    compare: r.compare_info || null,
    compareReport: r.compare || "",
    report: r.report || "",
  };
}

function shortApkSummary(view: ApkAnalyzeView): string {
  const i = view.info;
  const ver = [i.version_name || "", i.version_code ? `(${i.version_code})` : ""]
    .filter(Boolean)
    .join(" ");
  const base = `${i.package || "?"} ${ver}`.trim();
  if (view.compare?.verdict) return `${base} · ${view.compare.verdict}`;
  return base;
}

function collectApkFiles(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.name.toLowerCase().endsWith(".apk"));
}

export default function AppsPanel({
  deviceSn,
  snOk,
  active,
  onAppend,
  onStatus,
}: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const [pkgFilter, setPkgFilter] = useState("");
  const [pkgScope, setPkgScope] = useState<PkgScope>("third");
  const [packages, setPackages] = useState<string[]>([]);
  const [pkgSelected, setPkgSelected] = useState("");
  const [checkedPkgs, setCheckedPkgs] = useState<string[]>([]);
  const [pkgInfo, setPkgInfo] = useState<{
    version_name: string;
    version_code: string;
    min_sdk: string;
    target_sdk: string;
    first_install_time: string;
    last_update_time: string;
    path: string;
    installed: boolean;
    enabled: boolean;
    permissions: string[];
    install_granted: string[];
    runtime_granted: string[];
    runtime_denied: string[];
  } | null>(null);
  const [pkgInfoBusy, setPkgInfoBusy] = useState(false);
  const [pkgInfoErr, setPkgInfoErr] = useState("");
  const [pkgInfoNonce, setPkgInfoNonce] = useState(0);
  const pkgInfoReq = useRef(0);
  const [permOpen, setPermOpen] = useState(false);
  const [permQuery, setPermQuery] = useState("");
  const [permRuntimeOnly, setPermRuntimeOnly] = useState(true);
  const [permBusyKey, setPermBusyKey] = useState("");
  const [keepData, setKeepData] = useState(false);
  const [reinstall, setReinstall] = useState(true);
  const [installDowngrade, setInstallDowngrade] = useState(false);
  const [installGrant, setInstallGrant] = useState(false);
  const [apkQueue, setApkQueue] = useState<ApkJob[]>([]);
  const [apkDragOver, setApkDragOver] = useState(false);
  const [apkInstalling, setApkInstalling] = useState(false);
  const [apkBoxCollapsed, setApkBoxCollapsed] = useState(false);
  const [apkResultOpen, setApkResultOpen] = useState(false);
  const [apkResults, setApkResults] = useState<ApkAnalyzeView[]>([]);
  const [apkResultIdx, setApkResultIdx] = useState(0);
  const [pkgMenu, setPkgMenu] = useState<{ x: number; y: number; pkg: string } | null>(null);
  const pkgCacheKey = useRef("");
  const apkIdSeq = useRef(0);
  const pendingLocatePkgRef = useRef("");
  const lastCheckedIdxRef = useRef(-1);
  const pkgListRef = useRef<HTMLDivElement | null>(null);

  const filteredPkgs = useMemo(
    () => filterPackagesFuzzy(packages, pkgFilter),
    [packages, pkgFilter],
  );
  const checkedSet = useMemo(() => new Set(checkedPkgs), [checkedPkgs]);

  useEffect(() => {
    setCheckedPkgs([]);
    setPkgMenu(null);
    lastCheckedIdxRef.current = -1;
  }, [deviceSn]);

  useEffect(() => {
    if (!pkgMenu) return;
    const close = () => setPkgMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPkgMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [pkgMenu]);

  useEffect(() => {
    setCheckedPkgs((prev) => {
      if (!prev.length) return prev;
      const alive = new Set(packages);
      const next = prev.filter((p) => alive.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [packages]);

  useEffect(() => {
    if (!filteredPkgs.length) {
      if (pkgSelected) setPkgSelected("");
      return;
    }
    if (!filteredPkgs.includes(pkgSelected)) {
      setPkgSelected(filteredPkgs[0]);
    }
  }, [filteredPkgs, pkgSelected]);

  async function wrap(
    label: string,
    fn: () => Promise<void>,
    opts?: { requireDevice?: boolean },
  ) {
    if ((opts?.requireDevice ?? true) && !snOk) return;
    setBusy(true);
    onStatus(label);
    try {
      await fn();
    } catch (e) {
      const msg = toErrorMessage(e);
      const op = label.replace(/…$/, "").trim();
      const firstLine = msg.split(/\r?\n/)[0] || msg;
      toast.push(
        op && !firstLine.startsWith(op) ? `${op}失败：${firstLine}` : firstLine,
        "err",
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadPackages(
    force = false,
    opts?: { quiet?: boolean; announce?: boolean },
  ) {
    if (!snOk) return;
    const key = `${deviceSn}:${pkgScope}`;
    if (!force && pkgCacheKey.current === key && packages.length) return;
    const r = await api.packages(deviceSn, "", pkgScope);
    setPackages(r.packages);
    pkgCacheKey.current = key;
    const locateTarget = pendingLocatePkgRef.current;
    if (locateTarget && r.packages.includes(locateTarget)) {
      pendingLocatePkgRef.current = "";
      setPkgSelected(locateTarget);
      window.requestAnimationFrame(() => {
        const el = pkgListRef.current?.querySelector(
          `[data-pkg="${CSS.escape(locateTarget)}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ block: "center" });
      });
    } else {
      setPkgSelected((prev) =>
        prev && r.packages.includes(prev) ? prev : r.packages[0] || "",
      );
    }
    if (opts?.quiet) return;
    const scopeLabel =
      PKG_SCOPES.find((s) => s.key === pkgScope)?.label || pkgScope;
    onStatus(`${scopeLabel} ${r.count} 个包`);
    if (opts?.announce !== false) {
      onAppend(`[packages] ${scopeLabel} · ${r.count}`);
    }
  }

  /** 手动刷新：显示状态。自动预取不抢状态栏/输出（避免 Log 抓取页看到「获取包名…」）。 */
  async function refreshPackages(force = false, opts?: { quiet?: boolean }) {
    if (opts?.quiet) {
      try {
        await loadPackages(force, { quiet: true });
      } catch {
        /* ignore background prefetch */
      }
      return;
    }
    await wrap("获取包名…", async () => {
      await loadPackages(force, { announce: true });
    });
  }

  function enqueueApks(files: File[]) {
    if (!files.length) {
      onStatus("未找到 .apk 文件");
      return;
    }
    setApkBoxCollapsed(false);
    setApkQueue((prev) => {
      const exist = new Set(prev.map((j) => `${j.name}:${j.size}`));
      const added: ApkJob[] = [];
      for (const f of files) {
        const key = `${f.name}:${f.size}`;
        if (exist.has(key)) continue;
        exist.add(key);
        apkIdSeq.current += 1;
        added.push({
          id: `apk-${apkIdSeq.current}`,
          file: f,
          name: f.name,
          size: f.size,
          status: "queued",
        });
      }
      if (!added.length) {
        onStatus("这些 APK 已在队列中");
        return prev;
      }
      onStatus(`已加入 ${added.length} 个 APK`);
      return [...prev, ...added];
    });
  }

  function removeApkJobs(ids: string[]) {
    const ban = new Set(ids);
    setApkQueue((prev) =>
      prev.filter((j) => !ban.has(j.id) || j.status === "installing"),
    );
  }

  async function analyzeApkJob(job: ApkJob) {
    await wrap(
      `分析 ${job.name}…`,
      async () => {
        const r = await api.apkAnalyze(job.file);
        const view = apkViewFromResponse(r, job.name);
        setApkQueue((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, analysis: view } : j)),
        );
        setApkResults([view]);
        setApkResultIdx(0);
        setApkResultOpen(true);
        onAppend(`[分析] ${shortApkSummary(view)}`);
        onStatus(shortApkSummary(view));
      },
      { requireDevice: false },
    );
  }

  async function compareApkJob(job: ApkJob) {
    await wrap(`对比 ${job.name}…`, async () => {
      const r = await api.apkCompare(deviceSn, job.file);
      const view = apkViewFromResponse(r, job.name);
      setApkQueue((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, analysis: view } : j)),
      );
      setApkResults([view]);
      setApkResultIdx(0);
      setApkResultOpen(true);
      const report =
        (view.compareReport || "").trim() ||
        `[对比] ${shortApkSummary(view)}`;
      onAppend(report.endsWith("\n") ? report : `${report}\n`);
      onStatus(view.compare?.verdict || "对比完成");
    });
  }

  async function analyzeApkQueue() {
    const jobs = apkQueue.filter((j) => j.status !== "installing");
    if (!jobs.length) {
      onStatus("请先拖入或添加 APK");
      return;
    }
    await wrap(
      `分析 ${jobs.length} 个 APK…`,
      async () => {
        const views: ApkAnalyzeView[] = [];
        for (const job of jobs) {
          const r = await api.apkAnalyze(job.file);
          const view = apkViewFromResponse(r, job.name);
          views.push(view);
          setApkQueue((prev) =>
            prev.map((j) => (j.id === job.id ? { ...j, analysis: view } : j)),
          );
          onAppend(`[分析] ${shortApkSummary(view)}`);
        }
        setApkResults(views);
        setApkResultIdx(0);
        setApkResultOpen(true);
        onStatus(`已分析 ${views.length} 个 APK`);
      },
      { requireDevice: false },
    );
  }

  function openApkAnalysis(job: ApkJob) {
    if (!job.analysis) return;
    setApkResults([job.analysis]);
    setApkResultIdx(0);
    setApkResultOpen(true);
  }

  async function runApkQueue() {
    if (!snOk || apkInstalling) return;
    const pending = apkQueue.filter((j) => j.status === "queued" || j.status === "fail");
    if (!pending.length) {
      onStatus("队列为空，请先添加 APK");
      return;
    }
    setApkInstalling(true);
    setBusy(true);
    let ok = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        const job = pending[i];
        setApkQueue((prev) =>
          prev.map((j) =>
            j.id === job.id ? { ...j, status: "installing", message: undefined } : j,
          ),
        );
        onStatus(`安装中 ${i + 1}/${pending.length}：${job.name}`);
        try {
          const r = await api.installApk(deviceSn, job.file, {
            reinstall,
            downgrade: installDowngrade,
            grantPermissions: installGrant,
          });
          onAppend(`[install] ${job.name}\n${r.output}`);
          if (r.ok) ok += 1;
          setApkQueue((prev) =>
            prev.map((j) =>
              j.id === job.id
                ? {
                    ...j,
                    status: r.ok ? "ok" : "fail",
                    message: (r.output || "").trim().split("\n").slice(-2).join(" "),
                  }
                : j,
            ),
          );
        } catch (e) {
          const msg = toErrorMessage(e);
          onAppend(`[install] ${job.name}\n${msg}`);
          setApkQueue((prev) =>
            prev.map((j) =>
              j.id === job.id ? { ...j, status: "fail", message: msg } : j,
            ),
          );
        }
      }
      onStatus(`安装完成 ${ok}/${pending.length}`);
      if (ok) await loadPackages(true);
    } finally {
      setApkInstalling(false);
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!active || !snOk) return;
    void refreshPackages(false, { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snOk, deviceSn, pkgScope]);

  useEffect(() => {
    if (!snOk || !pkgSelected) {
      setPkgInfo(null);
      setPkgInfoErr("");
      setPkgInfoBusy(false);
      return;
    }
    const req = ++pkgInfoReq.current;
    const pkg = pkgSelected;
    setPkgInfo(null);
    setPkgInfoErr("");
    setPkgInfoBusy(true);
    void api
      .packageInfo(deviceSn, pkg)
      .then((r) => {
        if (req !== pkgInfoReq.current) return;
        if (!r.installed) {
          setPkgInfo(null);
          setPkgInfoErr("设备上未找到该包");
          return;
        }
        setPkgInfo({
          version_name: r.version_name || "",
          version_code: r.version_code || "",
          min_sdk: r.min_sdk || "",
          target_sdk: r.target_sdk || "",
          first_install_time: r.first_install_time || "",
          last_update_time: r.last_update_time || "",
          path: r.path || "",
          installed: true,
          enabled: r.enabled ?? true,
          permissions: r.permissions || [],
          install_granted: r.install_granted || [],
          runtime_granted: r.runtime_granted || [],
          runtime_denied: r.runtime_denied || [],
        });
      })
      .catch((e: unknown) => {
        if (req !== pkgInfoReq.current) return;
        setPkgInfo(null);
        setPkgInfoErr(toErrorMessage(e));
      })
      .finally(() => {
        if (req === pkgInfoReq.current) setPkgInfoBusy(false);
      });
  }, [snOk, deviceSn, pkgSelected, pkgInfoNonce]);

  function scrollPackageIntoView(pkg: string) {
    window.requestAnimationFrame(() => {
      const el = pkgListRef.current?.querySelector(
        `[data-pkg="${CSS.escape(pkg)}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "center" });
    });
  }

  async function locateForegroundApp() {
    await wrap("识别当前前台应用…", async () => {
      const r = await api.foregroundApp(deviceSn);
      if (!r.package) {
        toast.push("未检测到前台应用（可能设备未亮屏）", "warn");
        return;
      }
      onAppend(`[foreground] ${r.package}${r.activity ? `/${r.activity}` : ""}`);
      setPkgFilter("");
      if (packages.includes(r.package)) {
        setPkgSelected(r.package);
        scrollPackageIntoView(r.package);
      } else if (pkgScope !== "all") {
        pendingLocatePkgRef.current = r.package;
        setPkgScope("all");
      } else {
        pendingLocatePkgRef.current = r.package;
        await loadPackages(true, { quiet: true });
      }
      onStatus(`前台应用: ${r.package}`);
      toast.push(`已定位前台应用: ${r.package}`, "ok");
    });
  }

  async function pickExportDir(): Promise<string> {
    const saved = readExportDir();
    if (window.toolbox?.chooseDirectory) {
      const chosen = await window.toolbox.chooseDirectory({
        title: "选择导出 APK 保存目录",
        defaultPath: saved || (await window.toolbox.defaultPullDir?.()) || undefined,
      });
      if (chosen === null) return "__CANCELLED__";
      if (chosen) {
        saveExportDir(chosen);
        return chosen;
      }
    }
    return saved || "";
  }

  async function exportPackages(targets: string[]) {
    if (!targets.length) return;
    const destDir = await pickExportDir();
    if (destDir === "__CANCELLED__") return;
    await wrap(`导出 ${targets.length} 个 APK…`, async () => {
      let okCount = 0;
      let lastDir = "";
      for (let i = 0; i < targets.length; i++) {
        const pkg = targets[i];
        onStatus(`导出中 (${i + 1}/${targets.length})：${pkg}`);
        const ver = pkg === pkgSelected && pkgInfo?.version_name ? pkgInfo.version_name : "";
        const r = await api.exportApk(deviceSn, pkg, destDir, ver);
        onAppend(`[export-apk] ${pkg}\n${r.saved_paths.join("\n")}`);
        if (r.ok) okCount += 1;
        if (r.saved_dir) lastDir = r.saved_dir;
      }
      const msg =
        targets.length === 1
          ? `已导出到 ${lastDir}`
          : `已导出 ${okCount}/${targets.length} 个应用到 ${lastDir}`;
      onStatus(msg);
      toast.push(msg, okCount === targets.length ? "ok" : "warn");
    });
  }

  async function togglePackageEnabled(pkg: string, nextEnabled: boolean) {
    if (!nextEnabled) {
      const ok = await dialog.confirm({
        title: "停用应用",
        message: "停用后该应用将无法启动或在桌面显示（相当于 pm disable-user），可随时点「启用」恢复。",
        detail: pkg,
        confirmLabel: "停用",
        cancelLabel: "取消",
        danger: true,
      });
      if (!ok) return;
    }
    await wrap(`${nextEnabled ? "启用" : "停用"} ${pkg}…`, async () => {
      const r = await api.setPackageEnabled(deviceSn, pkg, nextEnabled);
      onAppend(`[pm ${nextEnabled ? "enable" : "disable-user"}] ${pkg}\n${r.output}`);
      const okText = nextEnabled ? "已启用" : "已停用";
      const failText = `${nextEnabled ? "启用" : "停用"} ${pkg} 失败：${r.output || "可能缺少权限"}`;
      toast.push(r.ok ? `${okText} ${pkg}` : failText, r.ok ? "ok" : "err");
      if (r.ok) setPkgInfoNonce((n) => n + 1);
    });
  }

  async function togglePermission(perm: string, nextGranted: boolean) {
    if (!pkgSelected || !snOk || permBusyKey) return;
    setPermBusyKey(perm);
    try {
      const r = await api.setPackagePermission(deviceSn, pkgSelected, perm, nextGranted);
      onAppend(`[pm ${nextGranted ? "grant" : "revoke"}] ${pkgSelected} ${perm}\n${r.output}`);
      if (r.ok) {
        setPkgInfoNonce((n) => n + 1);
        toast.push(`${nextGranted ? "已授权" : "已撤销"} ${perm.split(".").pop()}`, "ok");
      } else {
        toast.push(`${nextGranted ? "授权" : "撤销"} ${perm.split(".").pop()} 失败：${r.output || "未知错误"}`, "err");
      }
    } catch (e) {
      toast.push(`${nextGranted ? "授权" : "撤销"} ${perm.split(".").pop()} 失败：${toErrorMessage(e)}`, "err");
    } finally {
      setPermBusyKey("");
    }
  }

  async function grantAllDeniedPermissions() {
    if (!pkgSelected || !pkgInfo || !snOk || permBusyKey) return;
    const denied = pkgInfo.runtime_denied || [];
    if (!denied.length) {
      toast.push("没有未授予的运行时权限", "info");
      return;
    }
    setPermBusyKey("__ALL__");
    try {
      const r = await api.grantAllPackagePermissions(deviceSn, pkgSelected, denied);
      onAppend(`[grant-all] ${pkgSelected}\n${r.output}`);
      setPkgInfoNonce((n) => n + 1);
      toast.push(r.output.split("\n")[0] || "已执行批量授权", r.failed_count === 0 ? "ok" : "warn");
    } catch (e) {
      toast.push(`一键授权失败：${toErrorMessage(e)}`, "err");
    } finally {
      setPermBusyKey("");
    }
  }

  function toggleCheckPkg(pkg: string, idx: number, shiftKey: boolean) {
    setCheckedPkgs((prev) => {
      const next = new Set(prev);
      const shouldCheck = !next.has(pkg);
      if (shiftKey && lastCheckedIdxRef.current >= 0 && lastCheckedIdxRef.current !== idx) {
        const lo = Math.min(lastCheckedIdxRef.current, idx);
        const hi = Math.max(lastCheckedIdxRef.current, idx);
        for (let i = lo; i <= hi; i++) {
          const item = filteredPkgs[i];
          if (!item) continue;
          if (shouldCheck) next.add(item);
          else next.delete(item);
        }
      } else {
        if (shouldCheck) next.add(pkg);
        else next.delete(pkg);
      }
      return Array.from(next);
    });
    lastCheckedIdxRef.current = idx;
  }

  async function runBatchForceStop(targets: string[]) {
    if (!targets.length) return;
    await wrap(`批量强停 ${targets.length} 个应用…`, async () => {
      let okCount = 0;
      for (const pkg of targets) {
        const r = await api.forceStopPackage(deviceSn, pkg);
        onAppend(`[force-stop] ${pkg}\n${r.output}`);
        if (r.ok) okCount += 1;
      }
      const msg = `批量强停完成 ${okCount}/${targets.length}`;
      onStatus(msg);
      toast.push(msg, okCount === targets.length ? "ok" : "warn");
    });
  }

  async function runBatchClearData(targets: string[]) {
    if (!targets.length) return;
    const ok = await dialog.confirm({
      title: `批量清空 ${targets.length} 个应用数据`,
      message: "将对选中的所有应用执行 pm clear，清除用户数据与缓存。",
      detail: targets.slice(0, 6).join("\n") + (targets.length > 6 ? `\n…等共 ${targets.length} 个` : ""),
      note: "此操作不可恢复，请确认后再继续。",
      confirmLabel: "确认清空",
      cancelLabel: "取消",
      danger: true,
    });
    if (!ok) return;
    await wrap(`批量清数据 ${targets.length} 个应用…`, async () => {
      let okCount = 0;
      for (const pkg of targets) {
        const r = await api.clearPackageData(deviceSn, pkg);
        onAppend(`[pm clear] ${pkg}\n${r.output}`);
        if (r.ok) okCount += 1;
      }
      const msg = `批量清数据完成 ${okCount}/${targets.length}`;
      onStatus(msg);
      toast.push(msg, okCount === targets.length ? "ok" : "warn");
    });
  }

  async function runBatchUninstall(targets: string[]) {
    if (!targets.length) return;
    const ok = await dialog.confirm({
      title: `批量卸载 ${targets.length} 个应用`,
      message: keepData
        ? "将卸载选中的所有应用，并保留其数据与缓存（-k）。"
        : "将从设备卸载选中的所有应用及其数据。",
      detail: targets.slice(0, 6).join("\n") + (targets.length > 6 ? `\n…等共 ${targets.length} 个` : ""),
      note: keepData ? "应用会被移除，但用户数据会保留。" : "此操作不可恢复。",
      confirmLabel: `卸载 ${targets.length} 个`,
      cancelLabel: "取消",
      danger: true,
    });
    if (!ok) return;
    await wrap(`批量卸载 ${targets.length} 个应用…`, async () => {
      const removed = new Set<string>();
      for (let i = 0; i < targets.length; i++) {
        const pkg = targets[i];
        onStatus(`卸载中 (${i + 1}/${targets.length})：${pkg}`);
        const r = await api.uninstall(deviceSn, pkg, keepData);
        onAppend(`[uninstall] ${pkg}\n${r.output}`);
        if (r.ok) removed.add(pkg);
      }
      if (removed.size) {
        setPackages((prev) => prev.filter((x) => !removed.has(x)));
        setCheckedPkgs((prev) => prev.filter((x) => !removed.has(x)));
      }
      const msg = `批量卸载完成 ${removed.size}/${targets.length}`;
      onStatus(msg);
      toast.push(msg, removed.size === targets.length ? "ok" : "warn");
    });
  }

  async function runBatchSetEnabled(targets: string[], nextEnabled: boolean) {
    if (!targets.length) return;
    if (!nextEnabled) {
      const ok = await dialog.confirm({
        title: `批量停用 ${targets.length} 个应用`,
        message: "停用后这些应用将无法启动或在桌面显示，可随时重新启用。",
        detail: targets.slice(0, 6).join("\n") + (targets.length > 6 ? `\n…等共 ${targets.length} 个` : ""),
        confirmLabel: `停用 ${targets.length} 个`,
        cancelLabel: "取消",
        danger: true,
      });
      if (!ok) return;
    }
    await wrap(`批量${nextEnabled ? "启用" : "停用"} ${targets.length} 个应用…`, async () => {
      let okCount = 0;
      for (const pkg of targets) {
        const r = await api.setPackageEnabled(deviceSn, pkg, nextEnabled);
        onAppend(`[pm ${nextEnabled ? "enable" : "disable-user"}] ${pkg}\n${r.output}`);
        if (r.ok) okCount += 1;
      }
      if (targets.includes(pkgSelected)) setPkgInfoNonce((n) => n + 1);
      const msg = `批量${nextEnabled ? "启用" : "停用"}完成 ${okCount}/${targets.length}`;
      onStatus(msg);
      toast.push(msg, okCount === targets.length ? "ok" : "warn");
    });
  }

  function copyText(text: string, label: string) {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(
      () => {
        onStatus(`已复制${label}`);
        toast.push(`已复制${label}`, "ok");
      },
      () => {
        onStatus("复制失败");
        toast.push("复制失败", "err");
      },
    );
  }

  return (
    <>
      <div className="apps-panel">
        <div
          className={`apk-install${apkDragOver ? " dragover" : ""}${apkBoxCollapsed ? " is-collapsed" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!apkDragOver) setApkDragOver(true);
            if (apkBoxCollapsed) setApkBoxCollapsed(false);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!apkDragOver) setApkDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = e.relatedTarget as Node | null;
            if (next && e.currentTarget.contains(next)) return;
            setApkDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setApkDragOver(false);
            if (apkInstalling) return;
            enqueueApks(collectApkFiles(e.dataTransfer.files));
          }}
        >
          <div className="apk-install-head">
            <div className="apk-install-title-row">
              <div>
                <strong>APK 安装 / 分析</strong>
                <span className="apk-install-sub">
                  同一拖入区：加入列表后可安装、分析或对比设备
                </span>
              </div>
              <button
                type="button"
                className="link-btn apk-collapse-btn"
                onClick={() => setApkBoxCollapsed((v) => !v)}
              >
                {apkBoxCollapsed
                  ? `展开${apkQueue.length ? ` (${apkQueue.length})` : ""}`
                  : "收起"}
              </button>
            </div>
            {!apkBoxCollapsed ? (
              <div className="apk-install-opts">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={reinstall}
                    disabled={!snOk || apkInstalling}
                    onChange={(e) => setReinstall(e.target.checked)}
                  />
                  覆盖 (-r)
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={installDowngrade}
                    disabled={!snOk || apkInstalling}
                    onChange={(e) => setInstallDowngrade(e.target.checked)}
                  />
                  降级 (-d)
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={installGrant}
                    disabled={!snOk || apkInstalling}
                    onChange={(e) => setInstallGrant(e.target.checked)}
                  />
                  授权 (-g)
                </label>
              </div>
            ) : null}
          </div>

          {!apkBoxCollapsed ? (
            <>
              <div className="apk-drop-hint">
                {apkDragOver
                  ? "松开加入列表（可安装 / 分析）"
                  : "将 .apk 拖到此处（安装与分析共用）"}
              </div>

          <div className="apk-install-bar">
            <label className="btn file-btn">
              添加 APK
              <input
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                multiple
                disabled={apkInstalling}
                hidden
                onChange={(e) => {
                  const files = collectApkFiles(e.target.files);
                  e.target.value = "";
                  enqueueApks(files);
                }}
              />
            </label>
            <label className="btn file-btn">
              添加文件夹
              <input
                type="file"
                multiple
                disabled={apkInstalling}
                hidden
                ref={(el) => {
                  if (el) el.setAttribute("webkitdirectory", "");
                }}
                onChange={(e) => {
                  const files = collectApkFiles(e.target.files);
                  e.target.value = "";
                  enqueueApks(files);
                }}
              />
            </label>
            <Button
              disabled={!apkQueue.length || apkInstalling}
              onClick={() =>
                setApkQueue((prev) => prev.filter((j) => j.status === "installing"))
              }
            >
              清空
            </Button>
            <Button
              disabled={
                apkInstalling ||
                !apkQueue.some((j) => j.status === "ok" || j.status === "fail")
              }
              onClick={() =>
                setApkQueue((prev) =>
                  prev.filter((j) => j.status === "queued" || j.status === "installing"),
                )
              }
            >
              清完成
            </Button>
            <span className="grow" />
            <Button
              disabled={
                busy ||
                apkInstalling ||
                !apkQueue.some((j) => j.status !== "installing")
              }
              title="分析列表中的全部 APK"
              onClick={() => void analyzeApkQueue()}
            >
              分析
            </Button>
            <Button
              variant="primary"
              loading={apkInstalling}
              disabled={
                !snOk ||
                apkInstalling ||
                !apkQueue.some((j) => j.status === "queued" || j.status === "fail")
              }
              onClick={() => void runApkQueue()}
            >
              {apkInstalling ? "安装中…" : "开始安装"}
            </Button>
          </div>

          {apkQueue.length ? (
            <div className="apk-queue">
              {apkQueue.map((j) => (
                <div key={j.id} className={`apk-job apk-job-${j.status}`}>
                  <span className={`apk-job-badge apk-job-badge-${j.status}`}>
                    {j.status === "queued"
                      ? "就绪"
                      : j.status === "installing"
                        ? "安装中"
                        : j.status === "ok"
                          ? "已装"
                          : "失败"}
                  </span>
                  <div className="apk-job-body">
                    <span className="apk-job-name" title={j.name}>
                      {j.name}
                    </span>
                    <span className="apk-job-meta">
                      {formatBytes(j.size)}
                      {j.message ? ` · ${j.message}` : ""}
                    </span>
                  </div>
                  <div className="apk-job-actions">
                    {j.analysis ? (
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={busy || apkInstalling}
                        title="查看分析结果"
                        onClick={() => openApkAnalysis(j)}
                      >
                        结果
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={j.status === "installing" || busy || apkInstalling}
                      title="分析此 APK"
                      onClick={() => void analyzeApkJob(j)}
                    >
                      分析
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={
                        !snOk || j.status === "installing" || busy || apkInstalling
                      }
                      title="分析并与当前设备对比"
                      onClick={() => void compareApkJob(j)}
                    >
                      对比
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={j.status === "installing" || apkInstalling}
                      title="移除"
                      onClick={() => removeApkJobs([j.id])}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
              }
            </div>
          ) : null}
            </>
          ) : null}
        </div>

        <div className="apps-toolbar">
          <div className="apps-scope">
            {PKG_SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`apps-chip${pkgScope === s.key ? " active" : ""}`}
                disabled={!snOk || busy}
                onClick={() => setPkgScope(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="apps-search-wrap">
            <input
              className="field mono apps-search-input"
              placeholder="模糊搜索包名…"
              value={pkgFilter}
              disabled={!snOk || busy}
              onChange={(e) => setPkgFilter(e.target.value)}
              aria-label="模糊搜索包名"
            />
            {pkgFilter ? (
              <button
                type="button"
                className="apps-search-clear"
                title="清空搜索"
                aria-label="清空搜索"
                onClick={() => setPkgFilter("")}
              >
                ×
              </button>
            ) : null}
          </div>
          <span className="apps-count">
            {filteredPkgs.length}
            {filteredPkgs.length !== packages.length ? ` / ${packages.length}` : ""}
          </span>
          <Button
            disabled={!snOk || busy}
            title="定位电视当前前台运行的应用"
            onClick={() => void locateForegroundApp()}
          >
            定位当前
          </Button>
          <Button
            disabled={!snOk || busy}
            onClick={() => void refreshPackages(true)}
          >
            刷新
          </Button>
        </div>

        {checkedPkgs.length > 0 ? (
          <div className="apps-batch-bar">
            <span className="apps-batch-count">已选 {checkedPkgs.length} 项</span>
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => setCheckedPkgs([...filteredPkgs])}
            >
              全选筛选 ({filteredPkgs.length})
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => setCheckedPkgs([])}
            >
              清空选择
            </button>
            <div className="apps-batch-actions">
              <Button
                size="sm"
                disabled={!snOk || busy}
                onClick={() => void exportPackages(checkedPkgs)}
              >
                批量导出
              </Button>
              <Button
                size="sm"
                disabled={!snOk || busy}
                onClick={() => void runBatchSetEnabled(checkedPkgs, true)}
              >
                批量启用
              </Button>
              <Button
                size="sm"
                disabled={!snOk || busy}
                onClick={() => void runBatchSetEnabled(checkedPkgs, false)}
              >
                批量停用
              </Button>
              <Button
                size="sm"
                disabled={!snOk || busy}
                onClick={() => void runBatchForceStop(checkedPkgs)}
              >
                批量强停
              </Button>
              <Button
                size="sm"
                disabled={!snOk || busy}
                onClick={() => void runBatchClearData(checkedPkgs)}
              >
                批量清数据
              </Button>
              <Button
                size="sm"
                variant="danger-ghost"
                disabled={!snOk || busy}
                onClick={() => void runBatchUninstall(checkedPkgs)}
              >
                批量卸载
              </Button>
            </div>
          </div>
        ) : null}

        <div className="apps-body">
          <div className="apps-list" ref={pkgListRef} role="listbox" aria-label="应用包名">
            {!snOk ? (
              <EmptyState
                className="apps-empty"
                title="打开设备标签后可管理应用"
              />
            ) : !packages.length && !busy ? (
              <EmptyState
                className="apps-empty"
                title="暂无包名"
                description="点「刷新」从设备加载已安装应用"
                action={
                  <Button
                    variant="primary"
                    disabled={!snOk || busy}
                    onClick={() => void refreshPackages(true)}
                  >
                    刷新
                  </Button>
                }
              />
            ) : !filteredPkgs.length ? (
              <EmptyState
                className="apps-empty"
                title={`没有匹配「${pkgFilter.trim()}」的包`}
              />
            ) : (
              filteredPkgs.map((p, idx) => {
                const isChecked = checkedSet.has(p);
                return (
                  <div
                    key={p}
                    data-pkg={p}
                    role="option"
                    aria-selected={pkgSelected === p}
                    tabIndex={0}
                    className={`apps-item${pkgSelected === p ? " selected" : ""}${isChecked ? " checked" : ""}`}
                    onClick={() => {
                      if (!busy) setPkgSelected(p);
                    }}
                    onContextMenu={(e) => {
                      if (busy || !snOk) return;
                      e.preventDefault();
                      setPkgSelected(p);
                      const maxW = window.innerWidth - 180;
                      const maxH = window.innerHeight - 280;
                      setPkgMenu({
                        x: Math.max(8, Math.min(e.clientX, maxW)),
                        y: Math.max(8, Math.min(e.clientY, maxH)),
                        pkg: p,
                      });
                    }}
                    onKeyDown={(e) => {
                      if (busy) return;
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const nextIdx =
                          e.key === "ArrowDown"
                            ? Math.min(filteredPkgs.length - 1, idx + 1)
                            : Math.max(0, idx - 1);
                        const nextPkg = filteredPkgs[nextIdx];
                        if (nextPkg) {
                          setPkgSelected(nextPkg);
                          const el = pkgListRef.current?.querySelector(
                            `[data-pkg="${CSS.escape(nextPkg)}"]`,
                          ) as HTMLElement | null;
                          el?.focus();
                          el?.scrollIntoView({ block: "nearest" });
                        }
                      } else if (e.key === " ") {
                        e.preventDefault();
                        toggleCheckPkg(p, idx, e.shiftKey);
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        setPkgSelected(p);
                      }
                    }}
                    onDoubleClick={() => {
                      if (busy) return;
                      void wrap(`启动 ${p}…`, async () => {
                        const r = await api.launchPackage(deviceSn, p);
                        onAppend(`[launch] ${p}\n${r.output}`);
                        onStatus(r.ok ? "已尝试启动" : "启动失败");
                      });
                    }}
                  >
                    <input
                      type="checkbox"
                      className="apps-item-check"
                      checked={isChecked}
                      disabled={busy}
                      aria-label={`勾选 ${p}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCheckPkg(p, idx, e.shiftKey);
                      }}
                      onChange={() => {
                        /* handled in onClick to capture shiftKey */
                      }}
                    />
                    <span className="apps-item-name">{p}</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="apps-actions">
            {!pkgSelected ? (
              <div className="apps-detail-empty">
                <strong>选择一个应用</strong>
                <span>详情区显示版本与 SDK，可复制信息并管理应用</span>
              </div>
            ) : (
              <div className="apps-detail">
                <div className="apps-detail-head">
                  <div className="apps-detail-kicker-row">
                    <span className="apps-detail-kicker">包名</span>
                    {pkgInfo && !pkgInfo.enabled ? (
                      <span className="apps-state-badge is-disabled">已停用</span>
                    ) : pkgInfo ? (
                      <span className="apps-state-badge is-enabled">已启用</span>
                    ) : null}
                  </div>
                  <code
                    className="apps-detail-pkg is-copyable"
                    title={`${pkgSelected}\n点击复制包名`}
                    onClick={() => copyText(pkgSelected, "包名")}
                  >
                    {pkgSelected}
                  </code>
                </div>

                {pkgInfoBusy ? (
                  <div className="apps-detail-status">读取信息…</div>
                ) : pkgInfoErr ? (
                  <div className="apps-detail-status is-err">{pkgInfoErr}</div>
                ) : pkgInfo ? (
                  <>
                    <div className="apps-detail-facts">
                      <div className="apps-fact">
                        <span>版本</span>
                        <strong>
                          {[
                            pkgInfo.version_name || "",
                            pkgInfo.version_code
                              ? `(${pkgInfo.version_code})`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || "—"}
                        </strong>
                      </div>
                      <div className="apps-fact">
                        <span>SDK</span>
                        <strong>
                          {[
                            pkgInfo.min_sdk
                              ? `min ${pkgInfo.min_sdk}`
                              : "",
                            pkgInfo.target_sdk
                              ? `target ${pkgInfo.target_sdk}`
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </strong>
                      </div>
                    </div>
                    {(pkgInfo.last_update_time ||
                      pkgInfo.first_install_time ||
                      pkgInfo.path) && (
                      <dl className="apps-detail-meta">
                        {pkgInfo.last_update_time ? (
                          <div>
                            <dt>更新</dt>
                            <dd title={pkgInfo.last_update_time}>
                              {pkgInfo.last_update_time}
                            </dd>
                          </div>
                        ) : null}
                        {pkgInfo.first_install_time ? (
                          <div>
                            <dt>安装</dt>
                            <dd title={pkgInfo.first_install_time}>
                              {pkgInfo.first_install_time}
                            </dd>
                          </div>
                        ) : null}
                        {pkgInfo.path ? (
                          <div className="apps-detail-path">
                            <dt>路径</dt>
                            <dd
                              className="is-copyable"
                              title={`${pkgInfo.path}\n点击复制安装路径`}
                              onClick={() => copyText(pkgInfo.path, "安装路径")}
                            >
                              {pkgInfo.path}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    )}
                  </>
                ) : (
                  <div className="apps-detail-status">暂无版本信息</div>
                )}
              </div>
            )}

            <div className="apps-action-grid">
              <Button
                variant="primary"
                disabled={!snOk || busy || !pkgSelected}
                title="双击列表项也可启动"
                onClick={() =>
                  void wrap(`启动 ${pkgSelected}…`, async () => {
                    const r = await api.launchPackage(deviceSn, pkgSelected);
                    onAppend(`[launch] ${pkgSelected}\n${r.output}`);
                    onStatus(r.ok ? "已尝试启动" : "启动失败");
                  })
                }
              >
                启动
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                title="先强制停止再重新启动"
                onClick={() =>
                  void wrap(`重启 ${pkgSelected}…`, async () => {
                    const r = await api.restartPackage(deviceSn, pkgSelected);
                    onAppend(`[restart] ${pkgSelected}\n${r.output}`);
                    onStatus(r.ok ? "已重启应用" : "重启失败");
                  })
                }
              >
                重启
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                onClick={() =>
                  void wrap(`强制停止 ${pkgSelected}…`, async () => {
                    const r = await api.forceStopPackage(deviceSn, pkgSelected);
                    onAppend(`[force-stop] ${pkgSelected}\n${r.output}`);
                    onStatus(r.ok ? "已强制停止" : "停止失败");
                  })
                }
              >
                强停
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                onClick={() => {
                  void dialog
                    .confirm({
                      title: "清空应用数据",
                      message:
                        "将清除该应用的用户数据与缓存（等同 pm clear），应用本身不会被卸载。",
                      detail: pkgSelected,
                      note: "此操作不可恢复，请确认后再继续。",
                      confirmLabel: "清空数据",
                      cancelLabel: "再想想",
                      danger: true,
                    })
                    .then((ok) => {
                      if (!ok) return;
                      void wrap(`清空数据 ${pkgSelected}…`, async () => {
                        const r = await api.clearPackageData(
                          deviceSn,
                          pkgSelected,
                        );
                        onAppend(`[pm clear] ${pkgSelected}\n${r.output}`);
                        onStatus(r.ok ? "已清空数据" : "清空失败");
                      });
                    });
                }}
              >
                清数据
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                title={
                  pkgInfo && !pkgInfo.enabled
                    ? "重新启用该应用 (pm enable)"
                    : "停用该应用 (pm disable-user)"
                }
                onClick={() =>
                  void togglePackageEnabled(pkgSelected, pkgInfo ? !pkgInfo.enabled : false)
                }
              >
                {pkgInfo && !pkgInfo.enabled ? "启用" : "停用"}
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                title="从设备导出该应用的 APK 文件到电脑"
                onClick={() => void exportPackages([pkgSelected])}
              >
                导出 APK
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                title="查看并开关该应用的运行时权限"
                onClick={() => {
                  setPermQuery("");
                  setPermOpen(true);
                }}
              >
                {pkgInfo
                  ? `权限 (${pkgInfo.runtime_granted.length}/${pkgInfo.runtime_granted.length + pkgInfo.runtime_denied.length})`
                  : "权限管理"}
              </Button>
              <Button
                disabled={!snOk || busy || !pkgSelected}
                title="复制包名、版本、SDK"
                onClick={() => {
                  if (!pkgSelected) return;
                  const lines = [`包名: ${pkgSelected}`];
                  if (pkgInfo?.version_name || pkgInfo?.version_code) {
                    const ver = [
                      pkgInfo.version_name || "",
                      pkgInfo.version_code
                        ? `(${pkgInfo.version_code})`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    lines.push(`版本: ${ver}`);
                  }
                  const sdk = [
                    pkgInfo?.min_sdk ? `min ${pkgInfo.min_sdk}` : "",
                    pkgInfo?.target_sdk
                      ? `target ${pkgInfo.target_sdk}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  if (sdk) lines.push(`SDK: ${sdk}`);
                  const text = lines.join("\n");
                  void navigator.clipboard.writeText(text).then(
                    () => onStatus("已复制包名 / 版本 / SDK"),
                    () => onStatus("复制失败"),
                  );
                }}
              >
                复制信息
              </Button>
            </div>
            <label className="check apps-keep">
              <input
                type="checkbox"
                checked={keepData}
                disabled={!snOk || busy}
                onChange={(e) => setKeepData(e.target.checked)}
              />
              卸载时保留数据与缓存 (-k)
            </label>
            <Button
              variant="danger-ghost"
              className="apps-uninstall"
              disabled={!snOk || busy || !pkgSelected}
              onClick={() => {
                void dialog
                  .confirm({
                    title: "卸载应用",
                    message: keepData
                      ? "将卸载该应用，并保留其数据与缓存（-k）。"
                      : "将从设备卸载该应用及其数据。",
                    detail: pkgSelected,
                    note: keepData
                      ? "应用会被移除，但用户数据会保留。"
                      : "此操作不可恢复，应用与数据都会被删除。",
                    confirmLabel: "卸载",
                    cancelLabel: "再想想",
                    danger: true,
                  })
                  .then((ok) => {
                    if (!ok) return;
                    void wrap(`卸载 ${pkgSelected}…`, async () => {
                      const r = await api.uninstall(
                        deviceSn,
                        pkgSelected,
                        keepData,
                      );
                      onAppend(`[uninstall] ${pkgSelected}\n${r.output}`);
                      onStatus(r.ok ? "卸载完成" : "卸载失败");
                      if (r.ok) {
                        setPackages((prev) =>
                          prev.filter((x) => x !== pkgSelected),
                        );
                      }
                    });
                  });
              }}
            >
              卸载应用
            </Button>
            <p className="apps-hint" title="上方拖入区可分析/对比或安装；双击包名可启动，右键可快捷操作">
              拖入区可分析/对比或安装；双击启动，右键快捷操作
            </p>
          </div>
        </div>
      </div>

      {pkgMenu ? (
        <div
          className="apps-ctx-menu"
          style={{ left: pkgMenu.x, top: pkgMenu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              void wrap(`启动 ${target}…`, async () => {
                const r = await api.launchPackage(deviceSn, target);
                onAppend(`[launch] ${target}\n${r.output}`);
                onStatus(r.ok ? "已尝试启动" : "启动失败");
              });
            }}
          >
            启动应用
          </button>
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              void wrap(`重启 ${target}…`, async () => {
                const r = await api.restartPackage(deviceSn, target);
                onAppend(`[restart] ${target}\n${r.output}`);
                onStatus(r.ok ? "已重启应用" : "重启失败");
              });
            }}
          >
            重启应用
          </button>
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              void wrap(`强制停止 ${target}…`, async () => {
                const r = await api.forceStopPackage(deviceSn, target);
                onAppend(`[force-stop] ${target}\n${r.output}`);
                onStatus(r.ok ? "已强制停止" : "停止失败");
              });
            }}
          >
            强制停止
          </button>
          <div className="apps-ctx-sep" />
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              void exportPackages([target]);
            }}
          >
            导出 APK
          </button>
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              setPermQuery("");
              setPermOpen(true);
              if (target !== pkgSelected) setPkgSelected(target);
            }}
          >
            权限管理
          </button>
          <button
            type="button"
            className="apps-ctx-item"
            onClick={() => {
              const target = pkgMenu.pkg;
              setPkgMenu(null);
              copyText(target, "包名");
            }}
          >
            复制包名
          </button>
        </div>
      ) : null}

      <ApkAnalyzeModal
        open={apkResultOpen}
        results={apkResults}
        activeIndex={apkResultIdx}
        onClose={() => setApkResultOpen(false)}
        onCopySummary={(msg) => onStatus(msg || "已复制")}
      />

      <Modal
        open={permOpen}
        onClose={() => setPermOpen(false)}
        title={`权限管理 · ${pkgSelected || ""}`}
        footer={
          <>
            <Button
              disabled={pkgInfoBusy || Boolean(permBusyKey)}
              onClick={() => setPkgInfoNonce((n) => n + 1)}
            >
              {pkgInfoBusy ? "刷新中…" : "刷新状态"}
            </Button>
            <Button
              disabled={!pkgInfo?.runtime_denied.length || Boolean(permBusyKey)}
              variant="primary"
              onClick={() => void grantAllDeniedPermissions()}
            >
              {permBusyKey === "__ALL__"
                ? "授权中…"
                : `一键授权未授 (${pkgInfo?.runtime_denied.length ?? 0})`}
            </Button>
            <Button onClick={() => setPermOpen(false)}>关闭</Button>
          </>
        }
      >
        <div className="apps-perm-modal">
          <div className="apps-perm-toolbar">
            <input
              type="text"
              className="field mono apps-perm-search"
              value={permQuery}
              onChange={(e) => setPermQuery(e.target.value)}
              placeholder="搜索权限名（如 STORAGE / AUDIO）"
            />
            <label className="check">
              <input
                type="checkbox"
                checked={permRuntimeOnly}
                onChange={(e) => setPermRuntimeOnly(e.target.checked)}
              />
              仅显示可切换运行时权限
            </label>
          </div>

          {pkgInfoBusy && !pkgInfo ? (
            <EmptyState className="apps-empty" title="正在读取权限信息…" />
          ) : !pkgInfo ? (
            <EmptyState className="apps-empty" title="暂无权限信息" />
          ) : (
            (() => {
              const q = permQuery.trim().toLowerCase();
              const runtimeSet = new Set([
                ...pkgInfo.runtime_granted,
                ...pkgInfo.runtime_denied,
              ]);
              const grantedSet = new Set(pkgInfo.runtime_granted);
              const installSet = new Set(pkgInfo.install_granted);
              const baseList = permRuntimeOnly
                ? [
                    ...pkgInfo.runtime_denied,
                    ...pkgInfo.runtime_granted,
                  ]
                : Array.from(
                    new Set([
                      ...pkgInfo.runtime_denied,
                      ...pkgInfo.runtime_granted,
                      ...pkgInfo.install_granted,
                      ...pkgInfo.permissions,
                    ]),
                  );
              const filtered = q
                ? baseList.filter((p) => p.toLowerCase().includes(q))
                : baseList;
              return (
                <>
                  <div className="apps-perm-stats">
                    <span>运行时已授 {pkgInfo.runtime_granted.length}</span>
                    <span>运行时未授 {pkgInfo.runtime_denied.length}</span>
                    <span>系统默认 {pkgInfo.install_granted.length}</span>
                    <span>总声明 {pkgInfo.permissions.length}</span>
                  </div>
                  <div className="apps-perm-list">
                    {!filtered.length ? (
                      <EmptyState
                        className="apps-empty"
                        title={
                          permRuntimeOnly && !runtimeSet.size
                            ? "该应用无运行时动态权限"
                            : "没有匹配的权限"
                        }
                        description={
                          permRuntimeOnly && !runtimeSet.size
                            ? "可取消勾选「仅显示可切换运行时权限」查看全部声明权限"
                            : undefined
                        }
                      />
                    ) : (
                      filtered.map((perm) => {
                        const isRuntime = runtimeSet.has(perm);
                        const isGranted = isRuntime
                          ? grantedSet.has(perm)
                          : installSet.has(perm);
                        const isBusy = permBusyKey === perm || permBusyKey === "__ALL__";
                        return (
                          <div key={perm} className="apps-perm-row">
                            <div className="apps-perm-name">
                              <code>{perm}</code>
                              <span
                                className={`apps-perm-tag ${
                                  isRuntime
                                    ? isGranted
                                      ? "is-granted"
                                      : "is-denied"
                                    : "is-install"
                                }`}
                              >
                                {isRuntime
                                  ? isGranted
                                    ? "运行时已授"
                                    : "运行时未授"
                                  : isGranted
                                    ? "安装默认授予"
                                    : "声明权限"}
                              </span>
                            </div>
                            {isRuntime ? (
                              <Button
                                size="sm"
                                variant={isGranted ? "ghost" : "primary"}
                                disabled={isBusy || !snOk}
                                onClick={() => void togglePermission(perm, !isGranted)}
                              >
                                {permBusyKey === perm
                                  ? "处理中…"
                                  : isGranted
                                    ? "撤销"
                                    : "授权"}
                              </Button>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              );
            })()
          )}
        </div>
      </Modal>
    </>
  );
}
