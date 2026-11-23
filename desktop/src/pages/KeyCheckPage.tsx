import { useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type KeyCaptureResponse, type KeyHidId } from "../api/client";
import { toErrorMessage } from "../errors";
import Modal from "../components/Modal";
import { useDialog } from "../components/dialog";
import { useStatusNotify } from "../components/toast";
import {
  importKeyTable,
  judge,
  normalizePair,
  parseCode,
  samePair,
  type Judge,
} from "../keycheck/model";
import { Button, EmptyState, Toolbar } from "../ui";

const ROWS_KEY = "toolbox.keycheck.rows.v1";
const MAX_KEYS = 80;

type KeyRow = {
  id: string;
  name: string;
  page: string;
  usage: string;
  actualPage: string;
  actualUsage: string;
  /** 同一键两次读数不同 */
  repeatMismatch: boolean;
  /** 已记下第一次，还要再按一次 */
  awaitingRepeat: boolean;
};

type FilterId = "all" | "mismatch" | "missing" | "match";

type LiveStep = {
  index: number;
  total: number;
  name: string;
  again: boolean;
};

let rowSeq = 0;

function nextId(): string {
  rowSeq += 1;
  return `k${Date.now().toString(36)}${rowSeq.toString(36)}`;
}

function emptyRow(): KeyRow {
  return {
    id: nextId(),
    name: "",
    page: "",
    usage: "",
    actualPage: "",
    actualUsage: "",
    repeatMismatch: false,
    awaitingRepeat: false,
  };
}

function rowJudge(row: KeyRow): Judge {
  if (row.awaitingRepeat && (row.actualPage.trim() || row.actualUsage.trim())) {
    return { kind: "missing", label: "待再按一次" };
  }
  if (row.repeatMismatch && (row.actualPage.trim() || row.actualUsage.trim())) {
    return { kind: "mismatch", label: "两次不一致" };
  }
  const page = parseCode(row.page, "page");
  const usage = parseCode(row.usage, "usage");
  if (page.kind === "empty" && usage.kind === "empty") {
    const actualPage = parseCode(row.actualPage, "page");
    const actualUsage = parseCode(row.actualUsage, "usage");
    if (actualPage.kind === "empty" && actualUsage.kind === "empty") {
      return { kind: "missing", label: "待填写" };
    }
    return { kind: "invalid", label: "未填期望" };
  }
  const result = judge(
    { page: row.page, usage: row.usage },
    { page: row.actualPage, usage: row.actualUsage },
  );
  if (result.kind === "missing") return { kind: "missing", label: "未核对" };
  return result;
}

function canCapture(row: KeyRow): boolean {
  return (
    parseCode(row.page, "page").kind === "value" &&
    parseCode(row.usage, "usage").kind === "value" &&
    row.name.trim().length > 0
  );
}

function codesMatch(expected: string, actual: string, slot: "page" | "usage"): boolean {
  const left = parseCode(expected, slot);
  const right = parseCode(actual, slot);
  if (left.kind === "value" && right.kind === "value") return left.value === right.value;
  if (left.kind === "empty" && right.kind === "empty") return true;
  if (left.kind === "na" && right.kind === "na") return true;
  return false;
}

function actualTone(expected: string, actual: string, slot: "page" | "usage"): string {
  if (!actual.trim()) return " is-empty";
  if (!expected.trim()) return "";
  return codesMatch(expected, actual, slot) ? " is-ok" : " is-diff";
}

function hydrateRow(raw: unknown, index: number): KeyRow | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Partial<KeyRow>;
  const id = String(src.id || "").trim() || `legacy-${index}`;
  return {
    id,
    name: String(src.name || ""),
    page: String(src.page || ""),
    usage: String(src.usage || ""),
    actualPage: String(src.actualPage || ""),
    actualUsage: String(src.actualUsage || ""),
    repeatMismatch: Boolean(src.repeatMismatch),
    awaitingRepeat: Boolean(src.awaitingRepeat),
  };
}

function rowsFromUnknown(raw: unknown): KeyRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: KeyRow[] = [];
  raw.forEach((item, index) => {
    const row = hydrateRow(item, index);
    if (row) rows.push(row);
  });
  return rows.slice(0, MAX_KEYS);
}

function loadRows(): KeyRow[] {
  try {
    const raw = localStorage.getItem(ROWS_KEY);
    if (!raw) return [];
    return rowsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function saveRows(list: KeyRow[]) {
  localStorage.setItem(ROWS_KEY, JSON.stringify(list));
}

function idHint(devices: KeyHidId[]): string {
  if (!devices.length) return "未读到蓝牙 VID / PID";
  return devices
    .map((item) => {
      const name = item.name.trim();
      const pair = `VID ${item.vid}，PID ${item.pid}`;
      return name && name !== "未命名" ? `${pair}（${name}）` : pair;
    })
    .join("；");
}

type Props = {
  deviceSn: string;
  /** 当前设备子页是否可见 */
  active?: boolean;
  deviceOnline?: boolean;
};

export default function KeyCheckPage({
  deviceSn,
  active = true,
  deviceOnline = true,
}: Props) {
  const dialog = useDialog();
  const setStatus = useStatusNotify();
  const initial = useMemo(loadRows, []);
  const [keyRows, setKeyRows] = useState(initial);
  const [hidIds, setHidIds] = useState<KeyHidId[]>([]);
  const [idNote, setIdNote] = useState("正在查询");
  const [idLoading, setIdLoading] = useState(false);
  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [listenId, setListenId] = useState<string | null>(null);
  const [listenHint, setListenHint] = useState("请按一次");
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState<LiveStep | null>(null);
  const rowsRef = useRef(keyRows);
  const listenRef = useRef<{ ws: WebSocket; sn: string } | null>(null);
  const deviceSnRef = useRef(deviceSn);
  const deviceOnlineRef = useRef(deviceOnline);
  const activeRef = useRef(active);
  const pausedRef = useRef(false);
  const promptTextRef = useRef("");
  const startingRef = useRef(false);
  const focusRowRef = useRef<string | null>(null);
  rowsRef.current = keyRows;
  deviceSnRef.current = deviceSn;
  deviceOnlineRef.current = deviceOnline;
  activeRef.current = active;

  useEffect(() => {
    const running = listenRef.current;
    if (!running) return;
    if (active && running.sn === deviceSn) return;
    listenRef.current = null;
    resetRunUi();
    running.ws.close();
    void api.cancelKeyCapture(running.sn).catch(() => undefined);
  }, [active, deviceSn]);

  useEffect(() => {
    if (!listenId) return;
    document.getElementById(`keycheck-${listenId}`)?.scrollIntoView({ block: "nearest" });
  }, [listenId]);

  useEffect(() => {
    const id = focusRowRef.current;
    if (!id) return;
    const line = document.getElementById(`keycheck-${id}`);
    if (!line) return;
    focusRowRef.current = null;
    line.scrollIntoView({ block: "center" });
    line.querySelector("input")?.focus();
  }, [keyRows, filter, query]);

  useEffect(() => {
    if (!active) return;
    if (!deviceOnline || !deviceSn.trim()) {
      setHidIds([]);
      setIdNote("设备不在线");
      return;
    }
    const sn = deviceSn.trim();
    let cancel = false;
    setIdLoading(true);
    setIdNote("正在查询");
    void api
      .deviceKeyIds(sn)
      .then((res) => {
        if (cancel || deviceSnRef.current.trim() !== sn) return;
        setHidIds(res.devices);
        setIdNote(res.devices.length ? "" : res.message || "未读到蓝牙输入设备的 VID / PID");
      })
      .catch((error: unknown) => {
        if (cancel || deviceSnRef.current.trim() !== sn) return;
        setHidIds([]);
        setIdNote(toErrorMessage(error, "VID / PID 查询失败"));
      })
      .finally(() => {
        if (!cancel) setIdLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [active, deviceOnline, deviceSn]);

  function commitRows(next: KeyRow[]) {
    const list = next.slice(0, MAX_KEYS);
    try {
      saveRows(list);
    } catch {
      setStatus("按键保存失败");
    }
    rowsRef.current = list;
    setKeyRows(list);
  }

  function addRow() {
    if (listenRef.current) return;
    const last = rowsRef.current[rowsRef.current.length - 1];
    const lastBlank =
      last &&
      !last.name.trim() &&
      !last.page.trim() &&
      !last.usage.trim() &&
      !last.actualPage.trim() &&
      !last.actualUsage.trim();
    if (!lastBlank && rowsRef.current.length >= MAX_KEYS) {
      setStatus(`最多 ${MAX_KEYS} 个按键`);
      return;
    }
    if (lastBlank && filter === "all" && !query) {
      const line = document.getElementById(`keycheck-${last.id}`);
      line?.scrollIntoView({ block: "center" });
      line?.querySelector("input")?.focus();
      return;
    }
    if (filter !== "all") setFilter("all");
    if (query) setQuery("");
    if (lastBlank) {
      focusRowRef.current = last.id;
      return;
    }
    const row = emptyRow();
    focusRowRef.current = row.id;
    commitRows([...rowsRef.current, row]);
  }

  async function deleteRow(id: string) {
    const row = rowsRef.current.find((item) => item.id === id);
    if (!row) return;
    if (listenId === id) {
      setStatus("该按键正在核对");
      return;
    }
    const filled = row.name.trim() || row.page.trim() || row.usage.trim() || row.actualPage.trim();
    if (filled) {
      const ok = await dialog.confirm({
        title: "删除按键",
        message: `确定删除「${row.name || "未命名"}」？`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    commitRows(rowsRef.current.filter((item) => item.id !== id));
  }

  function setRow(id: string, patch: Partial<KeyRow>) {
    commitRows(rowsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function blurExpected(id: string) {
    commitRows(
      rowsRef.current.map((row) => {
        if (row.id !== id) return row;
        const next = normalizePair({ page: row.page, usage: row.usage });
        if (next.page === row.page && next.usage === row.usage) return row;
        return { ...row, page: next.page, usage: next.usage };
      }),
    );
  }

  function replaceRows(next: KeyRow[], message: string) {
    commitRows(next);
    setStatus(message);
  }

  async function applyImported(text: string) {
    const imported = importKeyTable(text);
    if (!imported.keys.length) {
      setStatus(imported.message);
      return false;
    }
    if (rowsRef.current.length > 0) {
      const ok = await dialog.confirm({
        title: "替换按键表",
        message: `将用 ${imported.keys.length} 个按键替换现有列表。已核对的实际值会清掉。`,
        confirmLabel: "替换",
      });
      if (!ok) return false;
    }
    replaceRows(
      imported.keys.slice(0, MAX_KEYS).map((key) => ({
        id: nextId(),
        name: key.name,
        page: key.page,
        usage: key.usage,
        actualPage: "",
        actualUsage: "",
        repeatMismatch: false,
        awaitingRepeat: false,
      })),
      imported.message,
    );
    return true;
  }

  function applyPaste() {
    if (!pasteText.trim()) {
      setStatus("请先粘贴键表");
      return;
    }
    void applyImported(pasteText).then((ok) => {
      if (ok) setPasteOpen(false);
    });
  }

  function resetRunUi() {
    pausedRef.current = false;
    setPaused(false);
    setLive(null);
    setListenId(null);
    setListenHint("请按一次");
  }

  function stopListen(status = "已停止") {
    const current = listenRef.current;
    if (!current) return;
    listenRef.current = null;
    resetRunUi();
    current.ws.close();
    setStatus(status);
    void api.cancelKeyCapture(current.sn).catch(() => undefined);
  }

  function pauseListen() {
    if (!listenRef.current || pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    setStatus("已暂停。点「继续」后接着按当前键。");
  }

  function resumeListen() {
    if (!listenRef.current || !pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    setStatus(promptTextRef.current || "请继续按当前键");
  }

  function sequencePlan(): { ids: string[]; skipped: number; rerun: boolean } {
    const all = rowsRef.current;
    const ready = all.filter(canCapture);
    const pending = ready.filter((row) => {
      const kind = rowJudge(row).kind;
      return kind !== "match" && kind !== "na";
    });
    const rerun = pending.length === 0;
    return {
      ids: (rerun ? ready : pending).map((row) => row.id),
      skipped: all.length - ready.length,
      rerun,
    };
  }

  function promptRow(id: string, index: number, totalCount: number, again: boolean, lead = "") {
    const row = rowsRef.current.find((item) => item.id === id);
    const hint = again ? "请再按一次" : "请按一次";
    setListenId(id);
    setListenHint(hint);
    const name = row?.name.trim() || "按键";
    const line = `${hint}「${name}」（${index + 1}/${totalCount}）`;
    const text = lead ? `${lead}。${line}` : line;
    promptTextRef.current = text;
    setLive({ index, total: totalCount, name, again });
    setStatus(text);
  }

  async function startSequence() {
    if (listenRef.current || startingRef.current) return;
    if (!deviceOnlineRef.current) {
      setStatus("设备不在线");
      return;
    }
    const sn = deviceSnRef.current.trim();
    if (!sn) {
      setStatus("请先打开设备会话");
      return;
    }
    const plan = sequencePlan();
    const ids = plan.ids;
    if (!ids.length) {
      setStatus("请先填写按键名，以及成对的期望 Page / Usage");
      return;
    }
    startingRef.current = true;
    let ready = false;
    let hint = idHint(hidIds);
    try {
      const fresh = await api.deviceKeyIds(sn);
      if (deviceSnRef.current.trim() === sn) {
        setHidIds(fresh.devices);
        setIdNote(fresh.devices.length ? "" : fresh.message || "未读到蓝牙输入设备的 VID / PID");
        hint = fresh.devices.length ? idHint(fresh.devices) : fresh.message || hint;
      }
    } catch (error: unknown) {
      hint = toErrorMessage(error, "VID / PID 查询失败");
    }
    try {
      ready = await dialog.confirm({
        title: "切换为蓝牙按键",
        message: "请将遥控器的学码按键切换为蓝牙按键，再开始核对。学码模式下读到的不是蓝牙键值。",
        detail: hint,
        note: [
          "请对照上面的 VID、PID。每个按键连按两次，两次相同才算通过。",
          plan.rerun
            ? `将重新核对全部 ${ids.length} 个已填好的按键。`
            : `将核对 ${ids.length} 个未通过的按键，已通过的会跳过。`,
          plan.skipped ? `${plan.skipped} 个没填全的按键不会核对。` : "",
        ]
          .filter(Boolean)
          .join(""),
        confirmLabel: "已切换，开始核对",
        cancelLabel: "取消",
      });
    } finally {
      startingRef.current = false;
    }
    if (!ready || !activeRef.current || listenRef.current) return;
    if (!deviceOnlineRef.current) {
      setStatus("设备不在线");
      return;
    }
    const ws = new WebSocket(
      wsUrl(`/adb/device/key-capture/ws?device=${encodeURIComponent(sn)}`),
    );
    listenRef.current = { ws, sn };
    let index = 0;
    let again = false;
    let first: { page: string; usage: string } | null = null;
    promptRow(ids[0], 0, ids.length, false);
    ws.onmessage = (event) => {
      let msg: KeyCaptureResponse & { type?: string };
      try {
        msg = JSON.parse(String(event.data)) as KeyCaptureResponse & { type?: string };
      } catch {
        return;
      }
      if (msg.type === "ready") return;
      if (msg.type === "error") {
        stopListen(msg.message || "核对中断");
        return;
      }
      if (msg.type !== "press" || pausedRef.current) return;
      const id = ids[index];
      if (!id || listenRef.current?.ws !== ws) return;
      if (!msg.ok || (!msg.page && !msg.usage)) {
        const hint = again ? "请再按一次" : "请按一次";
        setStatus(msg.message || `没有读到键值，${hint}`);
        return;
      }
      const row = rowsRef.current.find((item) => item.id === id);
      if (!row) return;
      const heard = [msg.page, msg.usage].filter(Boolean).join(" / ");
      if (!again) {
        first = { page: msg.page, usage: msg.usage };
        again = true;
        const readRow: KeyRow = {
          ...row,
          actualPage: msg.page,
          actualUsage: msg.usage,
          repeatMismatch: false,
          awaitingRepeat: true,
        };
        commitRows(rowsRef.current.map((item) => (item.id === id ? readRow : item)));
        promptRow(id, index, ids.length, true, `「${row.name.trim() || "按键"}」第一次读到 ${heard}`);
        return;
      }
      const agreed =
        first !== null &&
        samePair(first, { page: msg.page, usage: msg.usage });
      const firstHeard = first ? [first.page, first.usage].filter(Boolean).join(" / ") : "";
      const nextRow: KeyRow = {
        ...row,
        actualPage: msg.page,
        actualUsage: msg.usage,
        repeatMismatch: !agreed,
        awaitingRepeat: false,
      };
      commitRows(rowsRef.current.map((item) => (item.id === id ? nextRow : item)));
      const result = rowJudge(nextRow);
      const other = rowsRef.current.find(
        (item) =>
          item.id !== id &&
          samePair({ page: item.page, usage: item.usage }, { page: msg.page, usage: msg.usage }),
      );
      const extra = other ? `，与「${other.name || "未命名"}」的期望相同` : "";
      const lead = agreed
        ? `${row.name.trim()}：${result.label}，两次均为 ${heard}${extra}`
        : `${row.name.trim()}：两次不一致，第一次 ${firstHeard}，第二次 ${heard}`;
      again = false;
      first = null;
      index += 1;
      if (index >= ids.length) {
        listenRef.current = null;
        resetRunUi();
        ws.close();
        void api.cancelKeyCapture(sn).catch(() => undefined);
        setStatus(`${lead}。已按顺序核对 ${ids.length} 个按键`);
        return;
      }
      promptRow(ids[index], index, ids.length, false, lead);
    };
    ws.onerror = () => {
      if (listenRef.current?.ws !== ws) return;
      listenRef.current = null;
      resetRunUi();
      setStatus("核对连接失败");
      ws.close();
      void api.cancelKeyCapture(sn).catch(() => undefined);
    };
    ws.onclose = () => {
      if (listenRef.current?.ws !== ws) return;
      listenRef.current = null;
      resetRunUi();
    };
  }

  async function clearActual() {
    const filled = rowsRef.current.some((row) => row.actualPage.trim() || row.actualUsage.trim());
    if (!filled) return;
    const ok = await dialog.confirm({
      title: "清空核对结果",
      message: "确定清空已读到的实际键值？期望键值保留。",
      confirmLabel: "清空",
      danger: true,
    });
    if (!ok) return;
    commitRows(
      rowsRef.current.map((row) => ({
        ...row,
        actualPage: "",
        actualUsage: "",
        repeatMismatch: false,
        awaitingRepeat: false,
      })),
    );
    setStatus("已清空实际键值");
  }

  async function copyResult() {
    const lines = ["按键\t期望Page\t期望Usage\t实际Page\t实际Usage\t判定"];
    for (const row of rowsRef.current) {
      const result = rowJudge(row);
      lines.push(
        [row.name, row.page, row.usage, row.actualPage, row.actualUsage, result.label].join("\t"),
      );
    }
    const text = lines.join("\n");
    try {
      if (window.toolbox?.clipboardWriteText) await window.toolbox.clipboardWriteText(text);
      else await navigator.clipboard.writeText(text);
      setStatus("已复制判定结果");
    } catch {
      setStatus("复制失败");
    }
  }

  const rows = useMemo(() => {
    const source = keyRows;
    const q = query.trim().toLowerCase();
    return source
      .map((row) => ({ row, result: rowJudge(row) }))
      .filter(({ row, result }) => {
        if (q && !row.name.toLowerCase().includes(q)) return false;
        if (filter === "mismatch") return result.kind === "mismatch" || result.kind === "invalid";
        if (filter === "missing") return result.kind === "missing";
        if (filter === "match") return result.kind === "match";
        return true;
      });
  }, [keyRows, filter, query]);

  const counts = useMemo(() => {
    const bag = { match: 0, mismatch: 0, missing: 0, na: 0, invalid: 0 };
    for (const row of keyRows) bag[rowJudge(row).kind] += 1;
    return bag;
  }, [keyRows]);

  const total = keyRows.length;
  const overall = !total
    ? "未添加"
    : counts.invalid || counts.mismatch
      ? "不通过"
      : counts.missing
        ? "未完成"
        : "通过";
  const actualDirty = keyRows.some((row) => row.actualPage || row.actualUsage);

  const overallTone =
    counts.mismatch || counts.invalid ? "is-bad" : counts.missing || !total ? "is-miss" : "is-ok";

  return (
    <>
      <div className="tool-panel keycheck-panel">
        <div className="keycheck-sheet">
          <div className="keycheck-head">
            <Toolbar
              className="keycheck-bar"
              start={
                <>
                  {listenId ? (
                    <>
                      <Button variant="primary" onClick={paused ? resumeListen : pauseListen}>
                        {paused ? "继续" : "暂停"}
                      </Button>
                      <Button onClick={() => stopListen()}>停止</Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={!deviceOnline || !keyRows.some(canCapture)}
                      onClick={() => void startSequence()}
                    >
                      开始核对
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setPasteOpen(true)}>
                    粘贴键表
                  </Button>
                  <Button variant="ghost" disabled={!actualDirty || !!listenId} onClick={() => void clearActual()}>
                    清空实际
                  </Button>
                  <Button variant="ghost" disabled={!total} onClick={() => void copyResult()}>
                    复制结果
                  </Button>
                </>
              }
              end={
                <div className="keycheck-stats" aria-label={overall}>
                  <b className={`keycheck-overall ${overallTone}`}>{overall}</b>
                  <span>
                    <em>{counts.match}</em> 一致
                  </span>
                  <span>
                    <em>{counts.mismatch}</em> 不一致
                  </span>
                  <span>
                    <em>{counts.missing}</em> 待核对
                  </span>
                </div>
              }
            />

            <div className="keycheck-sub">
              <div className="keycheck-ids">
                <span className="keycheck-ids-label">蓝牙</span>
                {hidIds.length ? (
                  hidIds.map((item) => (
                    <span className="keycheck-id" key={`${item.vid}-${item.pid}-${item.name}`}>
                      <span className="mono">VID {item.vid}</span>
                      <span className="keycheck-id-sep" aria-hidden="true" />
                      <span className="mono">PID {item.pid}</span>
                      {item.name && item.name !== "未命名" ? (
                        <span className="keycheck-id-name">{item.name}</span>
                      ) : null}
                    </span>
                  ))
                ) : (
                  <span className={`keycheck-ids-note${idLoading ? "" : " is-warn"}`}>
                    {idLoading ? "正在查询" : idNote}
                  </span>
                )}
                <button
                  type="button"
                  className="keycheck-text-btn"
                  disabled={!deviceOnline || idLoading}
                  onClick={() => {
                    const sn = deviceSnRef.current.trim();
                    if (!sn) return;
                    setIdLoading(true);
                    void api
                      .deviceKeyIds(sn)
                      .then((res) => {
                        if (deviceSnRef.current.trim() !== sn) return;
                        setHidIds(res.devices);
                        setIdNote(res.devices.length ? "" : res.message || "未读到蓝牙输入设备的 VID / PID");
                      })
                      .catch((error: unknown) => {
                        if (deviceSnRef.current.trim() !== sn) return;
                        setHidIds([]);
                        setIdNote(toErrorMessage(error, "VID / PID 查询失败"));
                      })
                      .finally(() => setIdLoading(false));
                  }}
                >
                  {idLoading ? "查询中" : "刷新"}
                </button>
              </div>
              <div className="keycheck-filters">
                <label className="keycheck-filter-label">
                  筛选
                  <select
                    className="field keycheck-filter"
                    aria-label="筛选判定"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value as FilterId)}
                  >
                    <option value="all">全部</option>
                    <option value="mismatch">不一致</option>
                    <option value="missing">未核对</option>
                    <option value="match">一致</option>
                  </select>
                </label>
                <input
                  className="field keycheck-query"
                  placeholder="按按键名查找"
                  aria-label="按按键名查找"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
          </div>

          {live ? (
            <div
              key={`${live.index}-${live.again ? "again" : "once"}`}
              className={`keycheck-stage${paused ? " is-paused" : live.again ? " is-again" : ""}`}
            >
              <div className="keycheck-stage-action">
                <span className="keycheck-stage-dot" aria-hidden="true" />
                {paused ? "已暂停" : live.again ? "请再按一次" : "请按一次"}
              </div>
              <div className="keycheck-stage-copy">
                <div className="keycheck-stage-name">{live.name}</div>
                <div className="keycheck-stage-kicker">
                  {paused
                    ? "继续后接着按当前键"
                    : live.again
                      ? "再按同一键，两次相同才进入下一个"
                      : "学码按键请保持蓝牙"}
                </div>
              </div>
              <div className="keycheck-stage-progress" aria-hidden="true">
                <strong>
                  {live.index + 1}
                  <span>/{live.total}</span>
                </strong>
              </div>
              <div className="keycheck-stage-bar" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(100, Math.round(((live.index + (live.again ? 0.5 : 0)) / live.total) * 100))}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          <div className="keycheck-table-wrap">
            <table className="keycheck-table">
              <colgroup>
                <col className="keycheck-col-name" />
                <col className="keycheck-col-code" />
                <col className="keycheck-col-code" />
                <col className="keycheck-col-code" />
                <col className="keycheck-col-code" />
                <col className="keycheck-col-verdict" />
                <col className="keycheck-col-del" />
              </colgroup>
              <thead>
                <tr>
                  <th rowSpan={2}>按键</th>
                  <th colSpan={2} className="keycheck-group">
                    期望
                  </th>
                  <th colSpan={2} className="keycheck-group keycheck-group-actual keycheck-split">
                    实际
                  </th>
                  <th rowSpan={2}>判定</th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  <th>Page</th>
                  <th>Usage</th>
                  <th className="keycheck-split keycheck-group-actual">Page</th>
                  <th className="keycheck-group-actual">Usage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ row, result }) => {
                  const listening = listenId === row.id;
                  const settled =
                    !listening &&
                    (result.kind === "match"
                      ? " is-ok"
                      : result.kind === "mismatch" || result.kind === "invalid"
                        ? " is-bad"
                        : "");
                  return (
                    <tr
                      key={row.id}
                      id={`keycheck-${row.id}`}
                      className={`keycheck-row${
                        listening
                          ? paused
                            ? " is-paused"
                            : live?.again
                              ? " is-again"
                              : " is-live"
                          : settled
                      }`}
                    >
                      <td>
                        <input
                          className="field keycheck-name-input"
                          aria-label="按键名"
                          placeholder="按键名"
                          value={row.name}
                          spellCheck={false}
                          disabled={!!listenId}
                          onChange={(event) => setRow(row.id, { name: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="field mono keycheck-code"
                          aria-label={`${row.name || "按键"} 期望 Page`}
                          value={row.page}
                          spellCheck={false}
                          disabled={!!listenId}
                          onChange={(event) => setRow(row.id, { page: event.target.value })}
                          onBlur={() => blurExpected(row.id)}
                        />
                      </td>
                      <td>
                        <input
                          className="field mono keycheck-code"
                          aria-label={`${row.name || "按键"} 期望 Usage`}
                          value={row.usage}
                          spellCheck={false}
                          disabled={!!listenId}
                          onChange={(event) => setRow(row.id, { usage: event.target.value })}
                          onBlur={() => blurExpected(row.id)}
                        />
                      </td>
                      <td className="keycheck-split keycheck-actual-cell">
                        <span className={`keycheck-actual${actualTone(row.page, row.actualPage, "page")}`}>
                          {row.actualPage || "—"}
                        </span>
                      </td>
                      <td className="keycheck-actual-cell">
                        <span className={`keycheck-actual${actualTone(row.usage, row.actualUsage, "usage")}`}>
                          {row.actualUsage || "—"}
                        </span>
                      </td>
                      <td>
                        <span className={`keycheck-verdict is-${result.kind}`}>
                          {listening ? (paused ? "已暂停" : listenHint) : result.label}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="keycheck-text-btn"
                          disabled={!!listenId}
                          onClick={() => void deleteRow(row.id)}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="keycheck-empty">
                      {total ? (
                        <EmptyState title="没有符合筛选的按键" description="换个筛选条件，或清空查找。" />
                      ) : (
                        <EmptyState
                          title="还没有按键"
                          description="粘贴键表，或在下面加一行。"
                          action={
                            <Button variant="ghost" onClick={() => setPasteOpen(true)}>
                              粘贴键表
                            </Button>
                          }
                        />
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="keycheck-foot">
            <button type="button" className="keycheck-add-btn" disabled={!!listenId} onClick={addRow}>
              <span className="keycheck-add-mark" aria-hidden="true">
                +
              </span>
              添加一行
            </button>
          </div>
        </div>
      </div>

      <Modal
        open={pasteOpen}
        title="粘贴键表"
        onClose={() => setPasteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasteOpen(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={applyPaste}>
              写入期望键值
            </Button>
          </>
        }
      >
        <div className="keycheck-paste">
          <p className="keycheck-paste-hint">
            每行「按键名、Page、Usage」，Tab、逗号或空格分隔。开始核对后，每个按键连按两次。
          </p>
          <textarea
            className="field mono"
            value={pasteText}
            spellCheck={false}
            placeholder={"Power\t0x0C\t0x0030\nUp\t0x0C\t0x0042"}
            onChange={(event) => setPasteText(event.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}
