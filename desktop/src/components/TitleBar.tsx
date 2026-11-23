import { useEffect, useState } from "react";
import { patchAppPrefs, subscribeAppPrefs } from "../appPrefs";
import { useToast } from "./toast";

/** Windows / Linux 自定义标题栏（通知历史 / 置顶 / 最小化 / 最大化 / 关闭） */
export default function TitleBar() {
  const { unreadCount, historyOpen, toggleHistory } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const bridge = window.toolbox;
    if (!bridge?.windowControls) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const info = await bridge.windowControls?.();
        if (cancelled) return;
        const on = Boolean(info?.customTitlebar);
        setEnabled(on);
        if (!on) return;
        setMaximized(Boolean(await bridge.windowIsMaximized?.()));
        setPinned(Boolean(await bridge.windowIsAlwaysOnTop?.()));
        unsub = bridge.onWindowMaximized?.((v) => setMaximized(v));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  useEffect(() => {
    return subscribeAppPrefs((p) => setPinned(Boolean(p.alwaysOnTop)));
  }, []);

  if (!enabled) return null;

  return (
    <header className="titlebar" aria-label="窗口标题栏">
      <div
        className="titlebar-drag"
        onDoubleClick={() => void window.toolbox?.windowToggleMaximize?.()}
      >
        <span className="titlebar-title">AndroidTestToolBox</span>
      </div>
      <div className="titlebar-controls" role="group" aria-label="窗口控制">
        <button
          type="button"
          className={`titlebar-btn titlebar-notif-btn${historyOpen ? " is-on" : ""}`}
          title={unreadCount > 0 ? `通知历史（${unreadCount} 条未读）` : "通知历史"}
          aria-label="通知历史"
          aria-pressed={historyOpen}
          onClick={toggleHistory}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path
              d="M6 1.6a2.6 2.6 0 0 0-2.6 2.6v1.9L2.3 7.7h7.4L8.6 6.1V4.2A2.6 2.6 0 0 0 6 1.6ZM4.8 8.8a1.2 1.2 0 0 0 2.4 0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.15"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {unreadCount > 0 ? (
            <span className="titlebar-notif-badge">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={`titlebar-btn${pinned ? " is-on" : ""}`}
          title={pinned ? "取消钉在顶部" : "钉在顶部"}
          aria-label={pinned ? "取消钉在顶部" : "钉在顶部"}
          aria-pressed={pinned}
          onClick={() => {
            void (async () => {
              const next = await window.toolbox?.windowToggleAlwaysOnTop?.();
              if (typeof next === "boolean") {
                setPinned(next);
                patchAppPrefs({ alwaysOnTop: next });
              }
            })();
          }}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            {pinned ? (
              <path
                d="M6 1.5v6.2M4.2 3.2h3.6L8.5 6.2H3.5L4.2 3.2zM6 7.7v2.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.15"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M4.4 2.2h3.2l.7 3.4H3.7L4.4 2.2zM6 5.6v4.2M3.8 5.6h4.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.15"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.toolbox?.windowMinimize?.()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path d="M2 6h8" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => void window.toolbox?.windowToggleMaximize?.()}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path
                d="M3.5 4.5h5v5h-5zM4.5 3.5h5v5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <rect
                x="2.5"
                y="2.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.toolbox?.windowClose?.()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path
              d="M2.5 2.5l7 7M9.5 2.5l-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
