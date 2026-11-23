/** 后台任务 / 已打开会话：托盘 + 左侧导航共用。 */

export type ActivityNav = "devices" | "emmc" | "monkey" | "serial";

export type ActivityEntry = {
  id: string;
  label: string;
  nav: ActivityNav;
};

type Listener = (entries: ActivityEntry[]) => void;

const entries = new Map<string, ActivityEntry>();
const listeners = new Set<Listener>();

function navOf(id: string): ActivityNav {
  if (id.startsWith("emmc:")) return "emmc";
  if (id.startsWith("monkey:")) return "monkey";
  if (id.startsWith("serial:")) return "serial";
  return "devices";
}

function snapshot(): ActivityEntry[] {
  return [...entries.values()];
}

function emit() {
  const list = snapshot();
  for (const fn of listeners) {
    try {
      fn(list);
    } catch {
      /* ignore */
    }
  }
}

export function reportActivity(
  id: string,
  active: boolean,
  label = "",
): void {
  const key = String(id || "").trim();
  if (!key) return;

  if (active) {
    entries.set(key, {
      id: key,
      label: String(label || key).trim() || key,
      nav: navOf(key),
    });
  } else {
    entries.delete(key);
  }
  emit();

  try {
    window.toolbox?.reportActivity?.({
      id: key,
      active,
      label: label || key,
    });
  } catch {
    /* ignore */
  }
}

/**
 * 同步一组会话活动（如已打开的设备/串口标签）。
 * prefix 例：`device` / `serial`，最终 id 为 `prefix:key`。
 */
export function syncSessionActivities(
  prefix: "device" | "serial" | "emmc" | "monkey",
  items: Array<{ key: string; label: string }>,
): void {
  const head = `${prefix}:`;
  const nextIds = new Set(
    items
      .map((it) => String(it.key || "").trim())
      .filter(Boolean)
      .map((k) => `${head}${k}`),
  );
  for (const id of [...entries.keys()]) {
    if (id.startsWith(head) && !nextIds.has(id)) {
      reportActivity(id, false);
    }
  }
  for (const it of items) {
    const k = String(it.key || "").trim();
    if (!k) continue;
    reportActivity(`${head}${k}`, true, it.label);
  }
}

export function subscribeActivities(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

export function activitiesForNav(nav: string): ActivityEntry[] {
  return snapshot().filter((e) => e.nav === nav);
}
