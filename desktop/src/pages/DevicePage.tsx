import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { syncSessionActivities } from "../activity";
import { patchAppPrefs, readAppPrefs, subscribeAppPrefs } from "../appPrefs";
import DevicePickSelect from "../components/DevicePickSelect";
import DeviceSessionChips from "../components/DeviceSessionChips";
import { useToast } from "../components/toast";
import { shortSn } from "../deviceSessions";
import { toErrorMessage } from "../errors";
import { useDeviceRoster } from "../hooks/useDeviceRoster";
import { useDeviceSessions } from "../hooks/useDeviceSessions";
import { useKeyedFlag } from "../hooks/useKeyedFlag";
import AdbPanel, { type AdbTab } from "../panels/AdbPanel";
import KeyCheckPage from "./KeyCheckPage";
import RemotePanel from "../panels/RemotePanel";
import { Button, EmptyState, StatusBanner } from "../ui";

const ADB_SUB_TABS: { key: AdbTab; label: string }[] = [
  { key: "info", label: "信息" },
  { key: "shell", label: "Shell" },
  { key: "apps", label: "应用" },
  { key: "logcat", label: "Log抓取" },
  { key: "files", label: "文件" },
];

const OTHER_SUB_TABS = ["遥控", "键值判断"] as const;

type SubTab =
  | (typeof ADB_SUB_TABS)[number]["label"]
  | (typeof OTHER_SUB_TABS)[number];

const ADB_TAB_BY_LABEL: Record<string, AdbTab> = Object.fromEntries(
  ADB_SUB_TABS.map((t) => [t.label, t.key]),
);

function adbTabOf(subTab: SubTab): AdbTab | null {
  return ADB_TAB_BY_LABEL[subTab] ?? null;
}

/** 与后端一致：仅 IP 时补默认端口 5555 */
function normalizeNetTarget(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith("[") && s.includes("]:")) return s;
  if (s.includes(":")) return s;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return `${s}:5555`;
  return s;
}

function isNetDeviceOnline(devices: string[], raw: string): boolean {
  const target = normalizeNetTarget(raw);
  if (!target) return false;
  return devices.some((d) => d === target);
}

type Props = {
  /** 当前是否为可见页；切回时立刻刷设备列表，避免「已连接却不显示」 */
  pageActive?: boolean;
};

export default function DevicePage({ pageActive = true }: Props) {
  const toast = useToast();
  const roster = useDeviceRoster(pageActive);
  const sessions = useDeviceSessions({
    idPrefix: "s",
    setError: roster.setError,
  });
  const [recordHoldBySn, markRecordHold] = useKeyedFlag();
  const [netTarget, setNetTarget] = useState(() => readAppPrefs().netAdbLast);
  const [subTab, setSubTab] = useState<SubTab>("信息");
  const [rootBusyBySn, setRootBusyBySn] = useState<Record<string, boolean>>({});
  const [rootedBySn, setRootedBySn] = useState<Record<string, boolean>>({});
  const prevOnlineRef = useRef<Set<string>>(new Set());

  const adbTab = adbTabOf(subTab);
  const adbActive = adbTab != null;
  const active = sessions.active;
  const placeholderOnly = Boolean(active?.placeholder);
  const activeOffline = Boolean(
    active && !active.placeholder && !roster.onlineSet.has(active.sn),
  );
  const activeHold = Boolean(active && recordHoldBySn[active.sn]);
  const lockSession = activeOffline && !activeHold;
  const netConnected = useMemo(
    () => isNetDeviceOnline(roster.devices, netTarget),
    [roster.devices, netTarget],
  );

  useEffect(() => {
    return subscribeAppPrefs((p) => {
      if (!p.netAdbLast) return;
      setNetTarget((cur) => (cur.trim() ? cur : p.netAdbLast));
    });
  }, []);

  useEffect(() => {
    const open = sessions.sessions.filter((s) => !s.placeholder);
    syncSessionActivities(
      "device",
      open.map((s) => ({
        key: s.sn,
        label: `设备 ${shortSn(s.sn)}`,
      })),
    );
    return () => syncSessionActivities("device", []);
  }, [sessions.sessions]);

  useEffect(() => {
    const prev = prevOnlineRef.current;
    const dropped = sessions.sessions
      .filter((s) => !s.placeholder && prev.has(s.sn) && !roster.onlineSet.has(s.sn))
      .map((s) => s.sn);
    prevOnlineRef.current = roster.onlineSet;
    if (!dropped.length) return;
    roster.setStatus(
      dropped.length === 1
        ? `${dropped[0]} 已断开`
        : `${dropped.length} 台设备已断开`,
    );
  }, [roster.onlineSet, sessions.sessions, roster.setStatus]);

  useEffect(() => {
    if (activeOffline && activeHold) setSubTab("遥控");
  }, [activeOffline, activeHold]);

  async function connectNet() {
    const target = netTarget.trim();
    if (!target) {
      roster.setError("请输入 host:port");
      return;
    }
    roster.setBusy(true);
    roster.setError("");
    try {
      const r = await api.connect(target);
      patchAppPrefs({ netAdbLast: target });
      roster.applySnapshot(r);
      if (r.ok && r.selected) sessions.openSession(r.selected);
      roster.setStatus(r.message || "已连接");
    } catch (e) {
      roster.setError(toErrorMessage(e));
    } finally {
      roster.setBusy(false);
    }
  }

  async function disconnectNet() {
    const target = normalizeNetTarget(netTarget);
    if (!target || !isNetDeviceOnline(roster.devices, target)) {
      roster.setError("该网络设备未连接，无法断开");
      return;
    }
    roster.endPick();
    roster.setBusy(true);
    roster.setError("");
    try {
      const r = await api.disconnect(target);
      roster.applySnapshot(r);
      sessions.closeBySerial([target, netTarget.trim()]);
      roster.setStatus(r.message || "已断开");
    } catch (e) {
      roster.setError(toErrorMessage(e));
    } finally {
      roster.setBusy(false);
    }
  }

  async function rootDevice(sn: string) {
    if (!sn || rootBusyBySn[sn]) return;
    setRootBusyBySn((prev) => ({ ...prev, [sn]: true }));
    try {
      const r = await api.deviceRoot(sn);
      const msg = (r.message || "").trim() || "adb root 成功";
      setRootedBySn((prev) => ({ ...prev, [sn]: true }));
      toast.push(`${shortSn(sn)} ${msg}`, "ok");
    } catch (e) {
      toast.push(`Root 失败：${toErrorMessage(e)}`, "err");
    } finally {
      setRootBusyBySn((prev) => ({ ...prev, [sn]: false }));
    }
  }

  return (
    <div className="panel device-page">
      <div className="device-connect">
        <div className="device-connect-main">
          <div className="device-connect-group" role="group" aria-label="USB / 在线设备">
            <span className="device-connect-label">设备</span>
            <DevicePickSelect
              selected={roster.selected}
              options={roster.deviceOptions}
              pendingRows={roster.pendingRows}
              emptyText={
                roster.pendingRows.length ? "有设备未就绪" : "无在线设备"
              }
              title={
                roster.devices.length
                  ? `在线 ${roster.devices.length} 台，选择 ADB 设备`
                  : roster.pendingRows.length
                    ? "已看到设备，但尚未授权或离线"
                    : "无在线设备"
              }
              onBeginPick={roster.beginPick}
              onEndPick={roster.endPick}
              onChange={roster.choose}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={roster.busy}
              title="刷新设备列表"
              onClick={() => void roster.refresh()}
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={roster.busy || !roster.devices.includes(roster.selected)}
              title="打开所选设备会话"
              onClick={() => sessions.openSession(roster.selected)}
            >
              打开
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={roster.busy || !roster.devices.length}
              title="为全部在线设备打开会话"
              onClick={() => sessions.openAll(roster.devices)}
            >
              全部
            </Button>
          </div>

          <span className="device-connect-sep" aria-hidden />

          <div className="device-connect-group device-connect-net" role="group" aria-label="网络 ADB">
            <span className="device-connect-label">网络</span>
            <input
              className="field device-connect-host"
              placeholder="IP 或 host:5555"
              value={netTarget}
              disabled={roster.busy}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setNetTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void connectNet();
              }}
              title="网络调试地址，仅 IP 时默认端口 5555"
              aria-label="网络调试地址"
            />
            <Button
              size="sm"
              disabled={roster.busy || !netTarget.trim()}
              title="adb connect"
              onClick={() => void connectNet()}
            >
              连接
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={roster.busy || !netConnected}
              title={
                netConnected
                  ? `断开 ${normalizeNetTarget(netTarget)}`
                  : "仅已连接的网络设备可断开"
              }
              onClick={() => void disconnectNet()}
            >
              断开
            </Button>
          </div>
        </div>
      </div>

      {roster.error ? <StatusBanner tone="error">{roster.error}</StatusBanner> : null}

      <DeviceSessionChips
        sessions={sessions.sessions}
        activeId={sessions.activeId}
        onlineSet={roster.onlineSet}
        rootedBySn={rootedBySn}
        rootBusyBySn={rootBusyBySn}
        onRoot={(sn) => void rootDevice(sn)}
        onActivate={(session) => {
          sessions.activate(session.id);
          if (!session.placeholder) {
            void api.setSelected(session.sn);
            roster.setStatus(`已切换到 ${session.sn}`);
          }
        }}
        onClose={sessions.closeSession}
      />

      <div className={`session-body${lockSession ? " is-offline" : ""}`}>
        {lockSession ? (
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
        <div className="subtabs">
          {ADB_SUB_TABS.map((t) => (
            <button
              key={t.label}
              type="button"
              className={`subtab${subTab === t.label ? " active" : ""}`}
              disabled={activeOffline}
              onClick={() => setSubTab(t.label)}
            >
              {t.label}
            </button>
          ))}
          <span className="subtabs-sep" aria-hidden />
          {OTHER_SUB_TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={`subtab${subTab === t ? " active" : ""}`}
              disabled={t === "键值判断" ? activeOffline : lockSession}
              onClick={() => setSubTab(t)}
            >
              {t}
            </button>
          ))}
        </div>

        {placeholderOnly ? (
          <div className="session-empty">
            <EmptyState
              title={roster.devices.length ? "尚未打开设备会话" : "未检测到在线设备"}
              description={
                roster.devices.length
                  ? "在上方选择设备后点击「打开」，或用网络连接 host:port。"
                  : "请确认 USB/网络调试已开启，点击「刷新」；也可直接输入 host:port 连接。"
              }
              action={
                roster.devices.length ? (
                  <Button
                    variant="primary"
                    disabled={roster.busy || !roster.selected}
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
        ) : (
          <>
            <div className={adbActive ? "session-stack" : "session-stack hidden"}>
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
                    <AdbPanel
                      deviceSn={s.sn}
                      deviceOnline={roster.onlineSet.has(s.sn)}
                      active={pageActive && s.id === sessions.activeId && adbActive}
                      tab={adbTab || "info"}
                    />
                  </div>
                ))}
            </div>
            <div
              className={subTab === "遥控" ? "session-stack" : "session-stack hidden"}
            >
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
                    <RemotePanel
                      deviceSn={s.sn}
                      active={s.id === sessions.activeId && subTab === "遥控"}
                      deviceOnline={roster.onlineSet.has(s.sn)}
                      onHoldChange={(hold) => markRecordHold(s.sn, hold)}
                    />
                  </div>
                ))}
            </div>
            <div
              className={subTab === "键值判断" ? "session-stack" : "session-stack hidden"}
            >
              {active && !active.placeholder ? (
                <KeyCheckPage
                  deviceSn={active.sn}
                  active={pageActive && subTab === "键值判断" && !lockSession}
                  deviceOnline={roster.onlineSet.has(active.sn)}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
