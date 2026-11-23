import { shortSn, type DeviceSession } from "../deviceSessions";

type Props = {
  sessions: DeviceSession[];
  activeId: string;
  onlineSet: Set<string>;
  busyBySn?: Record<string, boolean>;
  busyTitle?: string;
  rootedBySn?: Record<string, boolean>;
  rootBusyBySn?: Record<string, boolean>;
  onRoot?: (sn: string) => void;
  onActivate: (session: DeviceSession) => void;
  onClose: (id: string) => void;
};

export default function DeviceSessionChips({
  sessions,
  activeId,
  onlineSet,
  busyBySn,
  busyTitle = "进行中，请先停止再关闭",
  rootedBySn,
  rootBusyBySn,
  onRoot,
  onActivate,
  onClose,
}: Props) {
  return (
    <div className="chips">
      {sessions.map((session) => {
        const online = session.placeholder ? false : onlineSet.has(session.sn);
        const busy = !session.placeholder && Boolean(busyBySn?.[session.sn]);
        return (
          <div
            key={session.id}
            className={`chip${activeId === session.id ? " active" : ""}${
              busy ? " is-busy" : ""
            }${!session.placeholder && !online ? " is-offline" : ""}`}
            title={
              session.placeholder
                ? "未打开设备"
                : online
                  ? "切换到此设备"
                  : `${session.sn} 已断开`
            }
            role="tab"
            tabIndex={0}
            onClick={() => onActivate(session)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onActivate(session);
            }}
          >
            <span
              className={`dot ${session.placeholder ? "off" : online ? "on" : "off"}`}
            />
            <span
              className="chip-label"
              title={
                session.placeholder
                  ? undefined
                  : `${session.sn}${online ? "" : " · 已断开"}`
              }
            >
              {shortSn(session.sn)}
              {!session.placeholder && !online ? " · 已断开" : ""}
            </span>
            {!session.placeholder && onRoot ? (
              <button
                type="button"
                className={`chip-root${rootedBySn?.[session.sn] ? " is-rooted" : ""}`}
                disabled={!online || Boolean(rootBusyBySn?.[session.sn])}
                title={
                  !online
                    ? "设备已断开"
                    : rootedBySn?.[session.sn]
                      ? `已对 ${session.sn} 执行 adb root（点击可重新执行）`
                      : `对 ${session.sn} 执行 adb root（需要设备支持）`
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onRoot(session.sn);
                }}
              >
                {rootBusyBySn?.[session.sn]
                  ? "…"
                  : rootedBySn?.[session.sn]
                    ? "已Root"
                    : "Root"}
              </button>
            ) : null}
            {!session.placeholder ? (
              <button
                type="button"
                className="x"
                disabled={busy}
                title={busy ? busyTitle : "关闭"}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
