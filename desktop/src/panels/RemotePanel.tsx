import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api, wsUrl } from "../api/client";
import { readAppPrefs, subscribeAppPrefs } from "../appPrefs";
import { useDialog } from "../components/dialog";
import Modal from "../components/Modal";
import { useStatusNotify } from "../components/toast";
import { Button } from "../ui";
import {
  type Action,
  DPAD_GLYPH,
  DPAD_LAYOUT,
  EMPTY_ACCOUNT_DRAFT,
  formatRemain,
  isInjectableChar,
  KEY_MAP,
  type LoginAccount,
  NEXT_OPTIONS,
  parseDataUrl,
  RECONNECT_TIMEOUT_SEC,
  type Shot,
  shotFileName,
} from "./remote/remoteHelpers";
import ShotEditorModal from "./remote/ShotEditorModal";

type Props = {
  deviceSn: string;
  browseOnly?: boolean;
  /** 当前是否为可见遥控页；切走不卸载，投屏会话与最后一帧保留 */
  active?: boolean;
  /** 设备是否在线；false 时结束投屏；录屏中则等待重连 */
  deviceOnline?: boolean;
  /** 录屏/等待重连时通知父级：不要用全页遮罩盖住停止录屏 */
  onHoldChange?: (hold: boolean) => void;
};

export default function RemotePanel({
  deviceSn,
  browseOnly,
  active = true,
  deviceOnline,
  onHoldChange,
}: Props) {
  const dialog = useDialog();
  const [actions, setActions] = useState<Action[]>([]);
  const [text, setText] = useState("");
  const [log, setLog] = useState("");
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);
  const [frameUrl, setFrameUrl] = useState("");
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const [embedAvail, setEmbedAvail] = useState(false);
  const [embedReason, setEmbedReason] = useState("");
  const [embedLive, setEmbedLive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [fallbackOn, setFallbackOn] = useState(false);
  const [kbdOn, setKbdOn] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [lastShot, setLastShot] = useState<Shot | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const [shotEditorOpen, setShotEditorOpen] = useState(false);
  const [showShotThumb, setShowShotThumb] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordPath, setRecordPath] = useState("");
  const [waitingReconnect, setWaitingReconnect] = useState(false);
  const [reconnectRemain, setReconnectRemain] = useState(0);
  const [streamBusy, setStreamBusy] = useState(false);
  const [streamBusyTitle, setStreamBusyTitle] = useState("正在安装应用");
  const [streamBusyText, setStreamBusyText] = useState("");
  const [scrcpyMaxSide, setScrcpyMaxSide] = useState(
    () => readAppPrefs().scrcpyMaxSide,
  );
  const [previewMaxSide, setPreviewMaxSide] = useState(
    () => readAppPrefs().remotePreviewMaxSide,
  );
  const [previewPollMs, setPreviewPollMs] = useState(
    () => readAppPrefs().remotePreviewPollMs,
  );
  const reconnectSecRef = useRef(readAppPrefs().scrcpyReconnectSec);
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountDraft, setAccountDraft] = useState<LoginAccount[]>([]);
  const [accountEditIdx, setAccountEditIdx] = useState(-1);
  const [accountForm, setAccountForm] = useState<LoginAccount>(EMPTY_ACCOUNT_DRAFT);
  const [accountSaving, setAccountSaving] = useState(false);
  const repeatTimerRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);
  const repeatFiredRef = useRef(false);
  const polling = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewImgRef = useRef<HTMLImageElement | null>(null);
  const hasLiveFrameRef = useRef(false);
  const liveFrameRef = useRef<{ mime: string; b64: string } | null>(null);
  const liveBlobUrlRef = useRef("");
  const frameRafRef = useRef<number | null>(null);
  const embedWs = useRef<WebSocket | null>(null);
  const embedEpoch = useRef(0);
  const recordingRef = useRef(false);
  const waitingReconnectRef = useRef(false);
  const reconnectDeadlineRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const snOk = Boolean(deviceSn) && !browseOnly;
  const linked = snOk && deviceOnline !== false;
  recordingRef.current = recording;
  waitingReconnectRef.current = waitingReconnect;

  useEffect(() => {
    onHoldChange?.(recording || waitingReconnect);
  }, [recording, waitingReconnect, onHoldChange]);

  useEffect(() => {
    return subscribeAppPrefs((p) => {
      setScrcpyMaxSide(p.scrcpyMaxSide);
      setPreviewMaxSide(p.remotePreviewMaxSide);
      setPreviewPollMs(p.remotePreviewPollMs);
      reconnectSecRef.current = p.scrcpyReconnectSec;
    });
  }, []);

  useEffect(() => {
    return () => onHoldChange?.(false);
    // 仅卸载时解除 hold，避免父级回调换身份时误清
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actionMap = useMemo(() => {
    const m = new Map<string, Action>();
    for (const a of actions) m.set(a.label, a);
    return m;
  }, [actions]);

  const apps = useMemo(
    () => actions.filter((a) => a.kind !== "key" && a.kind !== "tv_settings"),
    [actions],
  );

  useEffect(() => {
    void api
      .remoteActions()
      .then((r) => setActions(r.actions))
      .catch((e: unknown) => setStatus(`加载遥控器按键配置失败：${toErrorMessage(e)}`));
  }, []);

  useEffect(() => {
    if (active === false) return;
    let cancelled = false;
    void api
      .remoteAccounts()
      .then((r) => {
        if (cancelled) return;
        setAccounts(r.accounts);
        setAccountId((prev) => {
          if (prev && r.accounts.some((a) => a.id === prev)) return prev;
          return r.accounts[0]?.id || "";
        });
      })
      .catch(() => {
        /* 旧 API 无此接口时忽略 */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === accountId) || null,
    [accounts, accountId],
  );

  function flushLiveFrame() {
    frameRafRef.current = null;
    const latest = liveFrameRef.current;
    const img = previewImgRef.current;
    if (!latest || !img) return;
    try {
      const raw = atob(latest.b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
      }
      const nextUrl = URL.createObjectURL(
        new Blob([bytes], { type: latest.mime || "image/jpeg" }),
      );
      const prevUrl = liveBlobUrlRef.current;
      liveBlobUrlRef.current = nextUrl;
      img.src = nextUrl;
      if (prevUrl) {
        URL.revokeObjectURL(prevUrl);
      }
    } catch {
      /* ignore invalid frame */
    }
  }

  function pushLiveFrame(mime: string, b64: string) {
    liveFrameRef.current = { mime: mime || "image/jpeg", b64 };
    if (!hasLiveFrameRef.current) {
      hasLiveFrameRef.current = true;
      setHasLiveFrame(true);
    }
    if (frameRafRef.current == null) {
      frameRafRef.current = window.requestAnimationFrame(flushLiveFrame);
    }
  }

  function clearAllFrames() {
    if (frameRafRef.current != null) {
      window.cancelAnimationFrame(frameRafRef.current);
      frameRafRef.current = null;
    }
    liveFrameRef.current = null;
    if (liveBlobUrlRef.current) {
      URL.revokeObjectURL(liveBlobUrlRef.current);
      liveBlobUrlRef.current = "";
    }
    if (hasLiveFrameRef.current) {
      hasLiveFrameRef.current = false;
      setHasLiveFrame(false);
    }
    setFrameUrl("");
  }

  useEffect(() => {
    if (!snOk) {
      stopEmbed();
      setFallbackOn(false);
      clearAllFrames();
      setKbdOn(false);
      setConnecting(false);
      setRecording(false);
      return;
    }
    void api
      .scrcpyStatus(deviceSn)
      .then((r) => {
        setEmbedAvail(Boolean(r.embed_available));
        setEmbedReason(r.embed_reason || "");
        if (r.recording) {
          setRecording(true);
          setRecordPath(r.record_path || "");
        }
      })
      .catch(() => {
        setEmbedAvail(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceSn, snOk]);

  /** 设备离线：录屏中则等待重连，否则立刻清屏 */
  useEffect(() => {
    if (deviceOnline !== false) {
      if (waitingReconnectRef.current && deviceOnline === true) {
        clearReconnectWait();
        appendLog("[投屏] 设备已重连，恢复投屏并继续录屏…");
        setStatus("设备已重连，正在恢复…");
        startEmbed({ resumeRecord: true });
      }
      return;
    }
    if (recordingRef.current || waitingReconnectRef.current) {
      enterReconnectWait("ADB 设备已断开");
      return;
    }
    const hadSession =
      Boolean(embedWs.current) ||
      connecting ||
      embedLive ||
      fallbackOn ||
      Boolean(frameUrl) ||
      hasLiveFrameRef.current;
    stopEmbed();
    setFallbackOn(false);
    clearAllFrames();
    setKbdOn(false);
    if (hadSession) {
      setStatus("设备已断开，投屏已停止");
      appendLog("[投屏] 设备离线，已清空画面");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceOnline]);

  useEffect(() => {
    return () => {
      clearReconnectTimer();
      stopEmbed();
      if (frameRafRef.current != null) {
        window.cancelAnimationFrame(frameRafRef.current);
        frameRafRef.current = null;
      }
      if (liveBlobUrlRef.current) {
        URL.revokeObjectURL(liveBlobUrlRef.current);
        liveBlobUrlRef.current = "";
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 不可见时暂停截图轮询，但保留已有画面；内嵌 scrcpy WS 继续跑
    if (!active || !fallbackOn || !snOk || embedLive) return;
    let cancelled = false;
    const tick = async () => {
      if (polling.current || cancelled) return;
      polling.current = true;
      try {
        const r = await api.remotePreview(deviceSn, previewMaxSide);
        if (!cancelled) {
          pushLiveFrame(r.mime || "image/jpeg", r.jpeg_base64);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus(`备用预览拉取失败：${toErrorMessage(e)}`);
          setFallbackOn(false);
        }
      } finally {
        polling.current = false;
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), previewPollMs);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [active, fallbackOn, snOk, deviceSn, embedLive, previewMaxSide, previewPollMs]);

  useEffect(() => {
    if (!active) return;
    if (kbdOn || embedLive) previewRef.current?.focus();
  }, [active, kbdOn, embedLive]);

  function appendLog(line: string) {
    setLog((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      return next.length > 60000 ? next.slice(-48000) : next;
    });
  }

  function clearReconnectTimer() {
    if (reconnectTimerRef.current != null) {
      window.clearInterval(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }

  function clearReconnectWait() {
    clearReconnectTimer();
    waitingReconnectRef.current = false;
    reconnectDeadlineRef.current = 0;
    setWaitingReconnect(false);
    setReconnectRemain(0);
  }

  function enterReconnectWait(reason: string) {
    if (!recordingRef.current && !waitingReconnectRef.current) {
      stopEmbed({ statusText: "投屏已停止" });
      clearAllFrames();
      return;
    }
    const waitSec = Math.max(60, reconnectSecRef.current || RECONNECT_TIMEOUT_SEC);
    const first = !waitingReconnectRef.current;
    // 先标记，避免关 WS 的 onclose 再次重入
    waitingReconnectRef.current = true;
    setWaitingReconnect(true);
    if (first) {
      const mins = Math.max(1, Math.round(waitSec / 60));
      appendLog(
        `[投屏] ${reason}，录屏保留，等待重连（约 ${mins} 分钟）…`,
      );
      stopEmbed({
        notifyBackend: true,
        keepRecord: true,
        clearFrame: false,
        statusText: `等待重连（${formatRemain(waitSec)}）…`,
      });
      setRecording(true);
      reconnectDeadlineRef.current = Date.now() + waitSec * 1000;
      setReconnectRemain(waitSec);
    }
    clearReconnectTimer();
    reconnectTimerRef.current = window.setInterval(() => {
      const left = Math.max(
        0,
        Math.ceil((reconnectDeadlineRef.current - Date.now()) / 1000),
      );
      setReconnectRemain(left);
      setStatus(`等待设备重连 ${formatRemain(left)}（录屏中）`);
      if (left <= 0) {
        const usedSec = Math.max(60, reconnectSecRef.current || RECONNECT_TIMEOUT_SEC);
        clearReconnectWait();
        stopEmbed({
          notifyBackend: true,
          keepRecord: false,
          clearFrame: true,
          statusText: "重连超时，投屏与录屏已停止",
        });
        appendLog(
          `[投屏] 等待重连超过 ${Math.max(1, Math.round(usedSec / 60))} 分钟，已断开`,
        );
      }
    }, 1000);
  }

  function stopEmbed(opts?: {
    notifyBackend?: boolean;
    statusText?: string;
    keepRecord?: boolean;
    clearFrame?: boolean;
  }) {
    const wasRecording = recordingRef.current;
    const keepRecord = Boolean(opts?.keepRecord);
    embedEpoch.current += 1;
    const ws = embedWs.current;
    embedWs.current = null;
    setEmbedLive(false);
    setConnecting(false);
    setStreamBusy(false);
    setStreamBusyText("");
    if (opts?.clearFrame !== false && !keepRecord) {
      clearAllFrames();
    }
    if (!keepRecord) {
      setKbdOn(false);
      setRecording(false);
      clearReconnectWait();
    }
    if (ws) {
      try {
        // 保留录屏时不要发 stop，否则后端会结束录像
        if (ws.readyState === WebSocket.OPEN && !keepRecord) {
          ws.send(JSON.stringify({ type: "stop" }));
        }
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (opts?.statusText) setStatus(opts.statusText);
    if (opts?.notifyBackend !== false && snOk && deviceSn) {
      void (async () => {
        if (wasRecording && !keepRecord) {
          try {
            const r = await api.scrcpyRecordStop(deviceSn);
            if (r.path) setRecordPath(r.path);
            if (r.stopped) appendLog(`[录屏] ${r.message}`);
          } catch {
            /* ignore */
          }
        }
        await api.scrcpyStop(deviceSn, keepRecord).catch(() => {
          /* ignore */
        });
      })();
    }
  }

  function startEmbed(opts?: { resumeRecord?: boolean }) {
    if (!snOk) return;
    if (deviceOnline === false && !opts?.resumeRecord) {
      setStatus("设备离线，无法投屏");
      return;
    }
    const resume = Boolean(opts?.resumeRecord);
    clearReconnectWait();
    stopEmbed({
      notifyBackend: false,
      keepRecord: resume,
      clearFrame: !resume,
    });
    setFallbackOn(false);
    if (!resume) setRecording(false);
    else setRecording(true);
    const epoch = ++embedEpoch.current;
    setConnecting(true);
    setStatus(resume ? "重连投屏中…" : "正在连接内嵌 scrcpy…");
    const ws = new WebSocket(
      wsUrl(api.scrcpyEmbedWsPath(deviceSn, scrcpyMaxSide)),
    );
    embedWs.current = ws;
    ws.onmessage = (ev) => {
      if (embedEpoch.current !== epoch) return;
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          text?: string;
          reason?: string;
          mime?: string;
          jpeg_base64?: string;
          timeout_sec?: number;
          on?: boolean;
        };
        if (msg.type === "started") {
          setEmbedLive(true);
          setConnecting(false);
          setStatus(resume || recordingRef.current ? "投屏中（录屏）" : "投屏中");
          setKbdOn(true);
          appendLog(
            resume
              ? "[scrcpy] 重连成功，继续录屏"
              : "[scrcpy] 内嵌投屏已启动",
          );
          previewRef.current?.focus();
        } else if (msg.type === "frame" && msg.jpeg_base64) {
          pushLiveFrame(msg.mime || "image/jpeg", msg.jpeg_base64);
        } else if (msg.type === "busy") {
          setStreamBusy(Boolean(msg.on));
          setStreamBusyTitle(
            msg.reason === "install" || !msg.reason ? "正在安装应用" : "ADB 繁忙中",
          );
          setStreamBusyText(msg.on ? msg.text || "投屏保持当前画面，完成后自动恢复" : "");
          if (msg.on) setStatus(msg.text || "正在安装应用，投屏保持最后一帧");
          else setStatus(recordingRef.current ? "投屏中（录屏）" : "投屏中");
        } else if (msg.type === "waiting_reconnect") {
          enterReconnectWait(msg.text || "投屏已断开");
        } else if (msg.type === "error" && msg.text) {
          appendLog(`[scrcpy] ${msg.text}`);
          setEmbedLive(false);
          setConnecting(false);
          if (recordingRef.current) {
            enterReconnectWait(msg.text);
          } else {
            clearAllFrames();
            setStatus(msg.text);
          }
        } else if (msg.type === "stopped") {
          setEmbedLive(false);
          setConnecting(false);
          if (recordingRef.current) {
            enterReconnectWait("投屏已停止");
          } else {
            clearAllFrames();
            setRecording(false);
            setStatus("投屏已停止");
          }
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      if (embedEpoch.current !== epoch) return;
      setEmbedLive(false);
      setConnecting(false);
      if (recordingRef.current) {
        enterReconnectWait("内嵌 scrcpy 连接失败");
      } else {
        setStatus("内嵌 scrcpy 连接失败");
        clearAllFrames();
        setRecording(false);
      }
    };
    ws.onclose = () => {
      if (embedEpoch.current !== epoch) return;
      if (embedWs.current === ws) embedWs.current = null;
      setEmbedLive(false);
      setConnecting(false);
      if (recordingRef.current && !waitingReconnectRef.current) {
        enterReconnectWait("投屏连接已断开");
        return;
      }
      if (!waitingReconnectRef.current) {
        clearAllFrames();
        setRecording(false);
        setStatus((prev) =>
          prev === "投屏中" || prev.startsWith("录屏中") || prev.includes("投屏中")
            ? "投屏已断开"
            : prev,
        );
      }
    };
  }

  async function toggleRecord() {
    if (!snOk || recordBusy) return;
    if (!recording && !linked) {
      setStatus("设备已断开，无法开始录屏");
      return;
    }
    if (!embedLive && !recording) {
      setStatus("请先开始投屏再录屏");
      return;
    }
    setRecordBusy(true);
    try {
      if (recording) {
        const r = await api.scrcpyRecordStop(deviceSn);
        setRecording(false);
        if (r.path) setRecordPath(r.path);
        appendLog(`[录屏] ${r.message}`);
        setStatus(
          r.stopped
            ? `录屏已保存${r.frames != null ? ` · ${r.frames} 帧` : ""}`
            : r.message,
        );
        if (waitingReconnectRef.current) {
          clearReconnectWait();
          stopEmbed({
            notifyBackend: true,
            keepRecord: false,
            clearFrame: true,
            statusText: "录屏已停止，已结束等待",
          });
        }
      } else {
        const r = await api.scrcpyRecordStart(deviceSn);
        setRecording(true);
        setRecordPath(r.path || "");
        appendLog(`[录屏] ${r.message}`);
        setStatus("录屏中…");
      }
    } catch (e) {
      setStatus(`${recording ? "停止" : "开始"}录屏失败：${toErrorMessage(e)}`);
    } finally {
      setRecordBusy(false);
    }
  }

  async function openRecordFile() {
    if (!recordPath) return;
    try {
      const r = await api.openPath(recordPath);
      setStatus(r.message || "已打开录屏文件");
    } catch (e) {
      setStatus(`打开录屏文件失败：${toErrorMessage(e)}`);
    }
  }

  async function captureShot() {
    if (!linked || shotBusy) return;
    setShotBusy(true);
    setStatus("截图中…");
    try {
      let shot: Shot;
      if (embedLive && liveFrameRef.current) {
        shot = {
          mime: liveFrameRef.current.mime,
          b64: liveFrameRef.current.b64,
        };
      } else if (embedLive && frameUrl) {
        const parsed = parseDataUrl(frameUrl);
        if (!parsed) throw new Error("当前画面不可用");
        shot = parsed;
      } else {
        const r = await api.screencap(deviceSn);
        shot = {
          mime: r.mime,
          b64: r.png_base64,
          width: r.width,
          height: r.height,
        };
        if (!embedLive && !fallbackOn) {
          setFrameUrl(`data:${r.mime};base64,${r.png_base64}`);
        }
      }
      setLastShot(shot);
      setShowShotThumb(true);
      const dim =
        shot.width && shot.height ? `${shot.width}×${shot.height}` : "已捕获";
      appendLog(`[截图] ${dim}`);
      setStatus("截图完成 · 点击图片可裁剪/标注");
    } catch (e) {
      setStatus(`截图失败：${toErrorMessage(e)}`);
    } finally {
      setShotBusy(false);
    }
  }

  function applyEditedShot(edited: Shot) {
    setLastShot(edited);
    setShowShotThumb(true);
    if (!embedLive && !fallbackOn) {
      setFrameUrl(`data:${edited.mime};base64,${edited.b64}`);
    }
  }

  function saveShot(targetShot?: Shot) {
    const target = targetShot || lastShot;
    if (!target) return;
    if (targetShot) applyEditedShot(targetShot);
    const name = shotFileName(deviceSn, target.mime);
    const a = document.createElement("a");
    a.href = `data:${target.mime};base64,${target.b64}`;
    a.download = name;
    a.click();
    appendLog(`[截图] 已保存 ${name}`);
    setStatus(`已保存 ${name}`);
  }

  async function copyShot(targetShot?: Shot) {
    const target = targetShot || lastShot;
    if (!target || shotBusy) return;
    if (targetShot) applyEditedShot(targetShot);
    setShotBusy(true);
    setStatus("复制到剪贴板…");
    try {
      const bin = atob(target.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: target.mime });
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ [target.mime]: blob }),
        ]);
      } else {
        await api.screencapClipboard(target.b64);
      }
      appendLog(targetShot ? "[截图] 已编辑并复制到剪贴板" : "[截图] 已复制到剪贴板");
      setStatus(targetShot ? "已复制编辑后的截图" : "已复制到剪贴板");
    } catch {
      try {
        await api.screencapClipboard(target.b64);
        appendLog(targetShot ? "[截图] 已编辑并复制到剪贴板" : "[截图] 已复制到剪贴板");
        setStatus(targetShot ? "已复制编辑后的截图" : "已复制到剪贴板");
      } catch (e) {
        setStatus(`复制截图到剪贴板失败：${toErrorMessage(e)}`);
      }
    } finally {
      setShotBusy(false);
    }
  }

  async function run(label: string, confirm?: string) {
    if (!linked) return;
    if (confirm) {
      const ok = await dialog.confirm({
        title: label,
        message: confirm,
        confirmLabel: "执行",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setStatus(`执行 ${label}…`);
    try {
      const r = await api.remoteAction(deviceSn, label);
      appendLog(`[${label}] ${r.message}`);
      setStatus("完成");
    } catch (e) {
      setStatus(`执行「${label}」失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendKey(
    keycode: number,
    name: string,
    opts?: { longpress?: boolean },
  ) {
    if (!linked) return;
    const lp = Boolean(opts?.longpress);
    const ws = embedWs.current;
    if (!lp && ws && ws.readyState === WebSocket.OPEN && embedLive) {
      ws.send(JSON.stringify({ type: "key", keycode }));
      setStatus(`按键 ${name}`);
      return;
    }
    try {
      await api.remoteKeyevent(deviceSn, keycode, lp);
      setStatus(`${lp ? "长按" : "按键"} ${name}`);
    } catch (e) {
      setStatus(`发送按键「${name}」失败：${toErrorMessage(e)}`);
    }
  }

  function stopHoldRepeat() {
    if (repeatTimerRef.current != null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
    if (repeatIntervalRef.current != null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  }

  function startHoldRepeat(keycode: number, name: string, repeatable?: boolean) {
    stopHoldRepeat();
    repeatFiredRef.current = false;
    if (!repeatable || !linked) return;
    repeatTimerRef.current = window.setTimeout(() => {
      repeatTimerRef.current = null;
      repeatFiredRef.current = true;
      void sendKey(keycode, name, { longpress: false });
      repeatIntervalRef.current = window.setInterval(() => {
        void sendKey(keycode, name, { longpress: false });
      }, 130);
    }, 340);
  }

  async function sendChar(ch: string) {
    if (!linked || !ch) return;
    try {
      await api.remoteText(deviceSn, ch);
      setStatus(`输入 ${ch}`);
    } catch (e) {
      setStatus(`输入字符失败：${toErrorMessage(e)}`);
    }
  }

  function openAccountManager() {
    const draft = accounts.map((a) => ({ ...a }));
    setAccountDraft(draft);
    if (draft.length) {
      selectAccountDraft(0, draft);
    } else {
      setAccountEditIdx(-1);
      setAccountForm(EMPTY_ACCOUNT_DRAFT());
    }
    setAccountOpen(true);
  }

  function selectAccountDraft(idx: number, list = accountDraft) {
    const item = list[idx];
    if (!item) return;
    if (list === accountDraft && accountEditIdx >= 0 && accountEditIdx !== idx) {
      const merged = mergeAccountForm(accountDraft);
      if (merged == null) return;
      if (merged !== accountDraft) {
        setAccountDraft(merged);
        const updated = merged[idx];
        if (!updated) return;
        setAccountEditIdx(idx);
        setAccountForm({ ...updated });
        return;
      }
    }
    setAccountEditIdx(idx);
    setAccountForm({ ...item });
  }

  /** 合并当前表单到列表；校验失败返回 null */
  function mergeAccountForm(list: LoginAccount[]): LoginAccount[] | null {
    const hasContent =
      Boolean(accountForm.label.trim()) ||
      Boolean(accountForm.username.trim()) ||
      Boolean(accountForm.password);
    if (!hasContent) return list;
    if (!accountForm.username.trim() && !accountForm.password) {
      setStatus("请至少填写账号或密码");
      return null;
    }
    const form: LoginAccount = {
      ...accountForm,
      label:
        accountForm.label.trim() ||
        accountForm.username.trim() ||
        "未命名账号",
      username: accountForm.username.trim(),
      next: accountForm.next || "down",
    };
    const next = [...list];
    if (accountEditIdx >= 0 && accountEditIdx < next.length) {
      next[accountEditIdx] = { ...form, id: next[accountEditIdx].id };
    } else {
      next.push({ ...form, id: form.id || `tmp-${Date.now()}` });
    }
    return next;
  }

  function addAccountDraft() {
    const merged = mergeAccountForm(accountDraft);
    if (merged == null) return;
    const blank = EMPTY_ACCOUNT_DRAFT();
    setAccountDraft([...merged, blank]);
    setAccountEditIdx(merged.length);
    setAccountForm(blank);
  }

  function removeAccountDraft(idx: number) {
    setAccountDraft((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (!next.length) {
        setAccountEditIdx(-1);
        setAccountForm(EMPTY_ACCOUNT_DRAFT());
        return next;
      }
      const nextIdx = Math.min(idx, next.length - 1);
      setAccountEditIdx(nextIdx);
      setAccountForm({ ...next[nextIdx] });
      return next;
    });
  }

  async function saveAccountDraft() {
    const merged = mergeAccountForm(accountDraft);
    if (merged == null) return;
    const payload = merged
      .map((a) => ({
        id: a.id.startsWith("tmp-") ? "" : a.id,
        label: a.label.trim() || a.username.trim() || "未命名账号",
        username: a.username.trim(),
        password: a.password,
        next: a.next || "down",
      }))
      .filter((a) => a.username || a.password);
    setAccountSaving(true);
    try {
      const r = await api.saveRemoteAccounts(payload);
      setAccounts(r.accounts);
      setAccountId((prev) => {
        if (prev && r.accounts.some((a) => a.id === prev)) return prev;
        return r.accounts[0]?.id || "";
      });
      setAccountOpen(false);
      setStatus(`已保存 ${r.accounts.length} 个登录账号`);
      appendLog(`[账号] 已保存 ${r.accounts.length} 个`);
    } catch (e) {
      setStatus(`保存登录账号失败：${toErrorMessage(e)}`);
    } finally {
      setAccountSaving(false);
    }
  }

  async function fillLogin(field: "user" | "pass" | "login", submit = false) {
    if (!linked || !selectedAccount) return;
    setBusy(true);
    try {
      const r = await api.remoteAccountFill(deviceSn, selectedAccount.id, field, {
        submit,
      });
      appendLog(`[登录] ${r.message}`);
      setStatus(r.message);
    } catch (e) {
      setStatus(`填充登录账号失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendRemoteText() {
    const payload = text.trim();
    if (!linked || !payload || busy) return;
    setBusy(true);
    try {
      await api.remoteText(deviceSn, payload);
      appendLog(`[text] ${payload}`);
      setStatus("已发送文本");
    } catch (e) {
      setStatus(`发送文本失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const previewHint = !snOk
    ? "打开设备标签后可投屏"
    : waitingReconnect
      ? `等待设备重连 ${formatRemain(reconnectRemain)}（录屏保留）`
      : connecting
        ? "正在连接…"
        : embedLive
          ? "等待首帧…"
          : embedAvail
            ? "点击「开始投屏」在此观看设备画面"
            : fallbackOn
              ? "截图抓取中…"
              : "内嵌不可用，可使用截图预览回退";

  return (
    <div className="tool-panel remote-panel">
      <div className="remote-chrome">
        <div className="remote-chrome-left">
          <span
            className={`remote-dot${
              embedLive ? " on" : connecting || waitingReconnect ? " wait" : ""
            }`}
            aria-hidden
          />
          <div className="remote-chrome-title">
            <strong>虚拟遥控</strong>
            <span title={snOk ? deviceSn : undefined}>
              {snOk ? deviceSn : "未选设备"}
            </span>
          </div>
          <div className="remote-chrome-badges" aria-live="polite">
            {connecting ? (
              <span className="remote-badge is-wait">连接中</span>
            ) : null}
            {waitingReconnect ? (
              <span className="remote-badge is-wait">
                重连 {formatRemain(reconnectRemain)}
              </span>
            ) : null}
            {recording ? <span className="remote-badge is-rec">REC</span> : null}
          </div>
        </div>
        <div className="remote-chrome-text">
          <input
            className="field grow"
            value={text}
            disabled={!linked || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void sendRemoteText();
              }
            }}
            placeholder="发送文字（英文/中文）…"
            aria-label="发送文字"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!linked || busy || !text.trim()}
            onClick={() => void sendRemoteText()}
          >
            发送
          </Button>
        </div>
        <div className="remote-chrome-actions">
          <div className="remote-action-group" role="group" aria-label="投屏">
            <Button
              size="sm"
              variant={embedLive || connecting ? "default" : "primary"}
              disabled={
                !snOk ||
                connecting ||
                (embedLive || waitingReconnect
                  ? false
                  : !embedAvail || !linked)
              }
              title={
                embedAvail
                  ? "在预览区内嵌 scrcpy"
                  : embedReason || "内嵌 scrcpy 不可用"
              }
              onClick={() => {
                if (waitingReconnect) {
                  stopEmbed({ statusText: "已取消等待，投屏与录屏已停止" });
                  appendLog("[投屏] 用户取消重连等待");
                } else if (embedLive || connecting) {
                  stopEmbed({ statusText: "投屏已停止" });
                } else startEmbed();
              }}
            >
              {waitingReconnect
                ? "取消等待"
                : connecting
                  ? "连接中…"
                  : embedLive
                    ? "停止投屏"
                    : "开始投屏"}
            </Button>
            <select
              className="field remote-res-select"
              value={scrcpyMaxSide}
              disabled={!snOk || embedLive || connecting}
              title="投屏分辨率上限（开始投屏前可切换）"
              aria-label="投屏分辨率"
              onChange={(e) => setScrcpyMaxSide(Number(e.target.value) || 960)}
            >
              <option value={720}>流畅 720p</option>
              <option value={960}>标准 960p</option>
              <option value={1440}>高清 1440p</option>
            </select>
          </div>
          <div className="remote-action-group" role="group" aria-label="截图录屏">
            <Button
              size="sm"
              disabled={!linked || shotBusy || busy}
              title={
                embedLive ? "保存当前投屏画面" : "adb screencap 抓取设备屏幕"
              }
              onClick={() => void captureShot()}
            >
              {shotBusy ? "截图中…" : "截图"}
            </Button>
            <Button
              size="sm"
              variant={recording ? "danger" : "default"}
              disabled={
                !snOk ||
                recordBusy ||
                busy ||
                (!embedLive && !recording) ||
                (!linked && !waitingReconnect && !recording)
              }
              title={
                recording
                  ? "停止录屏并保存 MP4"
                  : embedLive
                    ? "录制投屏画面为 MP4"
                    : "请先开始投屏"
              }
              onClick={() => void toggleRecord()}
            >
              {recordBusy ? "处理中…" : recording ? "停止录屏" : "录屏"}
            </Button>
            {recordPath ? (
              <Button
                size="sm"
                title={recordPath}
                onClick={() => void openRecordFile()}
              >
                打开录像
              </Button>
            ) : null}
          </div>
          <div className="remote-action-group" role="group" aria-label="截图处理">
            <Button
              size="sm"
              disabled={!lastShot || shotBusy}
              title="裁剪与标注最近一次截图"
              onClick={() => setShotEditorOpen(true)}
            >
              编辑
            </Button>
            <Button
              size="sm"
              disabled={!lastShot || shotBusy}
              title="将最近一次截图保存为文件"
              onClick={() => saveShot()}
            >
              保存
            </Button>
            <Button
              size="sm"
              disabled={!lastShot || shotBusy}
              title="复制最近一次截图到剪贴板"
              onClick={() => void copyShot()}
            >
              复制
            </Button>
            {!embedAvail ? (
              <Button
                size="sm"
                disabled={!linked || embedLive || connecting}
                title="adb 截图轮询（较慢）"
                onClick={() => setFallbackOn((v) => !v)}
              >
                {fallbackOn ? "停截图" : "截图预览"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {!embedAvail && embedReason ? (
        <div className="banner-warn">{embedReason}</div>
      ) : null}

      <div className="remote-layout">
        <div
          ref={previewRef}
          className={`remote-preview${kbdOn ? " kbd-focus" : ""}${
            embedLive ? " live" : ""
          }${connecting ? " connecting" : ""}${
            waitingReconnect ? " reconnecting" : ""
          }${lastShot && !kbdOn ? " can-edit-shot" : ""}`}
          tabIndex={0}
          onClick={() => {
            if (kbdOn) {
              previewRef.current?.focus();
              return;
            }
            if (lastShot) {
              setShotEditorOpen(true);
            }
          }}
          onKeyDown={(e) => {
            if (!kbdOn || !linked) return;
            if ((e.nativeEvent as KeyboardEvent).isComposing || e.key === "Process")
              return;
            if (e.ctrlKey || e.altKey || e.metaKey) return;

            const mapped = KEY_MAP[e.key];
            if (mapped != null) {
              e.preventDefault();
              void sendKey(mapped, e.key);
              return;
            }

            if (isInjectableChar(e.key)) {
              e.preventDefault();
              void sendChar(e.key);
            }
          }}
        >
          {hasLiveFrame || frameUrl ? (
            <img
              ref={previewImgRef}
              src={hasLiveFrame ? undefined : frameUrl}
              alt="device preview"
              draggable={false}
              title={
                lastShot && !kbdOn
                  ? "点击图片打开截图编辑（裁剪 / 标注 / 复制）"
                  : undefined
              }
            />
          ) : (
            <div className="remote-preview-empty">
              <div className="remote-preview-empty-mark" aria-hidden>
                TV
              </div>
              <p>{previewHint}</p>
              {snOk &&
              embedAvail &&
              !embedLive &&
              !connecting &&
              deviceOnline !== false ? (
                <Button variant="primary" onClick={() => startEmbed()}>
                  开始投屏
                </Button>
              ) : null}
            </div>
          )}
          {lastShot && !embedLive && !fallbackOn && frameUrl ? (
            <button
              type="button"
              className="remote-shot-edit-pill"
              onClick={(e) => {
                e.stopPropagation();
                setShotEditorOpen(true);
              }}
            >
              点击图片编辑截图（裁剪 / 标注 / 复制）
            </button>
          ) : null}
          {lastShot && showShotThumb && (embedLive || fallbackOn) ? (
            <div
              className="remote-shot-thumb"
              role="button"
              tabIndex={0}
              title="点击编辑刚刚截取的图片"
              onClick={(e) => {
                e.stopPropagation();
                setShotEditorOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  setShotEditorOpen(true);
                }
              }}
            >
              <img
                src={`data:${lastShot.mime};base64,${lastShot.b64}`}
                alt="最近截图"
                draggable={false}
              />
              <div className="remote-shot-thumb-bar">
                <span>点击编辑截图</span>
                <button
                  type="button"
                  className="remote-shot-thumb-close"
                  title="收起缩略图"
                  aria-label="收起缩略图"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowShotThumb(false);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ) : null}
          {embedLive ? <span className="remote-live-tag">LIVE</span> : null}
          {recording ? <span className="remote-rec-tag">REC</span> : null}
          {streamBusy && !waitingReconnect ? (
            <div className="remote-busy-mask">
              <strong>{streamBusyTitle}</strong>
              <p>{streamBusyText || "投屏保持当前画面，完成后自动恢复"}</p>
            </div>
          ) : null}
          {waitingReconnect ? (
            <div className="remote-reconnect-mask">
              <strong>等待 ADB 重连</strong>
              <p className="remote-reconnect-meta">{deviceSn}</p>
              <p className="remote-reconnect-meta">
                录屏已保留 · 剩余 {formatRemain(reconnectRemain)}
              </p>
              <Button
                variant="danger"
                onClick={() => {
                  stopEmbed({ statusText: "已取消等待，投屏与录屏已停止" });
                  appendLog("[投屏] 用户取消重连等待");
                }}
              >
                取消并停止录屏
              </Button>
            </div>
          ) : null}
          {kbdOn ? <span className="remote-kbd-tag">键盘</span> : null}
        </div>

        <aside className="remote-side">
          <section className="remote-card remote-card-pad">
            <header className="remote-card-head">
              <span>遥控器</span>
            </header>

            <div className="remote-pad" role="group" aria-label="遥控器">
              <div className="remote-dpad" role="group" aria-label="方向键">
                {DPAD_LAYOUT.map((row, ri) =>
                  row.map((label, ci) => {
                    if (!label) {
                      return (
                        <span key={`e-${ri}-${ci}`} className="remote-dpad-gap" />
                      );
                    }
                    const act =
                      actionMap.get(label) ??
                      (label === "Enter"
                        ? {
                            label: "Enter",
                            kind: "key",
                            keycode: 66,
                            hint: "KEYCODE_ENTER (66)",
                            confirm: "",
                          }
                        : undefined);
                    const isOk = label === "确定";
                    const isNav =
                      label === "上" ||
                      label === "下" ||
                      label === "左" ||
                      label === "右";
                    const isSys =
                      label === "主页" ||
                      label === "返回" ||
                      label === "设置" ||
                      label === "Enter";
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`remote-key${isOk ? " ok" : ""}${
                          isNav ? " nav" : ""
                        }${isSys ? " sys" : ""}`}
                        disabled={!linked || busy || !act}
                        title={
                          isNav
                            ? `${act?.hint || label} · 按住可连发，右键长按`
                            : `${act?.hint || label} · 右键可长按`
                        }
                        aria-label={label}
                        onPointerDown={() => {
                          if (act?.kind === "key" && act.keycode) {
                            startHoldRepeat(act.keycode, act.label, isNav);
                          }
                        }}
                        onPointerUp={stopHoldRepeat}
                        onPointerLeave={stopHoldRepeat}
                        onPointerCancel={stopHoldRepeat}
                        onContextMenu={(e) => {
                          if (act?.kind === "key" && act.keycode) {
                            e.preventDefault();
                            void sendKey(act.keycode, act.label, { longpress: true });
                          }
                        }}
                        onClick={() => {
                          if (!act) return;
                          if (repeatFiredRef.current) {
                            repeatFiredRef.current = false;
                            return;
                          }
                          if (act.kind === "key" && act.keycode) {
                            void sendKey(act.keycode, act.label);
                          } else {
                            void run(act.label, act.confirm);
                          }
                        }}
                      >
                        <span className="remote-key-glyph">
                          {DPAD_GLYPH[label] || label}
                        </span>
                      </button>
                    );
                  }),
                )}
              </div>

              {apps.length > 0 ? (
                <div className="remote-apps" role="group" aria-label="快捷">
                  {apps.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      className={`remote-key remote-key-app${
                        a.kind === "wipe" || a.kind === "reboot" ? " danger" : ""
                      }`}
                      disabled={!linked || busy}
                      title={a.hint}
                      onClick={() => void run(a.label, a.confirm)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="remote-section">
              <div className="remote-section-head">
                <span className="remote-section-label">登录账号</span>
                {accounts.length === 0 ? (
                  <button
                    type="button"
                    className="remote-link-btn"
                    onClick={() => openAccountManager()}
                  >
                    添加
                  </button>
                ) : null}
              </div>
              {accounts.length === 0 ? (
                <p className="remote-login-hint">还没有账号，点右上角添加</p>
              ) : (
                <div className="remote-login-body">
                  <div className="remote-login-pick">
                    <select
                      className="field"
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      aria-label="登录账号"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      title="管理登录账号"
                      onClick={() => openAccountManager()}
                    >
                      管理
                    </Button>
                  </div>
                  {selectedAccount ? (
                    <div className="remote-login-preview">
                      <code title={selectedAccount.username}>
                        {selectedAccount.username || "—"}
                      </code>
                      <span aria-hidden>/</span>
                      <code title={selectedAccount.password}>
                        {selectedAccount.password || "—"}
                      </code>
                    </div>
                  ) : null}
                  <div className="remote-login-actions">
                    <Button
                      size="sm"
                      disabled={!linked || busy || !selectedAccount}
                      title="只填账号"
                      onClick={() => void fillLogin("user")}
                    >
                      填账号
                    </Button>
                    <Button
                      size="sm"
                      disabled={!linked || busy || !selectedAccount}
                      title="只填密码"
                      onClick={() => void fillLogin("pass")}
                    >
                      填密码
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!linked || busy || !selectedAccount}
                      title={
                        selectedAccount
                          ? `账号 → ${
                              NEXT_OPTIONS.find(
                                (o) => o.value === selectedAccount.next,
                              )?.label || "下键"
                            } → 密码`
                          : undefined
                      }
                      onClick={() => void fillLogin("login")}
                    >
                      一键填入
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>

      <div className="remote-log-bar">
        <Button variant="ghost" size="sm" onClick={() => setLogOpen((v) => !v)}>
          {logOpen ? "收起日志" : "日志"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!log}
          onClick={() => setLog("")}
        >
          清空
        </Button>
        <span className="remote-log-hint">
          {kbdOn
            ? "键盘已开：方向键导航 · 字母/数字/标点输入设备"
            : "可开启键盘接管预览区"}
        </span>
      </div>
      {logOpen ? <pre className="log remote-log">{log || "暂无日志"}</pre> : null}

      <Modal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        size="lg"
        className="remote-account-modal"
        title={
          <div className="preset-modal-title">
            <strong>登录账号</strong>
            <span className="preset-count">{accountDraft.length}</span>
          </div>
        }
        footer={
          <>
            <Button onClick={() => setAccountOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={accountSaving}
              onClick={() => void saveAccountDraft()}
            >
              {accountSaving ? "保存中…" : "保存全部"}
            </Button>
          </>
        }
      >
        <div className="remote-account-editor">
          <div className="remote-account-list" role="list">
            {accountDraft.length === 0 ? (
              <div className="remote-account-empty">暂无账号</div>
            ) : (
              accountDraft.map((a, i) => (
                <button
                  key={a.id || `draft-${i}`}
                  type="button"
                  role="listitem"
                  className={`remote-account-item${
                    accountEditIdx === i ? " active" : ""
                  }`}
                  onClick={() => selectAccountDraft(i)}
                >
                  <span className="remote-account-item-idx">{i + 1}</span>
                  <span className="remote-account-item-body">
                    <span className="remote-account-item-label">
                      {a.label || a.username || "未命名"}
                    </span>
                    <span className="remote-account-item-user">
                      {a.username || "—"}
                      {" · "}
                      {a.password || "—"}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="remote-account-form">
            <div className="remote-account-form-head">
              {accountEditIdx >= 0
                ? `编辑第 ${accountEditIdx + 1} 条`
                : "新建账号"}
            </div>
            <label className="remote-account-field">
              <span>显示名</span>
              <input
                className="field"
                value={accountForm.label}
                onChange={(e) =>
                  setAccountForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder="显示名"
              />
            </label>
            <label className="remote-account-field">
              <span>账号</span>
              <input
                className="field"
                value={accountForm.username}
                onChange={(e) =>
                  setAccountForm((f) => ({ ...f, username: e.target.value }))
                }
                placeholder="邮箱 / 用户名"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="remote-account-field">
              <span>密码</span>
              <input
                className="field"
                type="text"
                value={accountForm.password}
                onChange={(e) =>
                  setAccountForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="密码（明文）"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="remote-account-field">
              <span>账号后跳转</span>
              <div className="remote-next-seg" role="group" aria-label="跳转键">
                {NEXT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={`remote-next-chip${
                      accountForm.next === o.value ? " active" : ""
                    }`}
                    onClick={() =>
                      setAccountForm((f) => ({ ...f, next: o.value }))
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="remote-account-form-actions">
              <Button size="sm" onClick={() => addAccountDraft()}>
                添加
              </Button>
              <Button
                size="sm"
                variant="danger-ghost"
                disabled={accountEditIdx < 0}
                onClick={() => {
                  if (accountEditIdx >= 0) removeAccountDraft(accountEditIdx);
                }}
              >
                删除
              </Button>
            </div>
          </div>
        </div>
      </Modal>
      <ShotEditorModal
        open={shotEditorOpen}
        shot={lastShot}
        onClose={() => setShotEditorOpen(false)}
        onCopyEdited={(edited) => copyShot(edited)}
        onSaveEdited={(edited) => saveShot(edited)}
        onApplyEdited={(edited) => {
          applyEditedShot(edited);
          appendLog(
            `[截图] 已应用编辑 (${edited.width || "?"}×${edited.height || "?"})`,
          );
          setStatus("截图编辑已应用");
        }}
      />
    </div>
  );
}
