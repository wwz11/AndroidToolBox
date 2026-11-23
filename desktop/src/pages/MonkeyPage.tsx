import { api } from "../api/client";
import DevicePickSelect from "../components/DevicePickSelect";
import DeviceSessionChips from "../components/DeviceSessionChips";
import { useDeviceRoster } from "../hooks/useDeviceRoster";
import { useDeviceSessions } from "../hooks/useDeviceSessions";
import { useKeyedFlag } from "../hooks/useKeyedFlag";
import MonkeyPanel from "../panels/MonkeyPanel";
import { Button, EmptyState, StatusBanner, Toolbar } from "../ui";

type Props = {
  pageActive?: boolean;
};

/** Monkey 多设备：顶部 chips + 保活会话栈（与设备页一致）。 */
export default function MonkeyPage({ pageActive = true }: Props) {
  const roster = useDeviceRoster(pageActive);
  const [runningBySn, markRunning] = useKeyedFlag();
  const sessions = useDeviceSessions({
    idPrefix: "monkey",
    setError: roster.setError,
    clearErrorOnOpen: true,
    runningBySn,
    closeBlockedMessage: "Monkey 进行中，请先停止再关闭设备窗口",
  });

  const active = sessions.active;
  const activeOffline = Boolean(
    active && !active.placeholder && !roster.onlineSet.has(active.sn),
  );
  const activeRunning = Boolean(active && runningBySn[active.sn]);

  return (
    <div className="panel device-page">
      <Toolbar
        className="device-toolbar"
        start={
          <>
            <span className="label">ADB 设备</span>
            <DevicePickSelect
              selected={roster.selected}
              options={roster.deviceOptions}
              pendingRows={roster.pendingRows}
              emptyText={
                roster.pendingRows.length ? "有设备未就绪" : "（无在线设备）"
              }
              onBeginPick={roster.beginPick}
              onEndPick={roster.endPick}
              onChange={roster.choose}
            />
            <Button disabled={roster.busy} onClick={() => void roster.refresh()}>
              刷新
            </Button>
            <Button
              variant="primary"
              disabled={roster.busy || !roster.devices.includes(roster.selected)}
              onClick={() => sessions.openSession(roster.selected)}
            >
              打开
            </Button>
            <Button
              disabled={roster.busy || !roster.devices.length}
              onClick={() => sessions.openAll(roster.devices)}
            >
              全部打开
            </Button>
          </>
        }
      />

      {roster.error ? <StatusBanner tone="error">{roster.error}</StatusBanner> : null}

      <DeviceSessionChips
        sessions={sessions.sessions}
        activeId={sessions.activeId}
        onlineSet={roster.onlineSet}
        busyBySn={runningBySn}
        busyTitle="Monkey 进行中，请先停止再关闭"
        onActivate={(session) => {
          sessions.activate(session.id);
          if (!session.placeholder) void api.setSelected(session.sn);
        }}
        onClose={sessions.closeSession}
      />

      <div
        className={`session-body${
          activeOffline && !activeRunning ? " is-offline" : ""
        }`}
      >
        {activeOffline && !activeRunning ? (
          <div className="session-offline-overlay" role="alert">
            <EmptyState
              title="设备已断开"
              description={`${active?.sn || ""} 已不在线，无法继续操作。重新连接后会自动恢复。`}
              action={
                <Button
                  variant="primary"
                  onClick={() => {
                    if (active?.id) sessions.closeSession(active.id);
                  }}
                >
                  关闭窗口
                </Button>
              }
            />
          </div>
        ) : null}
        {active?.placeholder ? (
          <div className="session-empty">
            <EmptyState
              title={
                roster.devices.length ? "尚未打开 Monkey 会话" : "未检测到在线设备"
              }
              description={
                roster.devices.length
                  ? "选择设备后点击「打开」配置并启动 Monkey。"
                  : roster.pendingRows.length
                    ? "设备已列出但未授权或离线，请在电视上允许 USB 调试后再刷新。"
                    : "请确认设备已连接，点击「刷新」。"
              }
              action={
                roster.devices.length ? (
                  <Button
                    variant="primary"
                    disabled={
                      roster.busy || !roster.devices.includes(roster.selected)
                    }
                    onClick={() => sessions.openSession(roster.selected)}
                  >
                    打开所选设备
                  </Button>
                ) : (
                  <Button disabled={roster.busy} onClick={() => void roster.refresh()}>
                    刷新设备
                  </Button>
                )
              }
            />
          </div>
        ) : null}
        {active?.placeholder ? null : (
          <div className="session-stack">
            {sessions.sessions
              .filter((s) => !s.placeholder)
              .map((s) => (
                <div
                  key={s.id}
                  className={
                    s.id === sessions.activeId
                      ? "session-stack-item"
                      : "session-stack-item hidden"
                  }
                >
                  <MonkeyPanel
                    deviceSn={s.sn}
                    deviceOnline={roster.onlineSet.has(s.sn)}
                    active={pageActive && s.id === sessions.activeId}
                    onRunningChange={(running) => markRunning(s.sn, running)}
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
