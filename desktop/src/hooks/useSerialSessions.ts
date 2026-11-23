import { useCallback, useRef, useState } from "react";
import { useStatusNotify } from "../components/toast";
import {
  placeholderSerialSession,
  withAllPorts,
  withOpenedPort,
  withPortBaud,
  withoutPortSession,
  type SerialSession,
} from "../serialSessions";

export function useSerialSessions(getDefaultBaud: () => number) {
  const setStatus = useStatusNotify();
  const [sessions, setSessions] = useState<SerialSession[]>(() => [
    placeholderSerialSession(getDefaultBaud()),
  ]);
  const [activeId, setActiveId] = useState("ph");
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeId);
  sessionsRef.current = sessions;
  activeIdRef.current = activeId;

  const openSession = useCallback(
    (port: string, baud: number) => {
      const rate = Number(baud) || getDefaultBaud();
      const next = withOpenedPort(sessionsRef.current, port, rate);
      if ("error" in next) {
        setStatus(next.error);
        return;
      }
      setSessions(next.sessions);
      setActiveId(next.activeId);
      setStatus(next.status);
    },
    [getDefaultBaud, setStatus],
  );

  const openAll = useCallback(
    (ports: string[], baud: number) => {
      const next = withAllPorts(sessionsRef.current, ports, baud);
      if ("error" in next) {
        setStatus(next.error);
        return;
      }
      setSessions(next.sessions);
      setActiveId(next.activeId);
      setStatus(next.status);
    },
    [setStatus],
  );

  const applyBaudToPort = useCallback((port: string, baud: number) => {
    setSessions((prev) => withPortBaud(prev, port, baud));
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      const next = withoutPortSession(
        sessionsRef.current,
        activeIdRef.current,
        id,
        getDefaultBaud(),
      );
      setSessions(next.sessions);
      setActiveId(next.activeId);
    },
    [getDefaultBaud],
  );

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
    applyBaudToPort,
    closeSession,
    activate,
  };
}
