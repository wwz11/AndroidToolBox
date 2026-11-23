import { useEffect, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api, wsUrl } from "../api/client";
import { readAppPrefs } from "../appPrefs";
import { syncSessionActivities } from "../activity";
import { useStatusNotify } from "../components/toast";
import ShellFindBar from "../panels/ShellFindBar";
import SerialRemotePad from "../panels/SerialRemotePad";
import ShellTerminal, {
  type ShellTerminalHandle,
} from "../panels/ShellTerminal";
import { Button, EmptyState, StatusBanner, Toolbar } from "../ui";
import { useSerialSessions } from "../hooks/useSerialSessions";
import { shortPort } from "../serialSessions";

function SerialTerminal({
  port,
  baud,
  browseOnly,
}: {
  port: string;
  baud: number;
  browseOnly?: boolean;
}) {
  const setStatus = useStatusNotify();
  const [open, setOpen] = useState(false);
  const [logPath, setLogPath] = useState("");
  const [autoLog, setAutoLog] = useState(
    () => readAppPrefs().serialAutoLogDefault,
  );
  const [ubootSpam, setUbootSpam] = useState(false);
  const [follow, setFollow] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findQ, setFindQ] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findHit, setFindHit] = useState<{ index: number; count: number } | null>(
    null,
  );
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<ShellTerminalHandle | null>(null);
  const logBufRef = useRef("");
  const portRef = useRef(port);
  const baudRef = useRef(baud);
  const autoLogRef = useRef(autoLog);
  const openRef = useRef(false);
  const ubootTimerRef = useRef<number | null>(null);
  portRef.current = port;
  baudRef.current = baud;
  autoLogRef.current = autoLog;
  openRef.current = open;

  function writeTerm(text: string) {
    if (!text) return;
    // 防御：旧 API 若仍推送 “[ts] RX …” 打戳行，剥掉前缀以免 xterm 被 \\r 刷成乱戳
    const cleaned = text.replace(
      /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] RX /g,
      "",
    );
    if (!cleaned) return;
    logBufRef.current += cleaned;
    if (logBufRef.current.length > 1_500_000) {
      logBufRef.current = logBufRef.current.slice(-1_000_000);
    }
    xtermRef.current?.write(cleaned);
  }

  useEffect(() => {
    if (browseOnly) return;
    let cancelled = false;
    const ws = new WebSocket(wsUrl("/serial/ws"));
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          text?: string;
          port?: string;
          baud?: number;
          enabled?: boolean;
          path?: string;
        };
        if (msg.type === "rx" && msg.text) writeTerm(msg.text);
        else if (msg.type === "status" && msg.text) setStatus(msg.text);
        else if (msg.type === "error" && msg.text) {
          const headline =
            msg.text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ||
            msg.text;
          setStatus(headline);
          writeTerm(`\r\n[ERR] ${msg.text}\r\n`);
        } else if (msg.type === "lost" && msg.text) {
          setOpen(false);
          setUbootSpam(false);
          setStatus(msg.text);
        } else if (msg.type === "opened") {
          setOpen(true);
          setStatus("已连接");
          requestAnimationFrame(() => {
            xtermRef.current?.fit();
            xtermRef.current?.focus();
          });
        } else if (msg.type === "closed") {
          setOpen(false);
          setUbootSpam(false);
          setLogPath("");
          setStatus("已关闭");
        } else if (msg.type === "log") {
          // 路径只显示在底部，避免与标题/状态重复
          setLogPath(msg.enabled ? msg.path || "" : "");
        } else if (msg.type === "hello") {
          ws.send(
            JSON.stringify({
              type: "open",
              port: portRef.current,
              baud: baudRef.current,
              auto_log: autoLogRef.current,
            }),
          );
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      if (!cancelled) setStatus("WebSocket 连接失败");
    };
    ws.onclose = () => {
      if (!cancelled) {
        setOpen(false);
        setUbootSpam(false);
        setStatus("已断开");
      }
      if (wsRef.current === ws) wsRef.current = null;
    };

    return () => {
      cancelled = true;
      if (ubootTimerRef.current != null) {
        window.clearInterval(ubootTimerRef.current);
        ubootTimerRef.current = null;
      }
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "close" }));
        }
      } catch {
        /* ignore */
      }
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port, baud, browseOnly]);

  useEffect(() => {
    if (!ubootSpam) {
      if (ubootTimerRef.current != null) {
        window.clearInterval(ubootTimerRef.current);
        ubootTimerRef.current = null;
      }
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !open) {
      setUbootSpam(false);
      return;
    }
    ubootTimerRef.current = window.setInterval(() => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: "send", text: "\r" }));
    }, 50);
    setStatus("U-Boot 连发回车中（再次点击停止）");
    return () => {
      if (ubootTimerRef.current != null) {
        window.clearInterval(ubootTimerRef.current);
        ubootTimerRef.current = null;
      }
    };
  }, [ubootSpam, open]);

  function sendRaw(text: string) {
    if (!text) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !openRef.current) {
      setStatus("请先打开串口");
      return;
    }
    ws.send(JSON.stringify({ type: "send", text }));
  }

  async function reopen() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("连接已断开，请关闭标签后重新打开该端口");
      return;
    }
    ws.send(
      JSON.stringify({
        type: "open",
        port,
        baud,
        auto_log: autoLog,
      }),
    );
  }

  async function closePort() {
    setUbootSpam(false);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "close" }));
  }

  function toggleAutoLog(next: boolean) {
    setAutoLog(next);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !open) return;
    ws.send(
      JSON.stringify({
        type: "set_log",
        enabled: next,
        port,
        path: next ? "" : undefined,
      }),
    );
  }

  function exportLog() {
    const text = logBufRef.current || "";
    if (!text.trim()) {
      setStatus("无可导出内容");
      return;
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = port.replace(/[<>:"/\\|?*\s]+/g, "_") || "COM";
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `serial_${safe}_${ts}.log`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("已导出日志");
  }

  function clearTerm() {
    logBufRef.current = "";
    setFindHit(null);
    xtermRef.current?.clearSearch();
    xtermRef.current?.clear();
  }

  function openFind() {
    const sel = (xtermRef.current?.getSelection() || "").trim();
    if (sel && !sel.includes("\n")) setFindQ(sel);
    window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  }

  function clearFind() {
    setFindQ("");
    setFindHit(null);
    xtermRef.current?.clearSearch();
    if (open && !browseOnly) xtermRef.current?.focus();
  }

  function runFind(backwards: boolean, query = findQ, caseSensitive = findCase) {
    const q = query.trim();
    if (!q) {
      setFindHit(null);
      xtermRef.current?.clearSearch();
      return;
    }
    const hit = backwards
      ? xtermRef.current?.findPrevious(q, { caseSensitive })
      : xtermRef.current?.findNext(q, { caseSensitive });
    if (!hit || hit.count === 0) {
      setFindHit({ index: -1, count: 0 });
      return;
    }
    setFindHit(hit);
  }

  function onFindQueryChange(q: string) {
    setFindQ(q);
    if (!q.trim()) {
      setFindHit(null);
      xtermRef.current?.clearSearch();
      return;
    }
    xtermRef.current?.clearSearch();
    runFind(false, q);
  }

  function onFindToggleCase() {
    const next = !findCase;
    setFindCase(next);
    if (findQ.trim()) {
      xtermRef.current?.clearSearch();
      runFind(false, findQ, next);
    }
  }

  function openLogDir() {
    if (!logPath) return;
    void api
      .openPath(logPath)
      .then((r) => setStatus(r.message || "已打开日志位置"))
      .catch((e: unknown) =>
        setStatus(`打开串口日志位置失败：${toErrorMessage(e)}`),
      );
  }

  return (
    <div className={`tool-panel serial-terminal${remoteOpen ? " has-remote" : ""}`}>
      <div
        className="shell-term-wrap serial-term-wrap"
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
          if (!ctrl) return;
          const key = e.key.toLowerCase();
          if (key === "f") {
            e.preventDefault();
            openFind();
          } else if (key === "s") {
            e.preventDefault();
            exportLog();
          }
        }}
      >
        <div className="shell-console serial-console">
          <div className="shell-head">
          {logPath ? (
            <button
              type="button"
              className="serial-chrome-log"
              title={`在资源管理器中打开\n${logPath}`}
              onClick={openLogDir}
            >
              {logPath}
            </button>
          ) : null}
          <div className="shell-actions">
            <button
              type="button"
              className={`shell-icon-btn${follow ? " on" : ""}`}
              title={
                follow
                  ? "贴底跟随中；上翻可暂停"
                  : "已停随；点此或滚回底部继续跟随"
              }
              aria-pressed={follow}
              onClick={() => {
                if (follow) {
                  setFollow(false);
                } else {
                  xtermRef.current?.scrollToBottom();
                  setFollow(true);
                }
              }}
            >
              {follow ? "跟随" : "停随"}
            </button>
            <button
              type="button"
              className={`shell-icon-btn${remoteOpen ? " on" : ""}`}
              disabled={browseOnly}
              title={remoteOpen ? "收起遥控器" : "打开遥控器（经串口发送）"}
              aria-pressed={remoteOpen}
              onClick={() => setRemoteOpen((v) => !v)}
            >
              遥控器
            </button>
            <button
              type="button"
              className={`shell-icon-btn${autoLog ? " on" : ""}`}
              disabled={browseOnly}
              title="打开串口后写入 userdata/logs/serial"
              aria-pressed={autoLog}
              onClick={() => toggleAutoLog(!autoLog)}
            >
              日志
            </button>
            <button
              type="button"
              className={`shell-icon-btn${ubootSpam ? " danger" : ""}`}
              disabled={!open || browseOnly}
              title="每 50ms 发送一次 CR，用于 U-Boot"
              onClick={() => setUbootSpam((v) => !v)}
            >
              {ubootSpam ? "停止连发" : "连发回车"}
            </button>
            {!browseOnly ? (
              !open ? (
                <button
                  type="button"
                  className="shell-icon-btn"
                  onClick={() => void reopen()}
                >
                  重开
                </button>
              ) : (
                <button
                  type="button"
                  className="shell-icon-btn"
                  onClick={() => void closePort()}
                >
                  关闭
                </button>
              )
            ) : null}
            <span className="shell-chrome-sep" aria-hidden />
            <ShellFindBar
              inputRef={findInputRef}
              query={findQ}
              caseSensitive={findCase}
              hit={findHit}
              onQueryChange={onFindQueryChange}
              onStep={(back) => runFind(back)}
              onClear={clearFind}
              onToggleCase={onFindToggleCase}
            />
          </div>
          </div>
          <div
            className="shell-console-body"
            onClick={() => {
              if (open && !browseOnly) xtermRef.current?.focus();
            }}
          >
            <ShellTerminal
              ref={xtermRef}
              disabled={!open || Boolean(browseOnly)}
              enterPayload={"\r"}
              historyErase="backspace"
              follow={follow}
              onFollowChange={setFollow}
              onFindShortcut={openFind}
              onSaveShortcut={exportLog}
              onClearShortcut={clearTerm}
              onData={(data) => {
                if (browseOnly) return;
                sendRaw(data);
              }}
            />
            {browseOnly ? (
              <div className="serial-term-overlay">选择端口后点「打开」…</div>
            ) : null}
          </div>
        </div>
      </div>
      {remoteOpen && !browseOnly ? (
        <SerialRemotePad
          serialOpen={open}
          onSend={sendRaw}
          onClose={() => setRemoteOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** 串口多端口：顶部 chips + 保活会话栈（与设备页一致）。 */
export default function SerialPage({ pageActive = true }: { pageActive?: boolean }) {
  const defaultBaud = () => readAppPrefs().serialBaudDefault;
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState(defaultBaud);
  const [bauds, setBauds] = useState<number[]>([9600, 115200, 921600]);
  const setStatus = useStatusNotify();
  const [error, setError] = useState("");
  const serial = useSerialSessions(defaultBaud);

  useEffect(() => {
    const open = serial.sessions.filter((s) => !s.placeholder);
    syncSessionActivities(
      "serial",
      open.map((s) => ({
        key: s.port,
        label: `串口 ${shortPort(s.port)} @${s.baud}`,
      })),
    );
    return () => syncSessionActivities("serial", []);
  }, [serial.sessions]);

  async function refreshPorts(opts?: { quiet?: boolean }) {
    try {
      const r = await api.serialPorts();
      setPorts(r.ports);
      setBauds(r.baud_presets.length ? r.baud_presets : [9600, 115200, 921600]);
      setPort((cur) => {
        if (cur && r.ports.includes(cur)) return cur;
        return r.ports[0] || "";
      });
      if (!r.available) {
        setError("未安装 pyserial");
        if (!opts?.quiet) setStatus("串口不可用");
      } else {
        setError("");
        if (!opts?.quiet) {
          setStatus(r.ports.length ? `${r.ports.length} 个端口` : "无串口");
        }
      }
    } catch (e) {
      const msg = toErrorMessage(e);
      setError(msg);
      if (!opts?.quiet) setStatus("串口列表失败");
    }
  }

  useEffect(() => {
    if (!pageActive) return;
    void refreshPorts();
    const t = window.setInterval(() => {
      void refreshPorts({ quiet: true });
    }, 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageActive]);

  function openSelected() {
    serial.openSession(port, baud);
  }

  function applyBaud(next: number) {
    const rate = Number(next) || defaultBaud();
    setBaud(rate);
    serial.applyBaudToPort(port, rate);
  }

  useEffect(() => {
    const s = serial.sessions.find((x) => x.id === serial.activeId);
    if (!s || s.placeholder) return;
    setPort(s.port);
    setBaud(s.baud);
  }, [serial.activeId, serial.sessions]);

  function openAllPorts() {
    serial.openAll(ports, baud);
  }

  return (
    <div className="panel device-page">
      <Toolbar
        className="device-toolbar"
        start={
          <>
            <span className="label">串口</span>
            <select
              className="field port-select"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            >
              {!ports.length && <option value="">（无端口）</option>}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className="field"
              value={baud}
              onChange={(e) => applyBaud(Number(e.target.value))}
            >
              {bauds.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <Button onClick={() => void refreshPorts()}>刷新</Button>
            <Button variant="primary" disabled={!port} onClick={openSelected}>
              打开
            </Button>
            <Button disabled={!ports.length} onClick={openAllPorts}>
              全部打开
            </Button>
          </>
        }
      />

      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

      <div className="chips">
        {serial.sessions.map((s) => (
          <div
            key={s.id}
            className={`chip${serial.activeId === s.id ? " active" : ""}`}
            onClick={() => serial.activate(s.id)}
            role="tab"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              serial.activate(s.id);
            }}
          >
            <span className={`dot ${s.placeholder ? "off" : "on"}`} />
            <span
              className="chip-label"
              title={s.placeholder ? undefined : `${s.port} @ ${s.baud}`}
            >
              {s.placeholder ? s.port : `${shortPort(s.port)} @${s.baud}`}
            </span>
            {!s.placeholder ? (
              <button
                type="button"
                className="x"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  serial.closeSession(s.id);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="session-body">
        {serial.active?.placeholder ? (
          <div className="session-empty">
            <EmptyState
              title={ports.length ? "尚未打开串口会话" : "未检测到串口"}
              description={
                ports.length
                  ? "选择端口与波特率后点击「打开」。"
                  : "请确认驱动已安装，然后点击「刷新」。"
              }
              action={
                ports.length ? (
                  <Button
                    variant="primary"
                    disabled={!port}
                    onClick={openSelected}
                  >
                    打开所选端口
                  </Button>
                ) : (
                  <Button onClick={() => void refreshPorts()}>刷新端口</Button>
                )
              }
            />
          </div>
        ) : (
          <div className="session-stack">
            {serial.sessions
              .filter((s) => !s.placeholder)
              .map((s) => (
                <div
                  key={s.id}
                  className={
                    s.id === serial.activeId
                      ? "session-stack-item"
                      : "session-stack-item hidden"
                  }
                >
                  <SerialTerminal
                    key={`${s.port}@${s.baud}`}
                    port={s.port}
                    baud={s.baud}
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
