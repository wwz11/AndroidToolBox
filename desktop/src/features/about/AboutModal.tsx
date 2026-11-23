import { useState } from "react";
import { REQUIRED_API_REV, api } from "../../api/client";
import Modal from "../../components/Modal";
import { Button } from "../../ui";
import type { ThemeId } from "../../theme";
import ShellPrefsPicker from "./ShellPrefsPicker";
import ThemePicker from "./ThemePicker";
import AppSettingsPanel from "./AppSettingsPanel";

type Props = {
  open: boolean;
  onClose: () => void;
  theme: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  appVersion: string;
  apiVersion: string;
  buildTag: string;
  apiRev: number | null;
  apiStatusText: string;
  dataDir: string;
  installDir: string;
  updateMsg: string;
  updateState: string;
  updateBusy: boolean;
  onCheckUpdate: () => void;
};

type TabId = "appearance" | "terminal" | "app" | "about";

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "terminal", label: "终端" },
  { id: "app", label: "应用" },
  { id: "about", label: "关于" },
];

export default function AboutModal({
  open,
  onClose,
  theme,
  onThemeChange,
  appVersion,
  apiVersion,
  buildTag,
  apiRev,
  apiStatusText,
  dataDir,
  installDir,
  updateMsg,
  updateState,
  updateBusy,
  onCheckUpdate,
}: Props) {
  const [tab, setTab] = useState<TabId>("appearance");

  async function openPath(path: string) {
    if (!path) return;
    try {
      await api.openPath(path);
    } catch {
      /* ignore */
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      className="about-modal"
      title="关于 / 设置"
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          {window.toolbox?.checkForUpdates ? (
            <Button
              variant="primary"
              loading={updateBusy}
              onClick={() => void onCheckUpdate()}
            >
              {updateState === "ready" ? "重启安装更新" : "检查更新"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="about-body">
        <div className="about-tabs" role="tablist" aria-label="设置分类">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`about-tab${tab === t.id ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="about-tab-panel" role="tabpanel">
          {tab === "appearance" ? (
            <ThemePicker value={theme} onChange={onThemeChange} />
          ) : null}

          {tab === "terminal" ? <ShellPrefsPicker /> : null}

          {tab === "app" ? <AppSettingsPanel /> : null}

          {tab === "about" ? (
            <div className="about-info">
              <div className="about-hero">
                <div className="brand-mark" aria-hidden>
                  SEI
                </div>
                <div>
                  <strong>SEIAndroidTVTestToolBox</strong>
                  <p>Android TV 测试工具箱</p>
                </div>
              </div>

              <dl className="about-grid">
                <div>
                  <dt>应用版本</dt>
                  <dd>{appVersion || "—"}</dd>
                </div>
                <div>
                  <dt>API 版本</dt>
                  <dd>
                    {apiVersion && apiVersion !== "…" ? apiVersion : "—"}
                  </dd>
                </div>
                <div>
                  <dt>构建号</dt>
                  <dd>
                    {buildTag && buildTag !== appVersion
                      ? buildTag
                      : appVersion || buildTag || "—"}
                  </dd>
                </div>
                <div>
                  <dt>API 协议</dt>
                  <dd>
                    {apiRev != null ? `rev ${apiRev}` : "—"}
                    {` / 需要 ≥ ${REQUIRED_API_REV}`}
                  </dd>
                </div>
                <div>
                  <dt>API 状态</dt>
                  <dd>{apiStatusText}</dd>
                </div>
                <div>
                  <dt>平台</dt>
                  <dd>
                    {window.toolbox?.platform || navigator.platform || "—"}
                  </dd>
                </div>
              </dl>

              {(dataDir || installDir) && (
                <div className="about-paths">
                  {installDir ? (
                    <div className="about-path-row">
                      <div>
                        <span>安装目录</span>
                        <code title={installDir}>{installDir}</code>
                      </div>
                      <Button onClick={() => void openPath(installDir)}>
                        打开
                      </Button>
                    </div>
                  ) : null}
                  {dataDir ? (
                    <div className="about-path-row">
                      <div>
                        <span>数据目录</span>
                        <code title={dataDir}>{dataDir}</code>
                      </div>
                      <Button onClick={() => void openPath(dataDir)}>
                        打开
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}

              {window.toolbox?.checkForUpdates ? (
                <div className="about-update">
                  <div className="about-update-head">
                    <strong>版本更新</strong>
                    <span
                      className={`about-update-state state-${updateState || "idle"}`}
                    >
                      {updateState === "ready"
                        ? "可安装"
                        : updateState === "downloading"
                          ? "下载中"
                          : updateState === "checking"
                            ? "检查中"
                            : updateState === "error"
                              ? "失败"
                              : updateBusy
                                ? "处理中"
                                : "就绪"}
                    </span>
                  </div>
                  {updateMsg ? (
                    <div
                      className={`about-update-msg${
                        updateState === "error"
                          ? " is-error"
                          : updateState === "ready"
                            ? " is-ready"
                            : ""
                      }`}
                    >
                      {updateMsg}
                    </div>
                  ) : (
                    <div className="about-update-msg muted">
                      点击下方「检查更新」从更新源获取新版本
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
