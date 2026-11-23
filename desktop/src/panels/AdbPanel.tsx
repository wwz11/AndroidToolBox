import { useState } from "react";
import { useStatusNotify } from "../components/toast";
import { useStickyLogScroll } from "../hooks/useStickyLogScroll";
import { Button } from "../ui";
import ErrorBoundary from "../components/ErrorBoundary";
import FilesPanel from "./FilesPanel";
import AppsPanel from "./adb/AppsPanel";
import InfoPanel from "./adb/InfoPanel";
import LogcatPanel from "./adb/LogcatPanel";
import ShellPane from "./adb/ShellPane";

export type AdbTab =
  | "info"
  | "shell"
  | "apps"
  | "logcat"
  | "files";

type Props = {
  deviceSn: string;
  browseOnly?: boolean;
  active?: boolean;
  /** 设备当前是否在 adb devices 列表中；断开后为 false */
  deviceOnline?: boolean;
  /** 由设备页顶栏控制，与遥控/eMMC 等同级 */
  tab: AdbTab;
};

export default function AdbPanel({
  deviceSn,
  browseOnly,
  active = true,
  deviceOnline = true,
  tab,
}: Props) {
  const [log, setLog] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const notifyStatus = useStatusNotify();

  const snOk = Boolean(deviceSn) && !browseOnly && deviceOnline;
  const outputScroll = useStickyLogScroll(log);
  const showSharedLog = tab !== "shell" && tab !== "logcat" && tab !== "info";

  function append(line: string) {
    setLog((prev) => {
      const next = prev ? `${prev}\n${line}` : line;
      return next.length > 60000 ? next.slice(-48000) : next;
    });
  }

  return (
    <div className={`tool-panel${tab === "shell" ? " tool-panel-flush" : ""}`}>
      <div
        className={tab === "info" ? "adb-tab-pane" : "adb-tab-pane hidden"}
        aria-hidden={tab !== "info"}
      >
        <ErrorBoundary title="信息页出错了">
          <InfoPanel
            deviceSn={deviceSn}
            snOk={snOk}
            active={active && tab === "info"}
            onStatus={notifyStatus}
          />
        </ErrorBoundary>
      </div>

      <div
        className={tab === "shell" ? "adb-tab-pane" : "adb-tab-pane hidden"}
        aria-hidden={tab !== "shell"}
      >
        <ErrorBoundary title="Shell 出错了">
          <ShellPane
            deviceSn={deviceSn}
            snOk={snOk}
            active={active && tab === "shell"}
            onStatus={notifyStatus}
          />
        </ErrorBoundary>
      </div>

      <div
        className={tab === "apps" ? "adb-tab-pane" : "adb-tab-pane hidden"}
        aria-hidden={tab !== "apps"}
      >
        <ErrorBoundary title="应用页出错了">
          <AppsPanel
            deviceSn={deviceSn}
            snOk={snOk}
            active={active && tab === "apps"}
            onAppend={append}
            onStatus={notifyStatus}
          />
        </ErrorBoundary>
      </div>

      <div
        className={tab === "logcat" ? "adb-tab-pane" : "adb-tab-pane hidden"}
        aria-hidden={tab !== "logcat"}
      >
        <ErrorBoundary title="Logcat 出错了">
          <LogcatPanel
            deviceSn={deviceSn}
            snOk={snOk}
            active={active && tab === "logcat"}
            onAppend={append}
            onStatus={notifyStatus}
          />
        </ErrorBoundary>
      </div>

      <div
        className={tab === "files" ? "adb-tab-pane" : "adb-tab-pane hidden"}
        aria-hidden={tab !== "files"}
      >
        <ErrorBoundary title="文件页出错了">
          <FilesPanel
            deviceSn={deviceSn}
            browseOnly={browseOnly || !deviceOnline}
            active={active && tab === "files"}
            append={append}
            setStatus={(s) => notifyStatus(s)}
          />
        </ErrorBoundary>
      </div>

      {showSharedLog ? (
        <div
          className={`apps-log-wrap${logOpen ? "" : " collapsed"}${
            logOpen && (tab === "apps" || tab === "files") ? " compact" : ""
          }`}
        >
          <div className="apps-log-toggle">
            <Button variant="ghost" onClick={() => setLogOpen((v) => !v)}>
              {logOpen ? "收起日志" : log ? "日志 · 有内容" : "日志"}
            </Button>
            {logOpen ? (
              <Button variant="ghost" onClick={() => setLog("")}>
                清空
              </Button>
            ) : null}
          </div>
          {logOpen ? (
            <pre
              className="log"
              ref={outputScroll.ref}
              onScroll={outputScroll.onScroll}
            >
              {log || "操作输出显示在这里…"}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
