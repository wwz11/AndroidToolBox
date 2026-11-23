import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { inferStatusTone } from "../statusTone";

export type ToastTone = "err" | "warn" | "ok" | "info";

type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
  source?: string;
  device?: string;
};

export type ToastHistoryItem = {
  id: number;
  text: string;
  tone: ToastTone;
  at: number;
  source?: string;
  device?: string;
};

type ToastApi = {
  push: (text: string, tone?: ToastTone) => void;
  /** 兼容原 status 回调：仅错误/警告弹出 */
  notifyStatus: (msg: string | ((prev: string) => string)) => void;
  history: ToastHistoryItem[];
  unreadCount: number;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  toggleHistory: () => void;
  clearHistory: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;
const MAX_HISTORY = 100;

function toneLabel(tone: ToastTone): string {
  if (tone === "err") return "错误";
  if (tone === "warn") return "注意";
  if (tone === "ok") return "完成";
  return "提示";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function inferContextMeta(): { source: string; device: string } {
  try {
    const nav = document.querySelector(".nav-item.active")?.textContent?.trim() || "";
    const sub = document.querySelector(".subtab.active")?.textContent?.trim() || "";
    const source = nav === "设备" && sub ? `设备 · ${sub}` : nav || sub || "";

    let device = "";
    if (nav === "设备") {
      const chip = document.querySelector(".chips .chip.active .chip-label");
      const label = chip?.textContent?.trim() || "";
      if (label && label !== "新设备" && label !== "未连接") {
        device = label;
      }
    }
    if (!device) {
      const selects = document.querySelectorAll<HTMLSelectElement>("select.device-connect-sn");
      for (const sel of selects) {
        if (sel.offsetParent === null) continue;
        const val = sel.value?.trim();
        if (val) {
          device = sel.selectedOptions?.[0]?.textContent?.trim() || val;
          break;
        }
      }
    }
    return { source, device };
  } catch {
    return { source: "", device: "" };
  }
}

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "err") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (tone === "warn") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path
          d="M8 2.2 14 13H2L8 2.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
        <path d="M8 6.2v3.3M8 11.4v.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (tone === "ok") {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="m5.2 8.2 2 2 3.8-4.2" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v3.8M8 5v.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<ToastHistoryItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [historyOpen, setHistoryOpenState] = useState(false);
  const [filterTone, setFilterTone] = useState<"all" | ToastTone>("all");
  const [filterDevice, setFilterDevice] = useState("all");
  const lastStatusRef = useRef("");
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;

  const setHistoryOpen = useCallback((open: boolean) => {
    setHistoryOpenState(open);
    if (open) setUnreadCount(0);
  }, []);

  const toggleHistory = useCallback(() => {
    setHistoryOpenState((prev) => {
      const next = !prev;
      if (next) setUnreadCount(0);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setUnreadCount(0);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: ToastTone = "info") => {
      const t = (text || "").trim();
      if (!t) return;
      const id = ++toastSeq;
      const now = Date.now();
      const { source, device } = inferContextMeta();
      setItems((prev) => {
        const next = prev.filter((x) => x.text !== t || x.tone !== tone);
        return [...next.slice(-3), { id, text: t, tone, source, device }];
      });
      setHistory((prev) => {
        const top = prev[0];
        if (top && top.text === t && top.tone === tone && now - top.at < 1500) {
          return prev;
        }
        return [{ id, text: t, tone, at: now, source, device }, ...prev].slice(0, MAX_HISTORY);
      });
      if (!historyOpenRef.current) {
        setUnreadCount((c) => Math.min(99, c + 1));
      }
      const ms = tone === "err" ? 7000 : tone === "warn" ? 5500 : 3500;
      window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const notifyStatus = useCallback(
    (msg: string | ((prev: string) => string)) => {
      const text =
        typeof msg === "function" ? msg(lastStatusRef.current) : msg;
      lastStatusRef.current = text || "";
      const tone = inferStatusTone(text || "");
      if (tone === "err") push(text, "err");
      else if (tone === "warn") push(text, "warn");
    },
    [push],
  );

  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen, setHistoryOpen]);

  const historyDevices = useMemo(() => {
    const set = new Set<string>();
    for (const h of history) {
      if (h.device) set.add(h.device);
    }
    return Array.from(set);
  }, [history]);

  const activeFilterDevice =
    filterDevice !== "all" && !historyDevices.includes(filterDevice)
      ? "all"
      : filterDevice;

  const deviceScopedHistory = useMemo(
    () =>
      activeFilterDevice === "all"
        ? history
        : history.filter((h) => h.device === activeFilterDevice),
    [history, activeFilterDevice],
  );

  const filteredHistory = useMemo(
    () =>
      filterTone === "all"
        ? deviceScopedHistory
        : deviceScopedHistory.filter((h) => h.tone === filterTone),
    [deviceScopedHistory, filterTone],
  );

  const toneCounts = useMemo(() => {
    const counts = { all: deviceScopedHistory.length, err: 0, warn: 0, ok: 0, info: 0 };
    for (const h of deviceScopedHistory) counts[h.tone] += 1;
    return counts;
  }, [deviceScopedHistory]);

  const api = useMemo(
    () => ({
      push,
      notifyStatus,
      history,
      unreadCount,
      historyOpen,
      setHistoryOpen,
      toggleHistory,
      clearHistory,
    }),
    [
      push,
      notifyStatus,
      history,
      unreadCount,
      historyOpen,
      setHistoryOpen,
      toggleHistory,
      clearHistory,
    ],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {historyOpen ? (
        <div
          className="app-notif-backdrop"
          onClick={() => setHistoryOpen(false)}
        >
          <section
            className="app-notif-panel"
            aria-label="通知历史"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="app-notif-head">
              <div className="app-notif-title-row">
                <span className="app-notif-title">通知</span>
                {history.length > 0 ? (
                  <span className="app-notif-count">{history.length}</span>
                ) : null}
                <div className="app-notif-actions">
                  {history.length > 0 ? (
                    <button
                      type="button"
                      className="app-notif-link"
                      onClick={clearHistory}
                    >
                      清空
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="app-notif-close"
                    title="关闭"
                    aria-label="关闭通知面板"
                    onClick={() => setHistoryOpen(false)}
                  >
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                      <path
                        d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.35"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="app-notif-filters" role="tablist" aria-label="筛选通知类型">
                {(
                  [
                    ["all", "全部"],
                    ["err", "错误"],
                    ["warn", "注意"],
                    ["ok", "完成"],
                    ["info", "提示"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={filterTone === key}
                    className={`app-notif-tab${filterTone === key ? " is-on" : ""}`}
                    onClick={() => setFilterTone(key)}
                  >
                    {label}
                    {key !== "all" && toneCounts[key] > 0 ? (
                      <span className="app-notif-tab-n">{toneCounts[key]}</span>
                    ) : null}
                  </button>
                ))}
                {historyDevices.length > 1 ? (
                  <select
                    className="app-notif-dev-select"
                    value={activeFilterDevice}
                    aria-label="按设备筛选通知"
                    onChange={(e) => setFilterDevice(e.target.value)}
                  >
                    <option value="all">全部设备</option>
                    {historyDevices.map((dev) => (
                      <option key={dev} value={dev}>
                        {dev}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </header>
            <div className="app-notif-list">
              {filteredHistory.length === 0 ? (
                <div className="app-notif-empty">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                    <path
                      d="M12 3.5a5 5 0 0 0-5 5v3.6l-1.9 2.9h13.8L17 12.1V8.5a5 5 0 0 0-5-5Zm-2.2 13.8a2.2 2.2 0 0 0 4.4 0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>暂无通知</span>
                </div>
              ) : (
                filteredHistory.map((item) => (
                  <div
                    key={item.id}
                    className={`app-notif-item is-${item.tone}`}
                  >
                    <span className="app-notif-dot" aria-hidden />
                    <div className="app-notif-item-body">
                      <div className="app-notif-item-text">{item.text}</div>
                      <div className="app-notif-item-sub">
                        <span>{toneLabel(item.tone)}</span>
                        {item.source ? (
                          <>
                            <span>·</span>
                            <span>{item.source}</span>
                          </>
                        ) : null}
                        {item.device ? (
                          <>
                            <span>·</span>
                            <span className="app-notif-item-dev" title={item.device}>
                              {item.device}
                            </span>
                          </>
                        ) : null}
                        <span>·</span>
                        <span className="app-notif-item-time">{formatTime(item.at)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
      <div className="app-toasts" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`app-toast is-${item.tone}`}
            title="点击关闭"
            onClick={() => dismiss(item.id)}
          >
            <span className="app-toast-icon">
              <ToneIcon tone={item.tone} />
            </span>
            <span className="app-toast-body">
              <span className="app-toast-head">
                <span className="app-toast-label">{toneLabel(item.tone)}</span>
                {item.source || item.device ? (
                  <span className="app-toast-meta">
                    {[item.source, item.device].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="app-toast-text">{item.text}</span>
            </span>
            <span className="app-toast-close" aria-hidden>
              ×
            </span>
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 需在 ToastProvider 内使用");
  return ctx;
}

/** 替代原状态栏：仅弹出错误/警告 */
export function useStatusNotify() {
  return useToast().notifyStatus;
}
