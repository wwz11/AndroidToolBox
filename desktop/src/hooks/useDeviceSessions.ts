import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api/client";
import { useStatusNotify } from "../components/toast";
import {
  DEVICE_PLACEHOLDER,
  placeholderSession,
  withAllSessions,
  withOpenedSession,
  withoutSerials,
  withoutSession,
  type DeviceSession,
} from "../deviceSessions";

type Options = {
  idPrefix: string;
  setError: Dispatch<SetStateAction<string>>;
  /** 为 true 时，新开标签会清掉当前错误 */
  clearErrorOnOpen?: boolean;
  runningBySn?: Record<string, boolean>;
  /** 有进行中的任务时禁止关闭，并显示这句 */
  closeBlockedMessage?: string;
};

export function useDeviceSessions({
  idPrefix,
  setError,
  clearErrorOnOpen = false,
  runningBySn,
  closeBlockedMessage,
}: Options) {
  const setStatus = useStatusNotify();
  const [sessions, setSessions] = useState<DeviceSession[]>(() => [
    placeholderSession(),
  ]);
  const [activeId, setActiveId] = useState("ph");
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  sessionsRef.current = sessions;
  activeIdRef.current = activeId;

  const openSession = useCallback(
    (sn: string) => {
      const target = sn.trim();
      if (!target || target === DEVICE_PLACEHOLDER) {
        setError("请先选择设备 SN");
        return;
      }
      const next = withOpenedSession(sessionsRef.current, target, idPrefix);
      setSessions(next.sessions);
      setActiveId(next.activeId);
      setStatus(next.created ? `已打开 ${target}` : `已切换到 ${target}`);
      if (next.created && clearErrorOnOpen) setError("");
      void api.setSelected(target);
    },
    [clearErrorOnOpen, idPrefix, setError, setStatus],
  );

  const openAll = useCallback(
    (devices: string[]) => {
      if (!devices.length) {
        setError("当前无在线设备，请先刷新");
        return;
      }
      const next = withAllSessions(sessionsRef.current, devices, idPrefix);
      setSessions(next.sessions);
      setActiveId(next.activeId);
      setStatus(`已为 ${devices.length} 台设备打开/切换标签`);
      setError("");
      void api.setSelected(devices[devices.length - 1]);
    },
    [idPrefix, setError, setStatus],
  );

  const closeSession = useCallback(
    (id: string) => {
      const target = sessionsRef.current.find((s) => s.id === id);
      if (
        closeBlockedMessage &&
        target &&
        !target.placeholder &&
        runningBySn?.[target.sn]
      ) {
        setError(closeBlockedMessage);
        setStatus(closeBlockedMessage);
        return;
      }
      const next = withoutSession(sessionsRef.current, activeIdRef.current, id);
      setSessions(next.sessions);
      setActiveId(next.activeId);
      if (closeBlockedMessage) {
        setError((prev) => (prev.includes("请先停止") ? "" : prev));
      }
    },
    [closeBlockedMessage, runningBySn, setError, setStatus],
  );

  const closeBySerial = useCallback((serials: string[]) => {
    const next = withoutSerials(sessionsRef.current, activeIdRef.current, serials);
    setSessions(next.sessions);
    setActiveId(next.activeId);
  }, []);

  const activate = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const active = sessions.find((s) => s.id === activeId) || sessions[0];

  return {
    sessions,
    activeId,
    active,
    openSession,
    openAll,
    closeSession,
    closeBySerial,
    activate,
  };
}
