import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../../errors";
import { api, wsUrl } from "../../api/client";
import { readAppPrefs } from "../../appPrefs";
import Modal from "../../components/Modal";
import { Button, EmptyState } from "../../ui";
import ShellFindBar from "../ShellFindBar";
import ShellTerminal, { type ShellTerminalHandle } from "../ShellTerminal";

type ShellPreset = { cmd: string; label: string };

/** 单 token 模糊匹配评分（子串优先，其次按顺序子序列）；未命中返回 -1。 */
function fuzzyScoreText(target: string, token: string): number {
  if (!token) return 0;
  const t = target.toLowerCase();
  const q = token.toLowerCase();
  const subIdx = t.indexOf(q);
  if (subIdx >= 0) {
    return 1000 - subIdx + (subIdx === 0 ? 120 : 0) + q.length * 10;
  }
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prevMatch === ti - 1 ? 18 : 6;
      if (ti === 0) score += 10;
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? Math.max(1, score - Math.floor(t.length / 8)) : -1;
}

function filterPresets(
  items: ShellPreset[],
  query: string,
): Array<{ preset: ShellPreset; index: number }> {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return items.map((preset, index) => ({ preset, index }));
  }
  const scored: Array<{ preset: ShellPreset; index: number; score: number }> = [];
  items.forEach((preset, index) => {
    const label = (preset.label || "").trim();
    const cmd = preset.cmd || "";
    let total = 0;
    for (const tk of tokens) {
      const ls = label ? fuzzyScoreText(label, tk) : -1;
      const cs = cmd ? fuzzyScoreText(cmd, tk) : -1;
      const best = Math.max(ls >= 0 ? ls * 2 : -1, cs);
      if (best < 0) return;
      total += best;
    }
    scored.push({ preset, index, score: total });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ preset, index }) => ({ preset, index }));
}

type Props = {
  deviceSn: string;
  snOk: boolean;
  /** true when shell tab visible AND device page active */
  active: boolean;
  onStatus: (msg: string | ((prev: string) => string)) => void;
};

export default function ShellPane({ deviceSn, snOk, active, onStatus }: Props) {
  const [presets, setPresets] = useState<ShellPreset[]>([]);
  const [presetIdx, setPresetIdx] = useState(0);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [presetQuery, setPresetQuery] = useState("");
  const [presetHighlightIdx, setPresetHighlightIdx] = useState(0);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<ShellPreset[]>([]);
  const [presetDraftQuery, setPresetDraftQuery] = useState("");
  const [presetEditIdx, setPresetEditIdx] = useState(-1);
  const [presetLabel, setPresetLabel] = useState("");
  const [presetCmd, setPresetCmd] = useState("");
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  const presetSearchRef = useRef<HTMLInputElement | null>(null);
  const presetListRef = useRef<HTMLUListElement | null>(null);

  const shellWs = useRef<WebSocket | null>(null);
  const shellSn = useRef("");
  const shellStarted = useRef(false);
  const shellStartWaiters = useRef<Array<() => void>>([]);
  const shellPending = useRef("");
  /** 递增以作废进行中的连接，避免 StrictMode/切换误报失败 */
  const shellEpoch = useRef(0);
  const shellConnecting = useRef<Promise<WebSocket> | null>(null);
  const xtermRef = useRef<ShellTerminalHandle | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findQ, setFindQ] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findHit, setFindHit] = useState<{ index: number; count: number } | null>(
    null,
  );
  const [autoLog, setAutoLog] = useState(
    () => readAppPrefs().shellAutoLogDefault,
  );
  const [logPath, setLogPath] = useState("");
  const autoLogRef = useRef(autoLog);
  autoLogRef.current = autoLog;

  useEffect(() => {
    void api
      .shellPresets()
      .then((r) => setPresets(r.presets))
      .catch(() => {
        /* ignore */
      });
  }, []);

  useEffect(() => {
    return () => {
      shellEpoch.current += 1;
      shellConnecting.current = null;
      shellStarted.current = false;
      resolveShellStartWaiters();
      try {
        shellWs.current?.close();
      } catch {
        /* ignore */
      }
      shellWs.current = null;
    };
    // resolveShellStartWaiters 在下文定义；卸载时仅需关闭套接字
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function writeTerm(chunk: string) {
    const term = xtermRef.current;
    if (!term) {
      shellPending.current += chunk;
      return;
    }
    if (shellPending.current) {
      term.write(shellPending.current);
      shellPending.current = "";
    }
    term.write(chunk);
  }

  function flushPendingTerm() {
    if (!shellPending.current || !xtermRef.current) return;
    xtermRef.current.write(shellPending.current);
    shellPending.current = "";
  }

  function resolveShellStartWaiters() {
    const waiters = shellStartWaiters.current;
    shellStartWaiters.current = [];
    for (const w of waiters) w();
  }

  function openShellWs(): Promise<WebSocket> {
    const cur = shellWs.current;
    if (cur && cur.readyState === WebSocket.OPEN && shellSn.current === deviceSn) {
      return Promise.resolve(cur);
    }
    if (
      shellConnecting.current &&
      shellSn.current === deviceSn &&
      cur &&
      (cur.readyState === WebSocket.CONNECTING || cur.readyState === WebSocket.OPEN)
    ) {
      return shellConnecting.current;
    }

    if (cur) {
      try {
        cur.close();
      } catch {
        /* ignore */
      }
      shellWs.current = null;
      shellStarted.current = false;
    }

    const epoch = ++shellEpoch.current;
    const boundSn = deviceSn;
    shellSn.current = boundSn;

    const p = new Promise<WebSocket>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const ws = new WebSocket(
        wsUrl(`/adb/device/shell/ws?device=${encodeURIComponent(boundSn)}`),
      );
      shellWs.current = ws;

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (shellConnecting.current === p) shellConnecting.current = null;
        reject(err);
      };
      const settleResolve = (sock: WebSocket) => {
        if (settled) return;
        settled = true;
        if (shellConnecting.current === p) shellConnecting.current = null;
        resolve(sock);
      };

      ws.onmessage = (ev) => {
        if (shellSn.current !== boundSn || shellEpoch.current !== epoch) return;
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string;
            text?: string;
            code?: number | null;
            enabled?: boolean;
            path?: string;
          };
          if (msg.type === "data" && msg.text) {
            writeTerm(msg.text);
          } else if (msg.type === "log") {
            setLogPath(msg.enabled ? msg.path || "" : "");
          } else if (msg.type === "error" && msg.text) {
            writeTerm(`\r\n[错误] ${msg.text}\r\n`);
            onStatus(msg.text);
            // 启动阶段失败时唤醒 waitShellStarted，避免一直转圈直到超时
            if (!shellStarted.current) resolveShellStartWaiters();
          } else if (msg.type === "started") {
            shellStarted.current = true;
            onStatus("交互 Shell 已连接");
            resolveShellStartWaiters();
          } else if (msg.type === "stopped" || msg.type === "exit") {
            shellStarted.current = false;
            writeTerm(
              msg.type === "exit"
                ? `\r\n[会话结束 exit=${msg.code ?? ""}]\r\n`
                : "\r\n[会话已断开]\r\n",
            );
            onStatus(msg.type === "exit" ? `Shell 退出 ${msg.code ?? ""}` : "Shell 已断开");
          }
        } catch {
          /* ignore */
        }
      };
      ws.onopen = () => {
        opened = true;
        if (shellEpoch.current !== epoch || shellSn.current !== boundSn) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          settleReject(new Error("aborted"));
          return;
        }
        settleResolve(ws);
      };
      // onerror 信息很少，统一在 onclose 判定，避免重复 reject
      ws.onerror = () => undefined;
      ws.onclose = (ev) => {
        if (shellWs.current === ws) shellWs.current = null;
        if (shellEpoch.current === epoch) {
          shellStarted.current = false;
          resolveShellStartWaiters();
        }
        if (!opened) {
          if (shellEpoch.current !== epoch) {
            settleReject(new Error("aborted"));
          } else {
            const why = ev.reason?.trim() || `code=${ev.code}`;
            settleReject(new Error(`Shell WebSocket 失败 (${why})`));
          }
        }
      };
    });

    shellConnecting.current = p;
    return p;
  }

  function waitShellStarted(timeoutMs = 8000): Promise<void> {
    if (shellStarted.current) return Promise.resolve();
    const epoch = shellEpoch.current;
    return new Promise((resolve, reject) => {
      let onReady: () => void = () => undefined;
      const timer = window.setTimeout(() => {
        shellStartWaiters.current = shellStartWaiters.current.filter((w) => w !== onReady);
        reject(new Error("交互 Shell 启动超时"));
      }, timeoutMs);
      onReady = () => {
        window.clearTimeout(timer);
        if (shellEpoch.current !== epoch) {
          reject(new Error("aborted"));
          return;
        }
        // onclose / 启动错误也会唤醒 waiters；未真正 started 时视为失败
        if (!shellStarted.current) {
          reject(new Error("交互 Shell 未就绪"));
          return;
        }
        resolve();
      };
      shellStartWaiters.current.push(onReady);
    });
  }

  async function ensureShell(): Promise<WebSocket> {
    const ws = await openShellWs();
    // openShellWs 新建连接时会 ++shellEpoch；必须以返回后的世代与套接字为准，
    // 否则会把「刚建连」误判为 aborted，界面一直停在「正在连接…」
    const epoch = shellEpoch.current;
    if (shellWs.current !== ws) throw new Error("aborted");
    if (!shellStarted.current) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("Shell WebSocket 未就绪");
      ws.send(JSON.stringify({ type: "start", auto_log: autoLogRef.current }));
      await waitShellStarted();
      if (shellEpoch.current !== epoch || shellWs.current !== ws) {
        throw new Error("aborted");
      }
      if (!shellStarted.current) throw new Error("交互 Shell 未就绪");
    }
    return ws;
  }

  function isAbortErr(e: unknown): boolean {
    return e instanceof Error && e.message === "aborted";
  }

  async function connectShell(force = false) {
    if (!snOk) return;
    try {
      if (force) {
        shellEpoch.current += 1;
        shellConnecting.current = null;
        shellStarted.current = false;
        const old = shellWs.current;
        shellWs.current = null;
        if (old) {
          try {
            old.close();
          } catch {
            /* ignore */
          }
        }
      }
      await ensureShell();
      xtermRef.current?.focus();
    } catch (e) {
      if (isAbortErr(e)) return;
      const msg = toErrorMessage(e);
      writeTerm(`\r\n[连接失败] ${msg}\r\n`);
      onStatus(msg);
    }
  }

  async function sendRaw(text: string) {
    if (!text || !snOk) return;
    try {
      const ws = await ensureShell();
      ws.send(JSON.stringify({ type: "raw", text }));
      onStatus("交互中");
    } catch (e) {
      if (isAbortErr(e)) return;
      const msg = toErrorMessage(e);
      writeTerm(`\r\n[发送失败] ${msg}\r\n`);
      onStatus(msg);
    }
  }

  function splitShellScript(script: string): string[] {
    return script
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((ln) => ln.trimEnd())
      .filter((ln) => {
        const t = ln.trim();
        return Boolean(t) && !t.startsWith("#");
      });
  }

  function presetCmdPreview(script: string): string {
    const lines = splitShellScript(script);
    if (!lines.length) return "";
    if (lines.length === 1) return lines[0];
    return `${lines[0]}  …(+${lines.length - 1})`;
  }

  const filteredPresets = useMemo(
    () => filterPresets(presets, presetQuery),
    [presets, presetQuery],
  );
  const filteredDraftPresets = useMemo(
    () => filterPresets(presetDraft, presetDraftQuery),
    [presetDraft, presetDraftQuery],
  );

  function presetOptionText(p: ShellPreset): string {
    const label = (p.label || "").trim();
    return label || presetCmdPreview(p.cmd) || "未命名";
  }

  useEffect(() => {
    if (!presetMenuOpen) return;
    setPresetQuery("");
    setPresetHighlightIdx(0);
    const raf = window.requestAnimationFrame(() => {
      presetSearchRef.current?.focus();
    });
    const onDoc = (ev: MouseEvent) => {
      const el = presetMenuRef.current;
      if (el && !el.contains(ev.target as Node)) setPresetMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPresetMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [presetMenuOpen]);

  useEffect(() => {
    setPresetHighlightIdx(0);
  }, [presetQuery]);

  useEffect(() => {
    if (!presetMenuOpen) return;
    const item = presetListRef.current?.children[presetHighlightIdx] as
      | HTMLElement
      | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [presetHighlightIdx, presetMenuOpen]);

  useEffect(() => {
    if (!active) setPresetMenuOpen(false);
  }, [active]);

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
    xtermRef.current?.focus();
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

  function saveOutput() {
    const text = xtermRef.current?.getText() || "";
    if (!text.trim()) {
      onStatus("终端没有可保存的内容");
      return;
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (deviceSn || "device").replace(/[<>:"/\\|?*\s]+/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `adb_shell_${safe}_${ts}.log`;
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    onStatus(`已保存 ${name}`);
  }

  function toggleAutoLog(next: boolean) {
    setAutoLog(next);
    const ws = shellWs.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !shellStarted.current) {
      if (!next) setLogPath("");
      return;
    }
    ws.send(
      JSON.stringify({
        type: "set_log",
        enabled: next,
        path: next ? "" : undefined,
      }),
    );
  }

  function openLogDir() {
    if (!logPath) return;
    void api
      .openPath(logPath)
      .then((r) => onStatus(r.message || "已打开日志位置"))
      .catch((e: unknown) =>
        onStatus(`打开 Shell 日志位置失败：${toErrorMessage(e)}`),
      );
  }

  async function runShellScript(script: string) {
    const lines = splitShellScript(script);
    if (!lines.length || !snOk) return;
    onStatus(lines.length > 1 ? `运行 ${lines.length} 条命令…` : "交互中");
    try {
      const ws = await ensureShell();
      for (let i = 0; i < lines.length; i++) {
        ws.send(JSON.stringify({ type: "send", text: lines[i] }));
        // 给交互 shell 一点时间消化，避免粘连
        if (i < lines.length - 1) {
          await new Promise((r) => window.setTimeout(r, 120));
        }
      }
      onStatus(lines.length > 1 ? `已发送 ${lines.length} 条` : "交互中");
      xtermRef.current?.focus();
    } catch (e) {
      if (isAbortErr(e)) return;
      const msg = toErrorMessage(e);
      writeTerm(`\r\n[发送失败] ${msg}\r\n`);
      onStatus(msg);
    }
  }

  function openPresetEditor() {
    setPresetMenuOpen(false);
    setPresetDraft(presets.map((p) => ({ ...p })));
    setPresetDraftQuery("");
    setPresetEditIdx(-1);
    setPresetLabel("");
    setPresetCmd("");
    setPresetOpen(true);
  }

  function selectPresetDraft(i: number) {
    const p = presetDraft[i];
    if (!p) return;
    setPresetEditIdx(i);
    setPresetLabel(p.label);
    setPresetCmd(p.cmd);
  }

  function addOrUpdatePresetDraft() {
    const c = presetCmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!c) {
      onStatus("请填写命令");
      return;
    }
    const first = splitShellScript(c)[0] || c;
    const label = (presetLabel.trim() || first).slice(0, 120);
    setPresetDraft((prev) => {
      const next = [...prev];
      if (presetEditIdx >= 0 && presetEditIdx < next.length) {
        next[presetEditIdx] = { cmd: c, label };
      } else {
        const exist = next.findIndex((p) => p.cmd === c);
        if (exist >= 0) next[exist] = { cmd: c, label };
        else next.push({ cmd: c, label });
      }
      return next;
    });
    setPresetEditIdx(-1);
    setPresetLabel("");
    setPresetCmd("");
  }

  function deletePresetDraft() {
    if (presetEditIdx < 0) return;
    setPresetDraft((prev) => prev.filter((_, i) => i !== presetEditIdx));
    setPresetEditIdx(-1);
    setPresetLabel("");
    setPresetCmd("");
  }

  function movePresetDraft(delta: number) {
    if (presetEditIdx < 0) return;
    const from = presetEditIdx;
    const to = from + delta;
    if (to < 0 || to >= presetDraft.length) return;
    setPresetDraft((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setPresetEditIdx(to);
  }

  function resetPresetForm() {
    setPresetEditIdx(-1);
    setPresetLabel("");
    setPresetCmd("");
  }

  async function savePresetDraft() {
    try {
      const r = await api.saveShellPresets(presetDraft);
      setPresets(r.presets);
      setPresetIdx(0);
      setPresetOpen(false);
      onStatus(`已保存 ${r.presets.length} 条快捷命令`);
    } catch (e) {
      onStatus(`保存快捷命令失败：${toErrorMessage(e)}`);
    }
  }

  useEffect(() => {
    // 仅当前可见会话自动连 Shell，避免后台标签抢连 / StrictMode 误报
    // active=false 时不拆 WS，切回 shell 标签时复用连接（与旧 AdbPanel 行为一致）
    if (!active || !snOk) return;
    flushPendingTerm();
    void connectShell(false).then(() => {
      flushPendingTerm();
      xtermRef.current?.fit();
      xtermRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snOk, deviceSn]);

  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      xtermRef.current?.fit();
      xtermRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <div
      className="shell-term-wrap"
      onKeyDown={(e) => {
        const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
        if (!ctrl) return;
        const key = e.key.toLowerCase();
        if (key === "f") {
          e.preventDefault();
          openFind();
        } else if (key === "s") {
          e.preventDefault();
          saveOutput();
        }
      }}
    >
      <div className="shell-console">
        <div className="shell-head">
          {logPath ? (
            <button
              type="button"
              className="shell-head-log"
              title={`在资源管理器中打开\n${logPath}`}
              onClick={openLogDir}
            >
              {logPath}
            </button>
          ) : null}
          <div className="shell-actions">
          <button
            type="button"
            className={`shell-icon-btn${autoLog ? " on" : ""}`}
            disabled={!snOk}
            title="连接后写入 userdata/logs/shell"
            aria-pressed={autoLog}
            onClick={() => toggleAutoLog(!autoLog)}
          >
            日志
          </button>
          <div className="shell-preset" ref={presetMenuRef}>
            <button
              type="button"
              className="field shell-preset-trigger"
              title={
                presets[presetIdx]
                  ? `${(presets[presetIdx].label || "").trim() ? `${presets[presetIdx].label.trim()}\n` : ""}${presets[presetIdx].cmd}`
                  : presets.length
                    ? "快捷命令"
                    : "编辑快捷命令"
              }
              aria-haspopup="listbox"
              aria-expanded={presetMenuOpen}
              onClick={() => setPresetMenuOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || presetMenuOpen) return;
                e.preventDefault();
                const p = presets[presetIdx];
                if (p && snOk) void runShellScript(p.cmd);
              }}
            >
              <span className="shell-preset-trigger-text">
                {presets[presetIdx]
                  ? presetOptionText(presets[presetIdx])
                  : "快捷命令"}
              </span>
              <span className="shell-preset-caret" aria-hidden>
                ▾
              </span>
            </button>
            {presetMenuOpen ? (
              <div className="shell-preset-menu" role="listbox">
                <div className="shell-preset-search-wrap">
                  <input
                    ref={presetSearchRef}
                    type="text"
                    className="field shell-preset-search"
                    value={presetQuery}
                    onChange={(e) => setPresetQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        if (filteredPresets.length) {
                          setPresetHighlightIdx((idx) => (idx + 1) % filteredPresets.length);
                        }
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        if (filteredPresets.length) {
                          setPresetHighlightIdx(
                            (idx) => (idx - 1 + filteredPresets.length) % filteredPresets.length,
                          );
                        }
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        const hit =
                          filteredPresets[presetHighlightIdx] ?? filteredPresets[0];
                        if (hit) {
                          setPresetIdx(hit.index);
                          setPresetMenuOpen(false);
                        }
                      }
                    }}
                    placeholder="模糊搜索快捷命令（名称 / 命令）"
                    aria-label="模糊搜索快捷命令"
                  />
                  {presetQuery ? (
                    <button
                      type="button"
                      className="shell-preset-search-clear"
                      onClick={() => {
                        setPresetQuery("");
                        presetSearchRef.current?.focus();
                      }}
                      title="清空搜索"
                      aria-label="清空搜索"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <ul className="shell-preset-items" ref={presetListRef}>
                  {filteredPresets.length ? (
                    filteredPresets.map(({ preset: p, index: origIdx }, pos) => {
                      const isSelected = origIdx === presetIdx;
                      const isHighlighted = pos === presetHighlightIdx;
                      return (
                        <li
                          key={`${p.label}-${origIdx}`}
                          role="option"
                          aria-selected={isSelected}
                        >
                          <button
                            type="button"
                            className={`shell-preset-item${isSelected ? " active" : ""}${isHighlighted ? " highlighted" : ""}`}
                            title={p.cmd}
                            onClick={() => {
                              setPresetIdx(origIdx);
                              setPresetMenuOpen(false);
                            }}
                          >
                            <span className="shell-preset-item-label">
                              {(p.label || "").trim() || `命令 ${origIdx + 1}`}
                            </span>
                            <span className="shell-preset-item-cmd">
                              {presetCmdPreview(p.cmd)}
                            </span>
                          </button>
                        </li>
                      );
                    })
                  ) : (
                    <li className="shell-preset-empty">
                      {presets.length ? "未找到匹配的快捷命令" : "暂无快捷命令"}
                    </li>
                  )}
                </ul>
                <div className="shell-preset-foot">
                  <button
                    type="button"
                    className="shell-preset-foot-btn"
                    onClick={openPresetEditor}
                  >
                    编辑快捷命令
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="shell-icon-btn"
            disabled={!presets[presetIdx] || !snOk}
            title="运行当前快捷命令（支持多行依次执行）"
            onClick={() => {
              const p = presets[presetIdx];
              if (p) void runShellScript(p.cmd);
            }}
          >
            运行
          </button>
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
          onClick={() => xtermRef.current?.focus()}
        >
          <ShellTerminal
            ref={xtermRef}
            disabled={!snOk}
            onFindShortcut={openFind}
            onSaveShortcut={saveOutput}
            onClearShortcut={() => xtermRef.current?.clear()}
            onReconnectShortcut={() => void connectShell(true)}
            onData={(data) => {
              if (!snOk) return;
              void sendRaw(data);
            }}
          />
        </div>
      </div>

      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={
          <div className="preset-modal-title">
            <strong>快捷命令</strong>
            <span className="preset-count">{presetDraft.length}</span>
          </div>
        }
        footer={
          <>
            <Button onClick={() => setPresetOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void savePresetDraft()}>
              保存全部
            </Button>
          </>
        }
      >
        {presetDraft.length > 0 ? (
          <div className="preset-search-wrap">
            <input
              type="text"
              className="field preset-search-input"
              value={presetDraftQuery}
              onChange={(e) => setPresetDraftQuery(e.target.value)}
              placeholder="模糊搜索快捷命令（名称 / 命令）"
              aria-label="模糊搜索快捷命令"
            />
            {presetDraftQuery ? (
              <button
                type="button"
                className="shell-preset-search-clear"
                onClick={() => setPresetDraftQuery("")}
                title="清空搜索"
                aria-label="清空搜索"
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="preset-list">
          {presetDraft.length === 0 ? (
            <EmptyState
              className="preset-empty"
              title="还没有快捷命令"
              description="在下方填写后点「添加」。"
            />
          ) : filteredDraftPresets.length === 0 ? (
            <EmptyState
              className="preset-empty"
              title="未找到匹配的快捷命令"
              description="可尝试输入名称或命令关键词。"
            />
          ) : (
            filteredDraftPresets.map(({ preset: p, index: i }) => {
              const lineCount = splitShellScript(p.cmd).length;
              return (
                <button
                  key={`${p.cmd}-${i}`}
                  type="button"
                  className={`preset-item${presetEditIdx === i ? " active" : ""}`}
                  onClick={() => selectPresetDraft(i)}
                >
                  <span className="preset-item-idx">{i + 1}</span>
                  <span className="preset-item-body">
                    <span className="preset-item-label">
                      {p.label}
                      {lineCount > 1 ? (
                        <span className="preset-multi-tag">{lineCount} 条</span>
                      ) : null}
                    </span>
                    <span className="preset-item-cmd">{presetCmdPreview(p.cmd)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="preset-form">
          <div className="preset-form-head">
            <span>{presetEditIdx >= 0 ? `编辑第 ${presetEditIdx + 1} 条` : "新建快捷命令"}</span>
            {presetEditIdx >= 0 ? (
              <button type="button" className="link-btn" onClick={resetPresetForm}>
                改为新建
              </button>
            ) : null}
          </div>
          <div className="preset-fields preset-fields-stack">
            <label className="preset-field">
              <span>名称</span>
              <input
                className="field"
                value={presetLabel}
                onChange={(e) => setPresetLabel(e.target.value)}
                placeholder="下拉显示名，可留空"
              />
            </label>
            <label className="preset-field grow">
              <span>命令（每行一条，# 开头为注释，运行时依次执行）</span>
              <textarea
                className="field mono preset-cmd-area"
                value={presetCmd}
                onChange={(e) => setPresetCmd(e.target.value)}
                rows={5}
                placeholder={"getprop ro.product.model\nwm size\ndf -h"}
              />
            </label>
          </div>
          <div className="preset-form-actions">
            <Button variant="primary" onClick={addOrUpdatePresetDraft}>
              {presetEditIdx >= 0 ? "更新" : "添加"}
            </Button>
            <Button
              disabled={presetEditIdx < 0}
              onClick={() => movePresetDraft(-1)}
            >
              上移
            </Button>
            <Button
              disabled={presetEditIdx < 0}
              onClick={() => movePresetDraft(1)}
            >
              下移
            </Button>
            <Button
              variant="danger-ghost"
              disabled={presetEditIdx < 0}
              onClick={deletePresetDraft}
            >
              删除
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
