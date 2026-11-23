export const SERIAL_PLACEHOLDER = "未选端口";

export type SerialSession = {
  id: string;
  port: string;
  baud: number;
  placeholder: boolean;
};

export function shortPort(port: string, max = 18): string {
  const s = port.trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function placeholderSerialSession(baud: number): SerialSession {
  return { id: "ph", port: SERIAL_PLACEHOLDER, baud, placeholder: true };
}

export type PortSessionChange = {
  sessions: SerialSession[];
  activeId: string;
  status: string;
};

/** 打开端口，或切到已有标签。同一端口波特率不同则更新并重连。 */
export function withOpenedPort(
  sessions: SerialSession[],
  port: string,
  baud: number,
): PortSessionChange | { error: string } {
  const name = port.trim();
  if (!name || name === SERIAL_PLACEHOLDER) return { error: "请先选择串口" };
  const existing = sessions.find((s) => !s.placeholder && s.port === name);
  if (existing) {
    if (existing.baud !== baud) {
      return {
        sessions: sessions.map((s) =>
          s.id === existing.id ? { ...s, baud } : s,
        ),
        activeId: existing.id,
        status: `波特率 → ${baud}`,
      };
    }
    return {
      sessions,
      activeId: existing.id,
      status: `已切换到 ${name}`,
    };
  }
  const id = `serial-${name}-${Date.now()}`;
  const rest = sessions.filter((s) => !s.placeholder);
  return {
    sessions: [...rest, { id, port: name, baud, placeholder: false }],
    activeId: id,
    status: `已打开 ${name} @ ${baud}`,
  };
}

/** 为每个端口打开或切到标签。已有标签若波特率不同，改成当前波特率。 */
export function withAllPorts(
  sessions: SerialSession[],
  ports: string[],
  baud: number,
): PortSessionChange | { error: string } {
  if (!ports.length) return { error: "当前无端口，请先刷新" };
  const stamp = Date.now();
  const map = new Map(
    sessions.filter((s) => !s.placeholder).map((s) => [s.port, s] as const),
  );
  const next = ports.map((name, i) => {
    const hit = map.get(name);
    if (hit) return hit.baud === baud ? hit : { ...hit, baud };
    return {
      id: `serial-${name}-${stamp}-${i}`,
      port: name,
      baud,
      placeholder: false,
    };
  });
  return {
    sessions: next,
    activeId: next[next.length - 1].id,
    status: `已为 ${ports.length} 个端口打开/切换标签`,
  };
}

export function withPortBaud(
  sessions: SerialSession[],
  port: string,
  baud: number,
): SerialSession[] {
  let changed = false;
  const next = sessions.map((s) => {
    if (s.placeholder || s.port !== port || s.baud === baud) return s;
    changed = true;
    return { ...s, baud };
  });
  return changed ? next : sessions;
}

export function withoutPortSession(
  sessions: SerialSession[],
  activeId: string,
  id: string,
  placeholderBaud: number,
): { sessions: SerialSession[]; activeId: string } {
  const next = sessions.filter((s) => s.id !== id);
  if (!next.length) {
    const ph = placeholderSerialSession(placeholderBaud);
    return { sessions: [ph], activeId: ph.id };
  }
  return {
    sessions: next,
    activeId: activeId === id ? next[next.length - 1].id : activeId,
  };
}
