import { useEffect, useState } from "react";
import {
  DEFAULT_APP_PREFS,
  type AppPrefs,
  type CloseActionPref,
  patchAppPrefs,
  readAppPrefs,
} from "../../appPrefs";
import { Button } from "../../ui";

async function pickDir(title: string, current: string): Promise<string> {
  try {
    const dir = await window.toolbox?.chooseDirectory?.({
      title,
      defaultPath: current || undefined,
    });
    return typeof dir === "string" ? dir.trim() : "";
  } catch {
    return "";
  }
}

function FieldLabel({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="app-settings-label">
      <strong>{title}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}

function ToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="app-settings-toggle">
      <div className="app-settings-toggle-copy">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <span className={`app-switch${checked ? " is-on" : ""}`} aria-hidden>
        <span className="app-switch-knob" />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="app-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`app-seg-btn${value === o.id ? " is-on" : ""}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const BROWSE_CHIPS = ["/sdcard", "/sdcard/Download", "/data/local/tmp", "/"];

type SubId = "window" | "dirs" | "device" | "serial" | "advanced";

const SUBS: { id: SubId; label: string }[] = [
  { id: "window", label: "窗口" },
  { id: "dirs", label: "目录" },
  { id: "device", label: "设备" },
  { id: "serial", label: "串口" },
  { id: "advanced", label: "高级" },
];

/** 关于弹窗内的全局设置 */
export default function AppSettingsPanel() {
  const [prefs, setPrefs] = useState<AppPrefs>(() => readAppPrefs());
  const [defaults, setDefaults] = useState({ pull: "", gota: "", update: "" });
  const [savedHint, setSavedHint] = useState("");
  const [sub, setSub] = useState<SubId>("window");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pull, gota, electron] = await Promise.all([
          window.toolbox?.defaultPullDir?.() || "",
          window.toolbox?.defaultGotaDir?.() || "",
          window.toolbox?.getAppSettings?.() || null,
        ]);
        if (cancelled) return;
        setDefaults({
          pull: typeof pull === "string" ? pull : "",
          gota: typeof gota === "string" ? gota : "",
          update: String(
            (electron as { updateUrl?: string } | null)?.updateUrl || "",
          ),
        });
        if (electron && typeof electron === "object") {
          setPrefs((prev) => ({
            ...prev,
            closeAction: (electron as AppPrefs).closeAction || prev.closeAction,
            minimizeToTray: Boolean(
              (electron as AppPrefs).minimizeToTray ?? prev.minimizeToTray,
            ),
            alwaysOnTop: Boolean(
              (electron as AppPrefs).alwaysOnTop ?? prev.alwaysOnTop,
            ),
            rememberWindowBounds: Boolean(
              (electron as AppPrefs).rememberWindowBounds ??
                prev.rememberWindowBounds,
            ),
            apiUrl: String((electron as AppPrefs).apiUrl || prev.apiUrl),
            updateUrl: String(
              (electron as AppPrefs).updateUrl || prev.updateUrl,
            ),
          }));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(patch: Partial<AppPrefs>, hint = "已保存") {
    const next = patchAppPrefs(patch);
    setPrefs(next);
    setSavedHint(hint);
    window.setTimeout(() => setSavedHint(""), 1600);
  }

  return (
    <div className="app-settings">
      <div className="app-settings-head">
        <div>
          <strong>应用设置</strong>
          <p>多数项立即生效；API / 更新源需重启</p>
        </div>
        <span className={`app-settings-saved${savedHint ? " is-on" : ""}`}>
          {savedHint || " "}
        </span>
      </div>

      <div className="app-settings-subs" role="tablist" aria-label="设置分组">
        {SUBS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={sub === s.id}
            className={`app-settings-sub${sub === s.id ? " is-active" : ""}`}
            onClick={() => setSub(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {sub === "window" ? (
        <section className="app-settings-section">
          <div className="app-settings-card">
            <div className="app-settings-field">
              <FieldLabel title="关闭窗口" hint="点标题栏关闭时的默认行为" />
              <Segmented<CloseActionPref>
                ariaLabel="关闭窗口行为"
                value={prefs.closeAction}
                onChange={(v) => apply({ closeAction: v })}
                options={[
                  { id: "ask", label: "每次询问" },
                  { id: "tray", label: "后台运行" },
                  { id: "quit", label: "直接退出" },
                ]}
              />
            </div>
            <div className="app-settings-toggles">
              <ToggleRow
                title="最小化到系统托盘"
                hint="点最小化时藏到托盘"
                checked={prefs.minimizeToTray}
                onChange={(v) => apply({ minimizeToTray: v })}
              />
              <ToggleRow
                title="启动时钉在顶部"
                hint="与标题栏置顶按钮同步"
                checked={prefs.alwaysOnTop}
                onChange={(v) => apply({ alwaysOnTop: v })}
              />
              <ToggleRow
                title="记住窗口大小与位置"
                hint="下次启动恢复当前尺寸"
                checked={prefs.rememberWindowBounds}
                onChange={(v) => apply({ rememberWindowBounds: v })}
              />
            </div>
          </div>
        </section>
      ) : null}

      {sub === "dirs" ? (
        <section className="app-settings-section">
          <div className="app-settings-card">
            <label className="app-settings-field">
              <FieldLabel
                title="文件默认浏览路径"
                hint="打开文件管理时的起始目录"
              />
              <div className="app-settings-chips">
                {BROWSE_CHIPS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`app-chip${
                      prefs.filesBrowsePath === p ||
                      (p !== "/" &&
                        prefs.filesBrowsePath.replace(/\/+$/, "") === p)
                        ? " is-on"
                        : ""
                    }`}
                    onClick={() => apply({ filesBrowsePath: p })}
                  >
                    {p === "/" ? "根目录 /" : p}
                  </button>
                ))}
              </div>
              <input
                className="field"
                value={prefs.filesBrowsePath}
                placeholder="/sdcard"
                onChange={(e) =>
                  setPrefs({ ...prefs, filesBrowsePath: e.target.value })
                }
                onBlur={() => apply({ filesBrowsePath: prefs.filesBrowsePath })}
              />
            </label>
            <label className="app-settings-field">
              <FieldLabel
                title="ADB 拉取默认目录"
                hint={defaults.pull ? `系统默认：${defaults.pull}` : undefined}
              />
              <div className="app-settings-path">
                <input
                  className="field grow"
                  value={prefs.pullDir}
                  placeholder={defaults.pull || "使用系统默认"}
                  onChange={(e) =>
                    setPrefs({ ...prefs, pullDir: e.target.value })
                  }
                  onBlur={() => apply({ pullDir: prefs.pullDir })}
                />
                <Button
                  onClick={() =>
                    void pickDir(
                      "选择 ADB 拉取目录",
                      prefs.pullDir || defaults.pull,
                    ).then((d) => {
                      if (d) apply({ pullDir: d });
                    })
                  }
                >
                  浏览
                </Button>
              </div>
            </label>
            <label className="app-settings-field">
              <FieldLabel
                title="GOTA 输出默认目录"
                hint={defaults.gota ? `系统默认：${defaults.gota}` : undefined}
              />
              <div className="app-settings-path">
                <input
                  className="field grow"
                  value={prefs.gotaOutDir}
                  placeholder={defaults.gota || "使用系统默认"}
                  onChange={(e) =>
                    setPrefs({ ...prefs, gotaOutDir: e.target.value })
                  }
                  onBlur={() => apply({ gotaOutDir: prefs.gotaOutDir })}
                />
                <Button
                  onClick={() =>
                    void pickDir(
                      "选择 GOTA 输出目录",
                      prefs.gotaOutDir || defaults.gota,
                    ).then((d) => {
                      if (d) apply({ gotaOutDir: d });
                    })
                  }
                >
                  浏览
                </Button>
              </div>
            </label>
          </div>
        </section>
      ) : null}

      {sub === "device" ? (
        <section className="app-settings-section">
          <div className="app-settings-card">
            <div className="app-settings-toggles">
              <ToggleRow
                title="Logcat 默认自动保存"
                hint="新开抓取时默认写入文件"
                checked={prefs.logcatAutoSave}
                onChange={(v) => apply({ logcatAutoSave: v })}
              />
            </div>
            <label className="app-settings-field">
              <FieldLabel
                title="Logcat 预览最大行数"
                hint="过大可能影响流畅度"
              />
              <div className="app-settings-inline">
                <input
                  type="range"
                  min={500}
                  max={10000}
                  step={100}
                  value={prefs.logcatMaxLines}
                  onChange={(e) =>
                    apply({ logcatMaxLines: Number(e.target.value) })
                  }
                />
                <strong className="app-settings-value">
                  {prefs.logcatMaxLines}
                </strong>
              </div>
            </label>
            <div className="app-settings-divider" />
            <div className="app-settings-grid">
              <label className="app-settings-field">
                <FieldLabel title="设备列表刷新" hint="间隔越短越灵敏" />
                <div className="app-settings-inline">
                  <input
                    type="range"
                    min={1000}
                    max={15000}
                    step={500}
                    value={prefs.devicePollMs}
                    onChange={(e) =>
                      apply({ devicePollMs: Number(e.target.value) })
                    }
                  />
                  <strong className="app-settings-value">
                    {(prefs.devicePollMs / 1000).toFixed(1)}s
                  </strong>
                </div>
              </label>
              <label className="app-settings-field">
                <FieldLabel title="投屏最大边长" hint="内嵌 scrcpy" />
                <div className="app-settings-inline">
                  <input
                    type="range"
                    min={480}
                    max={1920}
                    step={80}
                    value={prefs.scrcpyMaxSide}
                    onChange={(e) =>
                      apply({ scrcpyMaxSide: Number(e.target.value) })
                    }
                  />
                  <strong className="app-settings-value">
                    {prefs.scrcpyMaxSide}
                  </strong>
                </div>
              </label>
              <label className="app-settings-field">
                <FieldLabel title="截图预览边长" hint="非内嵌投屏" />
                <div className="app-settings-inline">
                  <input
                    type="range"
                    min={320}
                    max={1440}
                    step={80}
                    value={prefs.remotePreviewMaxSide}
                    onChange={(e) =>
                      apply({ remotePreviewMaxSide: Number(e.target.value) })
                    }
                  />
                  <strong className="app-settings-value">
                    {prefs.remotePreviewMaxSide}
                  </strong>
                </div>
              </label>
              <label className="app-settings-field">
                <FieldLabel title="截图刷新间隔" hint="毫秒" />
                <div className="app-settings-inline">
                  <input
                    type="range"
                    min={300}
                    max={3000}
                    step={100}
                    value={prefs.remotePreviewPollMs}
                    onChange={(e) =>
                      apply({ remotePreviewPollMs: Number(e.target.value) })
                    }
                  />
                  <strong className="app-settings-value">
                    {prefs.remotePreviewPollMs}ms
                  </strong>
                </div>
              </label>
            </div>
            <label className="app-settings-field">
              <FieldLabel
                title="录屏断线重连等待"
                hint="设备掉线后继续等待重连"
              />
              <div className="app-settings-inline">
                <input
                  type="range"
                  min={60}
                  max={1800}
                  step={30}
                  value={prefs.scrcpyReconnectSec}
                  onChange={(e) =>
                    apply({ scrcpyReconnectSec: Number(e.target.value) })
                  }
                />
                <strong className="app-settings-value">
                  {(prefs.scrcpyReconnectSec / 60).toFixed(
                    prefs.scrcpyReconnectSec % 60 === 0 ? 0 : 1,
                  )}
                  分
                </strong>
              </div>
            </label>
            <label className="app-settings-field">
              <FieldLabel title="记住的网络 ADB" hint="仅 IP 时默认端口 5555" />
              <input
                className="field"
                value={prefs.netAdbLast}
                placeholder="192.168.1.10 或 host:5555"
                onChange={(e) =>
                  setPrefs({ ...prefs, netAdbLast: e.target.value })
                }
                onBlur={() => apply({ netAdbLast: prefs.netAdbLast })}
              />
            </label>
          </div>
        </section>
      ) : null}

      {sub === "serial" ? (
        <section className="app-settings-section">
          <div className="app-settings-card">
            <div className="app-settings-grid">
              <label className="app-settings-field">
                <FieldLabel title="串口默认波特率" />
                <select
                  className="field"
                  value={prefs.serialBaudDefault}
                  onChange={(e) =>
                    apply({ serialBaudDefault: Number(e.target.value) })
                  }
                >
                  {[9600, 57600, 115200, 230400, 460800, 921600].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="app-settings-field">
                <FieldLabel title="终端回滚行数" hint="Shell / 串口共用" />
                <div className="app-settings-inline">
                  <input
                    type="range"
                    min={2000}
                    max={50000}
                    step={1000}
                    value={prefs.shellScrollback}
                    onChange={(e) =>
                      apply({ shellScrollback: Number(e.target.value) })
                    }
                  />
                  <strong className="app-settings-value">
                    {prefs.shellScrollback}
                  </strong>
                </div>
              </label>
            </div>
            <div className="app-settings-toggles">
              <ToggleRow
                title="ADB Shell 默认写日志"
                checked={prefs.shellAutoLogDefault}
                onChange={(v) => apply({ shellAutoLogDefault: v })}
              />
              <ToggleRow
                title="串口默认写日志"
                checked={prefs.serialAutoLogDefault}
                onChange={(v) => apply({ serialAutoLogDefault: v })}
              />
            </div>
          </div>
        </section>
      ) : null}

      {sub === "advanced" ? (
        <section className="app-settings-section">
          <div className="app-settings-card">
            <label className="app-settings-field">
              <FieldLabel title="界面语言" hint="暂仅中文" />
              <select className="field" value="zh-CN" disabled>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
            <label className="app-settings-field">
              <FieldLabel
                title="本机 API 地址"
                hint="留空用默认 127.0.0.1:17831；修改后需重启"
              />
              <input
                className="field"
                value={prefs.apiUrl}
                placeholder="http://127.0.0.1:17831"
                onChange={(e) => setPrefs({ ...prefs, apiUrl: e.target.value })}
                onBlur={() =>
                  apply({ apiUrl: prefs.apiUrl }, "已保存，重启后生效")
                }
              />
            </label>
            <label className="app-settings-field">
              <FieldLabel
                title="更新源"
                hint="NAS UNC 或 http(s)；留空用内置默认"
              />
              <input
                className="field"
                value={prefs.updateUrl}
                placeholder={defaults.update || "\\\\nas\\... 或 https://..."}
                onChange={(e) =>
                  setPrefs({ ...prefs, updateUrl: e.target.value })
                }
                onBlur={() => apply({ updateUrl: prefs.updateUrl })}
              />
            </label>
          </div>
        </section>
      ) : null}

      <div className="app-settings-actions">
        <Button
          variant="ghost"
          onClick={() => {
            const next = patchAppPrefs({ ...DEFAULT_APP_PREFS });
            setPrefs(next);
            setSavedHint("已恢复默认");
            window.setTimeout(() => setSavedHint(""), 1600);
          }}
        >
          恢复默认设置
        </Button>
      </div>
    </div>
  );
}
