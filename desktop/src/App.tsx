import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { REQUIRED_API_REV, api } from "./api/client";
import { patchAppPrefs, readAppPrefs, subscribeAppPrefs } from "./appPrefs";
import {
  subscribeActivities,
  type ActivityEntry,
} from "./activity";
import Modal from "./components/Modal";
import { EmptyState, StatusBanner } from "./ui";
import AboutModal from "./features/about/AboutModal";
import ErrorBoundary from "./components/ErrorBoundary";
import { NavGlyph } from "./components/NavGlyph";
import TitleBar from "./components/TitleBar";
import DevicePage from "./pages/DevicePage";
import EmmcPage from "./pages/EmmcPage";
import MonkeyPage from "./pages/MonkeyPage";
import Md5Page from "./pages/Md5Page";
import Base64Page from "./pages/Base64Page";
import BarcodePage from "./pages/BarcodePage";
import GotaPage from "./pages/GotaPage";
import SerialPage from "./pages/SerialPage";
import { applyTheme, readStoredTheme, type ThemeId } from "./theme";

type NavKey =
  | "devices"
  | "emmc"
  | "monkey"
  | "serial"
  | "md5"
  | "barcode"
  | "base64"
  | "gota";

type CloseAction = "tray" | "quit" | "cancel";

type AppPromptSpec = {
  mark?: string;
  title?: string;
  body?: string;
  tips?: string[];
  primary?: string;
  secondary?: string;
};

const NAV_RAIL = 64;
const NAV_MIN = 168;
const NAV_MAX = 320;
const NAV_SNAP = 128;
const NAV_LABEL_AT = 112;

const NAV_GROUPS: {
  label: string;
  items: { key: NavKey; label: string }[];
}[] = [
  {
    label: "设备",
    items: [
      { key: "devices", label: "设备" },
      { key: "emmc", label: "eMMC测试" },
      { key: "monkey", label: "Monkey测试" },
      { key: "serial", label: "串口终端" },
    ],
  },
  {
    label: "工具",
    items: [
      { key: "md5", label: "MD5值生成" },
      { key: "barcode", label: "条形码预览" },
      { key: "base64", label: "BASE64" },
      { key: "gota", label: "GOTA序列号分割器" },
    ],
  },
];

export default function App() {
  const [nav, setNav] = useState<NavKey>("devices");
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [apiStale, setApiStale] = useState(false);
  const [version, setVersion] = useState("…");
  const [buildTag, setBuildTag] = useState("");
  const [apiRev, setApiRev] = useState<number | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [installDir, setInstallDir] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [updateMsg, setUpdateMsg] = useState("");
  const [updateState, setUpdateState] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [rememberClose, setRememberClose] = useState(false);
  const [appPrompt, setAppPrompt] = useState<AppPromptSpec | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [navCollapsed, setNavCollapsed] = useState(
    () => readAppPrefs().navCollapsed,
  );
  const [navWidth, setNavWidth] = useState(() => readAppPrefs().navWidth);
  const [navDragging, setNavDragging] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const navDragRef = useRef({ collapsed: navCollapsed, width: navWidth });
  const navDragOrigin = useRef(navWidth);
  const navDraggingRef = useRef(false);
  const navLiveRef = useRef(navCollapsed ? NAV_RAIL : navWidth);

  useEffect(() => subscribeActivities(setActivities), []);
  useEffect(
    () =>
      subscribeAppPrefs((prefs) => {
        if (navDraggingRef.current) return;
        setNavCollapsed(prefs.navCollapsed);
        setNavWidth(prefs.navWidth);
      }),
    [],
  );

  useEffect(() => {
    navDragRef.current = { collapsed: navCollapsed, width: navWidth };
  }, [navCollapsed, navWidth]);

  function paintNav(width: number) {
    const el = appRef.current;
    if (!el) return;
    el.style.gridTemplateColumns = `${Math.round(width)}px minmax(0, 1fr)`;
    el.classList.toggle("is-nav-collapsed", width < NAV_LABEL_AT);
    el.classList.add("is-nav-dragging");
  }

  useLayoutEffect(() => {
    if (!navDraggingRef.current) return;
    paintNav(navLiveRef.current);
  });

  function finishNavDrag(collapsed: boolean, width: number) {
    navDraggingRef.current = false;
    const el = appRef.current;
    if (el) {
      const live = Math.round(navLiveRef.current);
      el.classList.remove("is-nav-dragging");
      el.style.gridTemplateColumns = `${live}px minmax(0, 1fr)`;
      void el.offsetWidth;
      el.style.gridTemplateColumns = `${collapsed ? NAV_RAIL : width}px minmax(0, 1fr)`;
      el.classList.toggle("is-nav-collapsed", collapsed);
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    navDragRef.current = { collapsed, width };
    setNavDragging(false);
    setNavCollapsed(collapsed);
    setNavWidth(width);
    patchAppPrefs({ navCollapsed: collapsed, navWidth: width });
  }

  function onNavSplitterDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const current = navDragRef.current.collapsed ? NAV_RAIL : navDragRef.current.width;
    navDragOrigin.current = navDragRef.current.width;
    navLiveRef.current = current;
    navDraggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setNavDragging(true);
    paintNav(current);
  }

  function onNavSplitterMove(e: PointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const left = appRef.current?.getBoundingClientRect().left ?? 0;
    const next = Math.min(NAV_MAX, Math.max(NAV_RAIL, e.clientX - left));
    navLiveRef.current = next;
    paintNav(next);
  }

  function onNavSplitterUp(e: PointerEvent<HTMLDivElement>) {
    if (!navDraggingRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const live = navLiveRef.current;
    const collapsed = live < NAV_SNAP;
    const width = collapsed
      ? navDragOrigin.current
      : Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, live)));
    finishNavDrag(collapsed, width);
  }

  function onNavSplitterKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (navCollapsed || navWidth - 16 < NAV_MIN) {
        patchAppPrefs({ navCollapsed: true });
      } else {
        patchAppPrefs({ navWidth: navWidth - 16 });
      }
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (navCollapsed) patchAppPrefs({ navCollapsed: false });
      else patchAppPrefs({ navWidth: Math.min(NAV_MAX, navWidth + 16) });
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      patchAppPrefs({ navCollapsed: !navCollapsed });
    }
  }

  const activityByNav = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>();
    for (const a of activities) {
      const list = map.get(a.nav) || [];
      list.push(a);
      map.set(a.nav, list);
    }
    return map;
  }, [activities]);

  const autoKickApiRef = useRef(false);

  const checkApiNow = async (kickRestart = false) => {
    if (kickRestart) {
      try {
        await window.toolbox?.restartApi?.();
      } catch {
        /* ignore */
      }
    }
    try {
      const v = await api.version();
      const rev = v.api_rev ?? 0;
      autoKickApiRef.current = false;
      setApiOk(true);
      setApiStale(rev < REQUIRED_API_REV);
      setVersion(v.version || "dev");
      setBuildTag(v.build_tag || "");
      setApiRev(rev);
      setDataDir(v.data_dir || "");
      setInstallDir(v.install_dir || "");
    } catch {
      setApiOk(false);
      setApiStale(false);
      setVersion("offline");
      setApiRev(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const tick = async () => {
      try {
        // 一次请求拿到版本与 api_rev，避免双轮询
        const v = await api.version();
        const rev = v.api_rev ?? 0;
        if (cancelled) return;
        autoKickApiRef.current = false;
        setApiOk((prev) => (prev === true ? prev : true));
        setApiStale((prev) => {
          const next = rev < REQUIRED_API_REV;
          return prev === next ? prev : next;
        });
        setVersion((prev) => {
          const next = v.version || "dev";
          return prev === next ? prev : next;
        });
        setBuildTag((prev) => {
          const next = v.build_tag || "";
          return prev === next ? prev : next;
        });
        setApiRev((prev) => (prev === rev ? prev : rev));
        setDataDir((prev) => {
          const next = v.data_dir || "";
          return prev === next ? prev : next;
        });
        setInstallDir((prev) => {
          const next = v.install_dir || "";
          return prev === next ? prev : next;
        });
        timer = window.setTimeout(tick, 15000);
      } catch {
        if (cancelled) return;
        setApiOk((prev) => (prev === false ? prev : false));
        setApiStale((prev) => (prev ? false : prev));
        setVersion((prev) => (prev === "offline" ? prev : "offline"));
        setApiRev(null);
        if (!autoKickApiRef.current) {
          autoKickApiRef.current = true;
          void window.toolbox?.restartApi?.();
        }
        timer = window.setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const unsubClose = window.toolbox?.onClosePrompt?.(() => {
      setRememberClose(false);
      setClosePrompt(true);
    });
    const unsubApp = window.toolbox?.onAppPrompt?.((spec) => {
      setClosePrompt(false);
      setAppPrompt(spec || {});
    });
    const unsubDismiss = window.toolbox?.onAppPromptDismiss?.(() => {
      setAppPrompt(null);
    });
    return () => {
      unsubClose?.();
      unsubApp?.();
      unsubDismiss?.();
    };
  }, []);

  // 弹窗真正挂载后再 ACK，主进程才不会卡在“已 ACK 但无界面”
  useEffect(() => {
    if (!appPrompt) return;
    const t = window.setTimeout(() => {
      window.toolbox?.ackAppPrompt?.();
    }, 50);
    return () => window.clearTimeout(t);
  }, [appPrompt]);

  useEffect(() => {
    void window.toolbox?.getAppVersion?.().then((v) => {
      if (v) setAppVersion(v);
    });
    const unsub = window.toolbox?.onUpdateStatus?.((payload) => {
      const state = payload?.state || "";
      const msg = payload?.message || "";
      setUpdateState(state);
      setUpdateMsg(msg);
      setUpdateBusy(
        state === "checking" ||
          state === "downloading" ||
          state === "busy" ||
          state === "installing",
      );
    });
    return () => {
      unsub?.();
    };
  }, []);

  async function onCheckUpdate() {
    setUpdateBusy(true);
    setUpdateState("checking");
    setUpdateMsg("正在检查更新…");
    try {
      const r = await window.toolbox?.checkForUpdates?.();
      if (r?.message) setUpdateMsg(r.message);
      if (r?.state) setUpdateState(r.state);
      const st = r?.state || "";
      if (
        st === "error" ||
        st === "none" ||
        st === "idle" ||
        st === "ready" ||
        st === "deferred" ||
        r?.ok === false
      ) {
        setUpdateBusy(false);
      }
    } catch (e) {
      setUpdateState("error");
      setUpdateMsg(String((e as Error)?.message || e || "检查失败"));
      setUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (!closePrompt && !appPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (appPrompt) replyAppPrompt("cancel");
      else replyClose("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePrompt, appPrompt]);

  function replyClose(action: CloseAction) {
    setClosePrompt(false);
    if (rememberClose && (action === "tray" || action === "quit")) {
      try {
        patchAppPrefs({ closeAction: action });
      } catch {
        /* ignore */
      }
    }
    setRememberClose(false);
    window.toolbox?.replyClosePrompt?.(action);
  }

  function replyAppPrompt(action: "primary" | "secondary" | "cancel") {
    setAppPrompt(null);
    window.toolbox?.replyAppPrompt?.(action);
  }

  function onSelectTheme(id: ThemeId) {
    setTheme(id);
    applyTheme(id);
  }

  const apiStatusText =
    apiOk === null
      ? "检测中…"
      : apiOk
        ? apiStale
          ? "版本过旧"
          : "已连接"
        : "未连接";

  return (
    <div className="app-shell">
      <TitleBar />
      <div
        ref={appRef}
        className={`app${navCollapsed ? " is-nav-collapsed" : ""}${navDragging ? " is-nav-dragging" : ""}`}
        style={{
          gridTemplateColumns: `${navCollapsed ? NAV_RAIL : navWidth}px minmax(0, 1fr)`,
        }}
      >
      <aside className="nav">
        <button
          type="button"
          className="nav-collapse"
          aria-expanded={!navCollapsed}
          aria-label={navCollapsed ? "展开侧栏" : "收起侧栏"}
          title={navCollapsed ? "展开侧栏" : "收起侧栏"}
          onClick={() => patchAppPrefs({ navCollapsed: !navCollapsed })}
        >
          <svg
            className="nav-collapse-chevron"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="nav-group">
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item) => {
              const busy = activityByNav.get(item.key) || [];
              const tip = busy.length
                ? `进行中 · ${busy.map((a) => a.label).join("；")}`
                : undefined;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nav-item${nav === item.key ? " active" : ""}${
                    busy.length ? " has-activity" : ""
                  }`}
                  title={tip ? `${item.label} · ${tip}` : item.label}
                  onClick={() => setNav(item.key)}
                >
                  <span className="nav-item-main">
                    <span className="nav-item-ico">
                      <NavGlyph name={item.key} />
                    </span>
                    <span className="nav-item-label">{item.label}</span>
                  </span>
                  {busy.length ? (
                    <span className="nav-item-badge" aria-label={tip}>
                      {busy.length > 1 ? (
                        <span className="nav-item-count">{busy.length}</span>
                      ) : null}
                      <span className="nav-item-dot" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
        <div className="nav-footer">
          <button
            type="button"
            className={`nav-item nav-about-btn${aboutOpen ? " active" : ""}${
              updateState === "ready" ? " has-activity" : ""
            }`}
            title="关于 / 设置"
            onClick={() => setAboutOpen(true)}
          >
            <span className="nav-item-main">
              <span className="nav-item-ico">
                <NavGlyph name="about" />
              </span>
              <span className="nav-item-label">关于 / 设置</span>
            </span>
            {updateState === "ready" ? (
              <span className="nav-item-badge" aria-label="有可用更新">
                <span className="nav-item-dot" />
              </span>
            ) : null}
          </button>
        </div>
        <div
          className="nav-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={NAV_RAIL}
          aria-valuemax={NAV_MAX}
          aria-valuenow={navCollapsed ? NAV_RAIL : navWidth}
          aria-label="拖动调整侧栏宽度"
          title="拖动调整宽度，双击收起或展开"
          tabIndex={0}
          onPointerDown={onNavSplitterDown}
          onPointerMove={onNavSplitterMove}
          onPointerUp={onNavSplitterUp}
          onPointerCancel={onNavSplitterUp}
          onDoubleClick={() => patchAppPrefs({ navCollapsed: !navCollapsed })}
          onKeyDown={onNavSplitterKey}
        />
      </aside>
      <main className="main">
        {apiOk === null ? (
          <StatusBanner tone="info">
            本机服务启动中，界面可先操作；连接就绪后自动恢复…
          </StatusBanner>
        ) : null}
        {apiOk === false ? (
          <StatusBanner tone="error">
            <span>本机服务未连接，正在尝试自动重连…</span>
            <button
              type="button"
              className="btn sm"
              style={{ marginLeft: 10 }}
              onClick={() => void checkApiNow(true)}
            >
              重连服务
            </button>
          </StatusBanner>
        ) : null}
        {apiStale ? (
          <div className="panel">
            <div className="local-page">
              <EmptyState
                title="本机 API 版本过旧"
                description="请关闭旧进程后重开开发模式或新版 exe。"
              />
            </div>
          </div>
        ) : (
          <>
            {/* 保活：切换导航不卸载，避免设备会话/串口连接丢失 */}
            <div className={nav === "devices" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="设备页出错了">
                <DevicePage pageActive={nav === "devices"} />
              </ErrorBoundary>
            </div>
            <div className={nav === "emmc" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="eMMC 页出错了">
                <EmmcPage pageActive={nav === "emmc"} />
              </ErrorBoundary>
            </div>
            <div className={nav === "monkey" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="Monkey 页出错了">
                <MonkeyPage pageActive={nav === "monkey"} />
              </ErrorBoundary>
            </div>
            <div className={nav === "serial" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="串口页出错了">
                <SerialPage pageActive={nav === "serial"} />
              </ErrorBoundary>
            </div>
            <div className={nav === "md5" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="MD5 页出错了">
                <Md5Page />
              </ErrorBoundary>
            </div>
            <div className={nav === "barcode" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="条码页出错了">
                <BarcodePage />
              </ErrorBoundary>
            </div>
            <div className={nav === "base64" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="Base64 页出错了">
                <Base64Page />
              </ErrorBoundary>
            </div>
            <div className={nav === "gota" ? "page-keep" : "page-keep hidden"}>
              <ErrorBoundary title="GOTA 页出错了">
                <GotaPage />
              </ErrorBoundary>
            </div>
          </>
        )}
      </main>

      <AboutModal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        theme={theme}
        onThemeChange={onSelectTheme}
        appVersion={appVersion}
        apiVersion={version}
        buildTag={buildTag}
        apiRev={apiRev}
        apiStatusText={apiStatusText}
        dataDir={dataDir}
        installDir={installDir}
        updateMsg={updateMsg}
        updateState={updateState}
        updateBusy={updateBusy}
        onCheckUpdate={() => void onCheckUpdate()}
      />

      <Modal
        open={closePrompt}
        bare
        size="sm"
        zClass="modal-top"
        labelledBy="app-prompt-title-close"
        onClose={() => replyClose("cancel")}
      >
        <div className="app-prompt-mark mark-close" aria-hidden>
          <span />
        </div>
        <div className="app-prompt-copy">
          <h2 id="app-prompt-title-close">关闭窗口</h2>
          <p>可缩到系统托盘后台运行，需要时再打开；也可直接退出程序。</p>
        </div>
        <ul className="app-prompt-tips">
          <li>双击右下角托盘图标可重新打开</li>
          <li>托盘右键「退出」可彻底结束</li>
        </ul>
        <label className="app-prompt-remember">
          <input
            type="checkbox"
            checked={rememberClose}
            onChange={(e) => setRememberClose(e.target.checked)}
          />
          <span>记住本次选择，下次不再询问</span>
        </label>
        <div className="app-prompt-actions">
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => replyClose("tray")}
          >
            后台运行
          </button>
          <button
            type="button"
            className="btn danger-ghost"
            onClick={() => replyClose("quit")}
          >
            退出程序
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => replyClose("cancel")}
          >
            取消
          </button>
        </div>
      </Modal>

      <Modal
        open={!!appPrompt}
        bare
        size="sm"
        zClass="modal-top"
        labelledBy="app-prompt-title"
        dismissOnBackdrop={false}
        onClose={() => replyAppPrompt("secondary")}
      >
        <div
          className={`app-prompt-mark mark-${appPrompt?.mark || "info"}`}
          aria-hidden
        >
          <span />
        </div>
        <div className="app-prompt-copy">
          <h2 id="app-prompt-title">{appPrompt?.title || "提示"}</h2>
          {appPrompt?.body ? <p>{appPrompt.body}</p> : null}
        </div>
        {appPrompt?.tips?.length ? (
          <ul className="app-prompt-tips">
            {appPrompt.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
        <div className="app-prompt-actions actions-2">
          <button
            type="button"
            className="btn primary"
            autoFocus
            onClick={() => replyAppPrompt("primary")}
          >
            {appPrompt?.primary || "确定"}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => replyAppPrompt("secondary")}
          >
            {appPrompt?.secondary || "取消"}
          </button>
        </div>
      </Modal>
      </div>
    </div>
  );
}
