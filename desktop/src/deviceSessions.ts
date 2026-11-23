export const DEVICE_PLACEHOLDER = "未选设备";

export type DeviceSession = {
  id: string;
  sn: string;
  placeholder: boolean;
};

export function placeholderSession(): DeviceSession {
  return { id: "ph", sn: DEVICE_PLACEHOLDER, placeholder: true };
}

export function shortSn(sn: string, max = 18): string {
  const s = sn.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function findOpenSession(
  sessions: DeviceSession[],
  sn: string,
): DeviceSession | undefined {
  const target = sn.trim();
  return sessions.find((s) => !s.placeholder && s.sn === target);
}

/** 打开或切到已有会话。调用方负责提示和选中设备。 */
export function withOpenedSession(
  sessions: DeviceSession[],
  sn: string,
  idPrefix: string,
): { sessions: DeviceSession[]; activeId: string; created: boolean } {
  const target = sn.trim();
  const existing = findOpenSession(sessions, target);
  if (existing) {
    return { sessions, activeId: existing.id, created: false };
  }
  const id = `${idPrefix}-${target}-${Date.now()}`;
  const rest = sessions.filter((s) => !s.placeholder);
  return {
    sessions: [...rest, { id, sn: target, placeholder: false }],
    activeId: id,
    created: true,
  };
}

export function withAllSessions(
  sessions: DeviceSession[],
  devices: string[],
  idPrefix: string,
): { sessions: DeviceSession[]; activeId: string } {
  const stamp = Date.now();
  const map = new Map(
    sessions.filter((s) => !s.placeholder).map((s) => [s.sn, s] as const),
  );
  const next = devices.map((sn, i) => {
    const hit = map.get(sn);
    return hit || { id: `${idPrefix}-${sn}-${stamp}-${i}`, sn, placeholder: false };
  });
  return { sessions: next, activeId: next[next.length - 1].id };
}

export function withoutSession(
  sessions: DeviceSession[],
  activeId: string,
  id: string,
): { sessions: DeviceSession[]; activeId: string } {
  const next = sessions.filter((s) => s.id !== id);
  if (!next.length) {
    const ph = placeholderSession();
    return { sessions: [ph], activeId: ph.id };
  }
  return {
    sessions: next,
    activeId: activeId === id ? next[next.length - 1].id : activeId,
  };
}

export function withoutSerials(
  sessions: DeviceSession[],
  activeId: string,
  serials: string[],
): { sessions: DeviceSession[]; activeId: string } {
  const drop = new Set(serials.map((s) => s.trim()).filter(Boolean));
  const next = sessions.filter((s) => s.placeholder || !drop.has(s.sn));
  if (!next.length) {
    const ph = placeholderSession();
    return { sessions: [ph], activeId: ph.id };
  }
  const still = next.some((s) => s.id === activeId);
  return {
    sessions: next,
    activeId: still ? activeId : next[next.length - 1].id,
  };
}
