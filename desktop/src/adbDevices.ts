/** 合并 ADB 设备列表：保留已有顺序，只追加新 SN、去掉已离线，避免下拉框跳动。 */
export function mergeDeviceList(prev: string[], incoming: string[]): string[] {
  const incomingSet = new Set(incoming);
  const kept = prev.filter((d) => incomingSet.has(d));
  const keptSet = new Set(kept);
  const added = incoming.filter((d) => !keptSet.has(d));
  const next = [...kept, ...added];
  if (next.length === prev.length && next.every((d, i) => d === prev[i])) {
    return prev;
  }
  return next;
}

/** 轮询时保留仍在线的选项；设备已断开则改选第一台或清空，避免下拉框残留。 */
export function retainDeviceSelection(prev: string, devices: string[]): string {
  if (prev && devices.includes(prev)) return prev;
  return devices[0] || "";
}

export function deviceSelectOptions(devices: string[], _selected?: string): string[] {
  return devices;
}

export type AdbDeviceRow = { serial: string; state: string };

export function sameDeviceRows(
  prev: AdbDeviceRow[] | undefined,
  next: AdbDeviceRow[],
): boolean {
  const left = prev || [];
  if (left.length !== next.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].serial !== next[i].serial || left[i].state !== next[i].state) {
      return false;
    }
  }
  return true;
}

export function adbStateLabel(state: string): string {
  const s = (state || "").trim().toLowerCase();
  if (s === "device") return "";
  if (s === "unauthorized") return "未授权";
  if (s === "offline") return "离线";
  if (s === "connecting") return "连接中";
  if (s === "authorizing") return "授权中";
  if (s.includes("permission")) return "无权限";
  return state || "未就绪";
}

export function pendingDeviceRows(
  rows: AdbDeviceRow[] | undefined,
  ready: string[],
): AdbDeviceRow[] {
  const readySet = new Set(ready);
  const seen = new Set<string>();
  const out: AdbDeviceRow[] = [];
  for (const row of rows || []) {
    const sn = (row.serial || "").trim();
    if (!sn || readySet.has(sn) || seen.has(sn)) continue;
    const st = (row.state || "").trim().toLowerCase();
    // device：已在在线列表；offline：拔线/断开后 adb 常残留，刷新也不该继续占位
    if (st === "device" || st === "offline") continue;
    seen.add(sn);
    out.push({ serial: sn, state: row.state || "" });
  }
  return out;
}

