import { ApiError, toErrorMessage } from "../errors";

const DEFAULT_API = "http://127.0.0.1:17831";

export function apiBase(): string {
  return window.toolbox?.apiBase || import.meta.env.VITE_API_URL || DEFAULT_API;
}

export function apiToken(): string {
  return window.toolbox?.apiToken || (import.meta.env.VITE_API_TOKEN as string) || "";
}

export function wsBase(): string {
  const base = apiBase();
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

export function wsUrl(path: string): string {
  const base = wsBase();
  const token = apiToken();
  const sep = path.includes("?") ? "&" : "?";
  const tokenQuery = token ? `${sep}token=${encodeURIComponent(token)}` : "";
  return `${base}${path}${tokenQuery}`;
}

function q(params: Record<string, string | boolean | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isForm && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = apiToken();
  if (token && !headers["X-Toolbox-Token"]) {
    headers["X-Toolbox-Token"] = token;
  }
  const timeoutMs = init?.timeoutMs ?? (isForm ? 120_000 : 30_000);
  const controller = !init?.signal && timeoutMs > 0 ? new AbortController() : null;
  const timer =
    controller != null
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? controller?.signal,
    });
  } catch (e) {
    const raw = toErrorMessage(e, "网络错误");
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError("请求超时，请检查本机服务或网络连接", 0, path);
    }
    if (/failed to fetch|networkerror|load failed|fetch failed/i.test(raw)) {
      throw new ApiError("无法连接本机服务，请稍后重试或重启应用", 0, path);
    }
    throw new ApiError(raw, 0, path);
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = res.statusText || "请求失败";
    try {
      const body = (await res.json()) as { detail?: string | unknown };
      if (typeof body.detail === "string" && body.detail.trim()) detail = body.detail;
      else if (body.detail) detail = JSON.stringify(body.detail);
    } catch {
      /* 非 JSON 错误体沿用状态文本 */
    }
    throw new ApiError(detail, res.status, path);
  }
  return (await res.json()) as T;
}

export interface TransferProgressEvent {
  done_bytes: number;
  total_bytes: number;
  percent: number | null;
  speed_bps: number;
}

export interface BugreportProgressEvent {
  elapsed_sec: number;
  size_bytes: number;
  percent: number | null;
  stage: string;
}

async function requestNdjson<T>(
  path: string,
  init: RequestInit,
  onProgress?: (ev: TransferProgressEvent) => void,
  onRawEvent?: (msg: Record<string, unknown>) => void,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (!isForm && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const token = apiToken();
  if (token && !headers["X-Toolbox-Token"]) {
    headers["X-Toolbox-Token"] = token;
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  } catch (e) {
    const raw = toErrorMessage(e, "网络错误");
    if (/failed to fetch|networkerror|load failed|fetch failed/i.test(raw)) {
      throw new ApiError("无法连接本机服务，请稍后重试或重启应用", 0, path);
    }
    throw new ApiError(raw, 0, path);
  }
  if (!res.ok) {
    let detail = res.statusText || "请求失败";
    try {
      const body = (await res.json()) as { detail?: string | unknown };
      if (typeof body.detail === "string" && body.detail.trim()) detail = body.detail;
      else if (body.detail) detail = JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status, path);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ApiError("浏览器不支持流式读取", 0, path);
  }
  const dec = new TextDecoder();
  let buf = "";
  let doneResult: T | null = null;
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: !done });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.type === "start") {
            onRawEvent?.(msg);
            onProgress?.({
              done_bytes: 0,
              total_bytes: Number(msg.total_bytes || 0),
              percent: msg.total_bytes ? 0 : null,
              speed_bps: 0,
            });
          } else if (msg.type === "progress") {
            onRawEvent?.(msg);
            onProgress?.({
              done_bytes: Number(msg.done_bytes || 0),
              total_bytes: Number(msg.total_bytes || 0),
              percent: msg.percent == null ? null : Number(msg.percent),
              speed_bps: Number(msg.speed_bps || 0),
            });
          } else if (msg.type === "error") {
            throw new ApiError(String(msg.detail || "传输失败"), 502, path);
          } else if (msg.type === "done") {
            doneResult = msg as unknown as T;
          }
        }
        nl = buf.indexOf("\n");
      }
    }
    if (done) break;
  }
  if (doneResult == null) {
    throw new ApiError("传输流意外结束", 0, path);
  }
  return doneResult;
}

import type {
  ApkAnalyzeResponse,
  ApkCompareResponse,
  ConnectResponse,
  DevicesResponse,
  HealthResponse,
  KeyCaptureResponse,
  KeyIdsResponse,
} from './types';

export * from './types';

export const REQUIRED_API_REV = 93;

export const api = {
  health: () => request<HealthResponse>("/health"),
  version: () =>
    request<{
      version: string;
      build_tag: string;
      api_rev?: number;
      data_dir?: string;
      install_dir?: string;
    }>("/version"),
  devices: () => request<DevicesResponse>("/adb/devices", { timeoutMs: 6000 }),
  refresh: () => request<DevicesResponse>("/adb/refresh", { method: "POST" }),
  deviceKeyIds: (device: string, signal?: AbortSignal) =>
    request<KeyIdsResponse>(`/adb/device/key-ids${q({ device })}`, { signal }),
  captureKey: (device: string, timeout = 20, signal?: AbortSignal) =>
    request<KeyCaptureResponse>(
      `/adb/device/key-capture${q({ device, timeout })}`,
      { method: "POST", signal },
    ),
  cancelKeyCapture: (device: string) =>
    request<{ ok: boolean; stopped: boolean; message: string }>(
      `/adb/device/key-capture/cancel${q({ device })}`,
      { method: "POST" },
    ),
  setSelected: (serial: string) =>
    request<{ serial: string }>("/adb/selected", {
      method: "PUT",
      body: JSON.stringify({ serial }),
    }),
  connect: (target: string) =>
    request<ConnectResponse>("/adb/connect", {
      method: "POST",
      body: JSON.stringify({ target }),
    }),
  disconnect: (target?: string) =>
    request<ConnectResponse>("/adb/disconnect", {
      method: "POST",
      body: JSON.stringify({ target: target || "" }),
    }),

  deviceProps: (device: string) =>
    request<{ device: string; props: Record<string, string>; failed: number }>(
      `/adb/device/props${q({ device })}`,
    ),
  deviceInfo: (device: string) =>
    request<{
      device: string;
      info: Record<string, string>;
      props: Record<string, string>;
      failed: number;
    }>(`/adb/device/info${q({ device })}`),
  fillMemoryPreview: (device: string, fillPct = 100, reserveMb = 32, fillDir = "") =>
    request<{
      device: string;
      ok: boolean;
      fill_pct: number;
      fill_dir?: string;
      avail_label: string;
      size_label?: string;
      used_label?: string;
      usable_label: string;
      target_bytes: number;
      target_label: string;
      existing_label?: string;
      message: string;
      path: string;
    }>(
      `/adb/device/fill-memory/preview${q({
        device,
        fill_pct: fillPct,
        reserve_mb: reserveMb,
        fill_dir: fillDir,
      })}`,
    ),
  fillMemory: (device: string, fillPct = 100, reserveMb = 32, fillDir = "") =>
    request<{
      device: string;
      ok: boolean;
      job_id: string;
      state: string;
      message: string;
      fill_pct: number;
      target_bytes: number;
      target_label: string;
      written_bytes: number;
      written_label: string;
      pct: number;
      running: boolean;
      path?: string;
      fill_dir?: string;
      avail_label?: string;
    }>(`/adb/device/fill-memory${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        fill_pct: fillPct,
        reserve_mb: reserveMb,
        fill_dir: fillDir,
      }),
    }),
  fillMemoryJob: (jobId: string) =>
    request<{
      job_id: string;
      device: string;
      state: string;
      message: string;
      fill_pct: number;
      target_bytes: number;
      target_label: string;
      written_bytes: number;
      written_label: string;
      pct: number;
      running: boolean;
      result?: Record<string, unknown>;
    }>(`/adb/device/fill-memory/jobs/${encodeURIComponent(jobId)}`),
  fillMemoryActive: (device: string) =>
    request<{
      device: string;
      active: boolean;
      job: null | {
        job_id: string;
        state: string;
        message: string;
        fill_pct: number;
        target_bytes: number;
        target_label: string;
        written_bytes: number;
        written_label: string;
        pct: number;
        running: boolean;
      };
    }>(`/adb/device/fill-memory/active${q({ device })}`),
  fillMemoryStop: (jobId: string) =>
    request<{ job_id: string; ok: boolean; message: string }>(
      `/adb/device/fill-memory/jobs/${encodeURIComponent(jobId)}/stop`,
      { method: "POST" },
    ),
  monkeyStart: (
    device: string,
    body: {
      event_count?: number;
      throttle_ms?: number;
      packages?: string[];
      seed?: number | null;
      verbose?: number;
      ignore_crashes?: boolean;
      ignore_timeouts?: boolean;
      ignore_security?: boolean;
      kill_process_after?: boolean;
    } = {},
  ) =>
    request<{
      ok: boolean;
      message: string;
      job_id: string;
      device: string;
      state: string;
      running: boolean;
      command: string;
      event_count: number;
      throttle_ms: number;
      packages: string[];
    }>(`/adb/device/monkey${q({ device })}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  monkeyJob: (jobId: string, since = 0) =>
    request<{
      job_id: string;
      device: string;
      state: string;
      message: string;
      command: string;
      event_count: number;
      throttle_ms: number;
      packages: string[];
      started_at: string;
      finished_at: string;
      running: boolean;
      logs: string[];
      log_cursor: number;
      /* incremental log cursor */
      result: Record<string, unknown>;
    }>(
      `/adb/device/monkey/jobs/${encodeURIComponent(jobId)}${q({ since })}`,
    ),
  monkeyActive: (device: string) =>
    request<{
      device: string;
      active: boolean;
      job: null | {
        job_id: string;
        state: string;
        message: string;
        command: string;
        running: boolean;
        logs: string[];
      log_cursor: number;
        event_count: number;
        throttle_ms: number;
        packages: string[];
      };
      device_monkey?: {
        running: boolean;
        pids: string[];
      };
    }>(`/adb/device/monkey/active${q({ device })}`),
  monkeyStop: (jobId: string) =>
    request<{ ok: boolean; message: string; job_id: string; running?: boolean }>(
      `/adb/device/monkey/jobs/${encodeURIComponent(jobId)}/stop`,
      { method: "POST" },
    ),
  monkeyStopDevice: (device: string) =>
    request<{
      ok: boolean;
      message: string;
      device: string;
      job_id: string | null;
      running: boolean;
      device_monkey: { running: boolean; pids: string[] };
      stopped_pids: string[];
    }>(`/adb/device/monkey/stop${q({ device })}`, { method: "POST" }),
  releaseMemoryFill: (device: string, fillDir = "") =>
    request<{
      device: string;
      ok: boolean;
      path: string;
      fill_dir?: string;
      freed_bytes: number;
      freed_label: string;
      message: string;
    }>(`/adb/device/fill-memory/release${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ fill_dir: fillDir }),
    }),
  deviceShell: (device: string, command: string) =>
    request<{
      device: string;
      command: string;
      returncode: number;
      stdout: string;
      stderr: string;
      ok: boolean;
    }>(`/adb/device/shell${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ command }),
    }),
  deviceRoot: (device: string) =>
    request<{ device: string; ok: boolean; message: string }>(
      `/adb/device/root${q({ device })}`,
      { method: "POST" },
    ),

  packages: (device: string, filter = "", scope: "all" | "third" | "system" = "all") =>
    request<{
      device: string;
      packages: string[];
      count: number;
      scope?: string;
    }>(`/adb/device/packages${q({ device, q: filter || undefined, scope })}`),
  packageInfo: (device: string, pkg: string) =>
    request<{
      device: string;
      package: string;
      installed: boolean;
      enabled: boolean;
      version_name: string;
      version_code: string;
      min_sdk: string;
      target_sdk: string;
      first_install_time: string;
      last_update_time: string;
      path: string;
      permissions: string[];
      install_granted: string[];
      runtime_granted: string[];
      runtime_denied: string[];
    }>(`/adb/device/packages/info${q({ device, package: pkg })}`),
  foregroundApp: (device: string) =>
    request<{
      device: string;
      ok: boolean;
      package: string;
      activity: string;
      raw: string;
    }>(`/adb/device/foreground-app${q({ device })}`),
  uninstall: (device: string, pkg: string, keepData = false) =>
    request<{ ok: boolean; output: string; package: string }>(
      `/adb/device/uninstall${q({ device })}`,
      {
        method: "POST",
        body: JSON.stringify({ package: pkg, keep_data: keepData }),
      },
    ),
  clearPackageData: (device: string, pkg: string) =>
    request<{ ok: boolean; output: string; package: string }>(
      `/adb/device/clear-data${q({ device })}`,
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  forceStopPackage: (device: string, pkg: string) =>
    request<{ ok: boolean; output: string; package: string }>(
      `/adb/device/force-stop${q({ device })}`,
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  launchPackage: (device: string, pkg: string) =>
    request<{ ok: boolean; output: string; package: string }>(
      `/adb/device/launch${q({ device })}`,
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  restartPackage: (device: string, pkg: string) =>
    request<{ ok: boolean; output: string; package: string }>(
      `/adb/device/restart${q({ device })}`,
      { method: "POST", body: JSON.stringify({ package: pkg }) },
    ),
  setPackageEnabled: (device: string, pkg: string, enabled: boolean) =>
    request<{ ok: boolean; output: string; package: string; enabled: boolean }>(
      `/adb/device/package-state${q({ device })}`,
      { method: "POST", body: JSON.stringify({ package: pkg, enabled }) },
    ),
  setPackagePermission: (
    device: string,
    pkg: string,
    permission: string,
    granted: boolean,
  ) =>
    request<{
      ok: boolean;
      output: string;
      package: string;
      permission: string;
      granted: boolean;
    }>(`/adb/device/package-permission${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, permission, granted }),
    }),
  grantAllPackagePermissions: (
    device: string,
    pkg: string,
    permissions: string[],
  ) =>
    request<{
      ok: boolean;
      granted_count: number;
      failed_count: number;
      output: string;
      package: string;
    }>(`/adb/device/package-permissions/grant-all${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ package: pkg, permissions }),
    }),
  exportApk: (device: string, pkg: string, destDir = "", versionName = "") =>
    request<{
      ok: boolean;
      package: string;
      saved_paths: string[];
      saved_dir: string;
      output: string;
    }>(`/adb/device/export-apk${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        package: pkg,
        dest_dir: destDir,
        version_name: versionName,
      }),
    }),
  installApk: (
    device: string,
    file: File,
    opts: {
      reinstall?: boolean;
      downgrade?: boolean;
      grantPermissions?: boolean;
    } = {},
  ) => {
    const fd = new FormData();
    fd.append("reinstall", (opts.reinstall ?? true) ? "true" : "false");
    fd.append("downgrade", opts.downgrade ? "true" : "false");
    fd.append("grant_permissions", opts.grantPermissions ? "true" : "false");
    fd.append("file", file);
    return request<{ ok: boolean; output: string; filename: string }>(
      `/adb/device/install${q({ device })}`,
      { method: "POST", body: fd },
    );
  },
  screencap: (device: string) =>
    request<{
      ok: boolean;
      mime: string;
      width: number;
      height: number;
      png_base64: string;
    }>(`/adb/device/screencap${q({ device })}`, { method: "POST" }),
  screencapClipboard: (imageBase64: string) =>
    request<{ ok: boolean; message: string }>(`/adb/device/screencap/clipboard`, {
      method: "POST",
      body: JSON.stringify({ image_base64: imageBase64 }),
    }),
  logcatClear: (device: string, buffer = "") =>
    request<{ ok: boolean; message: string }>(
      `/adb/device/logcat/clear${q({ device, buffer: buffer || undefined })}`,
      { method: "POST" },
    ),
  logcatSession: (device: string) =>
    request<{
      ok: boolean;
      root: string;
      session: string;
      has_session: boolean;
    }>(`/adb/device/logcat/session${q({ device })}`),
  logcatSessionEnsure: (device: string, forceNew = false) =>
    request<{
      ok: boolean;
      root: string;
      session: string;
      has_session: boolean;
      message: string;
    }>(`/adb/device/logcat/session${q({ device, new: forceNew || undefined })}`, {
      method: "POST",
    }),
  logcatDump: (
    device: string,
    opts?: {
      buffer?: string;
      tag?: string;
      level?: string;
      pid?: string;
      package?: string;
      save?: boolean;
      session?: string;
    },
  ) =>
    request<{
      ok: boolean;
      text: string;
      truncated: boolean;
      chars: number;
      saved_path: string;
      pid?: string;
      session: string;
    }>(`/adb/device/logcat/dump${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        buffer: opts?.buffer || "",
        tag: opts?.tag || "",
        level: opts?.level || "",
        pid: opts?.pid || "",
        package: opts?.package || "",
        save: opts?.save !== false,
        session: opts?.session || "",
      }),
    }),
  logcatCollectCrash: (device: string, session = "") =>
    request<{
      ok: boolean;
      dir: string;
      files: string[];
      count: number;
      notes: string[];
      session: string;
    }>(`/adb/device/logcat/collect-crash${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ session }),
    }),
  openPath: async (filePath: string) => {
    const bridge = typeof window !== "undefined" ? window.toolbox : undefined;
    if (bridge?.openPath) {
      const r = await bridge.openPath(filePath);
      if (!r?.ok) {
        throw new Error(r?.message || "打开失败");
      }
      return {
        ok: true,
        path: r.path || filePath,
        message: r.message || `已打开 ${filePath}`,
      };
    }
    return request<{ ok: boolean; path: string; message: string }>(
      `/local/open-path`,
      {
        method: "POST",
        body: JSON.stringify({ path: filePath }),
      },
    );
  },
  listRemote: (device: string, path = "/") =>
    request<{
      device: string;
      path: string;
      parent: string;
      entries: Array<{
        name: string;
        path: string;
        is_dir: boolean;
        size?: number;
        mtime?: string;
        mode?: string;
        owner?: string;
        group?: string;
        is_link?: boolean;
        link_target?: string;
      }>;
    }>(`/adb/device/ls${q({ device, path })}`),
  remoteStat: (device: string, path: string) =>
    request<{
      ok: boolean;
      path: string;
      name: string;
      is_dir?: boolean;
      size?: number;
      mtime?: string;
      mode?: string;
      owner?: string;
      group?: string;
      is_link?: boolean;
      link_target?: string;
      raw?: string;
    }>(`/adb/device/stat${q({ device, path })}`),
  pull: (device: string, remote: string, local = "") =>
    request<{ ok: boolean; output: string; saved_path: string }>(
      `/adb/device/pull${q({ device })}`,
      { method: "POST", body: JSON.stringify({ remote, local }) },
    ),
  pullStream: async (
    device: string,
    remote: string,
    local = "",
    opts?: { onProgress?: (ev: TransferProgressEvent) => void; signal?: AbortSignal },
  ) => {
    try {
      return await requestNdjson<{ ok: boolean; output: string; saved_path: string }>(
        `/adb/device/pull-stream${q({ device })}`,
        { method: "POST", body: JSON.stringify({ remote, local }), signal: opts?.signal },
        opts?.onProgress,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return api.pull(device, remote, local);
      }
      throw e;
    }
  },
  pushFile: (
    device: string,
    remote: string,
    file: File,
    opts?: { mkdirParent?: boolean },
  ) => {
    const fd = new FormData();
    fd.append("remote", remote);
    if (opts?.mkdirParent) fd.append("mkdir_parent", "true");
    fd.append("file", file);
    return request<{ ok: boolean; output: string; remote: string; filename: string }>(
      `/adb/device/push${q({ device })}`,
      { method: "POST", body: fd },
    );
  },
  pushFileStream: async (
    device: string,
    remote: string,
    file: File,
    opts?: {
      mkdirParent?: boolean;
      onProgress?: (ev: TransferProgressEvent) => void;
      signal?: AbortSignal;
    },
  ) => {
    const fd = new FormData();
    fd.append("remote", remote);
    if (opts?.mkdirParent) fd.append("mkdir_parent", "true");
    fd.append("file", file);
    try {
      return await requestNdjson<{ ok: boolean; output: string; remote: string; filename: string }>(
        `/adb/device/push-stream${q({ device })}`,
        { method: "POST", body: fd, signal: opts?.signal },
        opts?.onProgress,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return api.pushFile(device, remote, file, opts);
      }
      throw e;
    }
  },
  pushPath: (device: string, local: string, remote: string) =>
    request<{
      ok: boolean;
      output: string;
      remote: string;
      local: string;
      filename: string;
    }>(`/adb/device/push-path${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ local, remote }),
    }),
  pushPathStream: async (
    device: string,
    local: string,
    remote: string,
    opts?: { onProgress?: (ev: TransferProgressEvent) => void; signal?: AbortSignal },
  ) => {
    try {
      return await requestNdjson<{
        ok: boolean;
        output: string;
        remote: string;
        local: string;
        filename: string;
      }>(
        `/adb/device/push-path-stream${q({ device })}`,
        { method: "POST", body: JSON.stringify({ local, remote }), signal: opts?.signal },
        opts?.onProgress,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return api.pushPath(device, local, remote);
      }
      throw e;
    }
  },
  mkdir: (device: string, path: string) =>
    request<{ ok: boolean; path: string; message: string; output: string }>(
      `/adb/device/mkdir${q({ device })}`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  createFile: (device: string, path: string) =>
    request<{ ok: boolean; path: string; message: string; output: string }>(
      `/adb/device/create-file${q({ device })}`,
      { method: "POST", body: JSON.stringify({ path }) },
    ),
  deletePath: (device: string, path: string, recursive = false) =>
    request<{ ok: boolean; path: string; message: string; output: string }>(
      `/adb/device/delete${q({ device })}`,
      { method: "POST", body: JSON.stringify({ path, recursive }) },
    ),
  renamePath: (device: string, src: string, dst: string) =>
    request<{ ok: boolean; message: string; output: string }>(
      `/adb/device/rename${q({ device })}`,
      { method: "POST", body: JSON.stringify({ src, dst }) },
    ),
  copyPath: (device: string, src: string, dst: string, recursive = true) =>
    request<{ ok: boolean; message: string; output: string }>(
      `/adb/device/copy${q({ device })}`,
      { method: "POST", body: JSON.stringify({ src, dst, recursive }) },
    ),
  chmodPath: (device: string, path: string, mode: string) =>
    request<{ ok: boolean; message: string; output: string }>(
      `/adb/device/chmod${q({ device })}`,
      { method: "POST", body: JSON.stringify({ path, mode }) },
    ),
  fsDf: (device: string, path = "/") =>
    request<{
      device: string;
      path: string;
      filesystem?: string;
      total?: string;
      used?: string;
      avail?: string;
      use_pct?: string;
      mount?: string;
      raw?: string;
    }>(`/adb/device/fs/df${q({ device, path })}`),
  fsFind: (device: string, path: string, query: string) =>
    request<{
      device: string;
      base: string;
      query: string;
      count: number;
      items: Array<{ path: string; name: string; parent: string }>;
    }>(`/adb/device/fs/find${q({ device, path, q: query })}`),
  fsMd5: (device: string, path: string) =>
    request<{ device: string; path: string; md5: string }>(
      `/adb/device/fs/md5${q({ device, path })}`,
    ),
  fsRead: (device: string, path: string) =>
    request<{
      device: string;
      kind: "text" | "image";
      path: string;
      name: string;
      size: number;
      text?: string;
      mime?: string;
      base64?: string;
      truncated: boolean;
    }>(`/adb/device/fs/read${q({ device, path })}`),
  fsWrite: (device: string, path: string, content: string) =>
    request<{ device: string; ok: boolean; output: string; path: string }>(
      `/adb/device/fs/write${q({ device })}`,
      { method: "POST", body: JSON.stringify({ path, content }) },
    ),
  uiDump: (device: string, onlyWithId = false) =>
    request<{
      ok: boolean;
      count: number;
      nodes: Array<{
        depth: number;
        text: string;
        resource_id: string;
        class: string;
        content_desc: string;
        bounds: string;
        label: string;
        clickable?: boolean;
        package?: string;
      }>;
      xml_preview: string;
    }>(`/adb/device/ui-dump${q({ device, only_with_id: onlyWithId })}`, {
      method: "POST",
    }),
  bugreport: (device: string, opts?: { session?: string }) =>
    request<{
      ok: boolean;
      saved_path: string;
      session?: string;
      message: string;
    }>(`/adb/device/bugreport${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ session: opts?.session || "" }),
    }),
  bugreportStream: async (
    device: string,
    opts?: {
      session?: string;
      onProgress?: (ev: BugreportProgressEvent) => void;
      signal?: AbortSignal;
    },
  ) => {
    try {
      return await requestNdjson<{
        ok: boolean;
        saved_path: string;
        session?: string;
        message: string;
      }>(
        `/adb/device/bugreport-stream${q({ device })}`,
        {
          method: "POST",
          body: JSON.stringify({ session: opts?.session || "" }),
          signal: opts?.signal,
        },
        undefined,
        (msg) => {
          opts?.onProgress?.({
            elapsed_sec: Number(msg.elapsed_sec || 0),
            size_bytes: Number(msg.size_bytes || 0),
            percent: msg.percent == null ? null : Number(msg.percent),
            stage: String(msg.stage || "collect"),
          });
        },
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        return api.bugreport(device, { session: opts?.session });
      }
      throw e;
    }
  },
  dumpsys: (
    device: string,
    service = "activity",
    save = true,
    opts?: { session?: string },
  ) =>
    request<{
      ok: boolean;
      service: string;
      saved_path: string;
      session?: string;
      truncated: boolean;
      chars: number;
      text: string;
      message: string;
    }>(`/adb/device/dumpsys${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        service,
        save,
        session: opts?.session || "",
      }),
    }),
  getpropExport: (
    device: string,
    save = true,
    opts?: { session?: string },
  ) =>
    request<{
      ok: boolean;
      saved_path: string;
      session?: string;
      truncated: boolean;
      chars: number;
      text: string;
      message: string;
    }>(`/adb/device/getprop${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        save,
        session: opts?.session || "",
      }),
    }),
  shellPresets: () =>
    request<{ presets: Array<{ cmd: string; label: string }> }>(
      "/adb/device/shell/presets",
    ),
  saveShellPresets: (presets: Array<{ cmd: string; label: string }>) =>
    request<{ ok: boolean; presets: Array<{ cmd: string; label: string }> }>(
      "/adb/device/shell/presets",
      { method: "PUT", body: JSON.stringify({ presets }) },
    ),

  md5Text: (text: string, uppercase = false) =>
    request<{ md5: string; chars: number }>("/local/md5/text", {
      method: "POST",
      body: JSON.stringify({ text, uppercase }),
    }),
  md5File: (file: File, uppercase = false) => {
    const fd = new FormData();
    fd.append("uppercase", uppercase ? "true" : "false");
    fd.append("file", file);
    return request<{ md5: string; filename: string; bytes: number }>(
      "/local/md5/file",
      { method: "POST", body: fd },
    );
  },
  base64Encode: (
    text: string,
    opts?: { urlsafe?: boolean; lines?: number; compactJson?: boolean },
  ) =>
    request<{ result: string }>("/local/base64/encode", {
      method: "POST",
      body: JSON.stringify({
        text,
        urlsafe: opts?.urlsafe || false,
        lines: opts?.lines || 0,
        compact_json: opts?.compactJson !== false,
      }),
    }),
  base64Decode: (
    text: string,
    opts?: { urlsafe?: boolean; prettyJson?: boolean },
  ) =>
    request<{ result: string }>("/local/base64/decode", {
      method: "POST",
      body: JSON.stringify({
        text,
        urlsafe: opts?.urlsafe || false,
        pretty_json: opts?.prettyJson !== false,
      }),
    }),
  barcodePreview: (data: string) =>
    request<{
      ok: boolean;
      mime: string;
      png_base64: string;
      width: number;
      height: number;
    }>("/local/barcode/preview", {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  gotaDefaultDir: () =>
    request<{ ok: boolean; out_dir: string }>("/local/gota/default-dir"),
  gotaSplit: (file: File, prefix: string, chunkSize: number, outDir: string) => {
    const fd = new FormData();
    fd.append("prefix", prefix);
    fd.append("chunk_size", String(chunkSize));
    fd.append("out_dir", outDir || "");
    fd.append("file", file);
    return request<{
      ok: boolean;
      total_lines: number;
      part_count: number;
      out_dir: string;
      files: string[];
    }>("/local/gota/split", { method: "POST", body: fd });
  },
  gotaSplitText: (
    text: string,
    prefix: string,
    chunkSize: number,
    outDir: string,
  ) =>
    request<{
      ok: boolean;
      total_lines: number;
      part_count: number;
      out_dir: string;
      files: string[];
    }>("/local/gota/split-text", {
      method: "POST",
      body: JSON.stringify({
        text,
        prefix,
        chunk_size: chunkSize,
        out_dir: outDir || "",
      }),
    }),

  serialPorts: () =>
    request<{ available: boolean; ports: string[]; baud_presets: number[] }>(
      "/serial/ports",
    ),

  remoteActions: () =>
    request<{
      actions: Array<{
        label: string;
        kind: string;
        keycode: number;
        hint: string;
        confirm: string;
      }>;
    }>("/remote/actions"),
  remoteAction: (device: string, label: string) =>
    request<{ ok: boolean; message: string }>(`/remote/action${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),
  remoteText: (device: string, text: string) =>
    request<{ ok: boolean }>(`/remote/text${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  remoteAccounts: () =>
    request<{
      accounts: Array<{
        id: string;
        label: string;
        username: string;
        password: string;
        next: string;
      }>;
    }>("/remote/accounts"),
  saveRemoteAccounts: (
    accounts: Array<{
      id?: string;
      label: string;
      username: string;
      password: string;
      next?: string;
    }>,
  ) =>
    request<{
      ok: boolean;
      accounts: Array<{
        id: string;
        label: string;
        username: string;
        password: string;
        next: string;
      }>;
    }>("/remote/accounts", {
      method: "PUT",
      body: JSON.stringify({ accounts }),
    }),
  remoteAccountFill: (
    device: string,
    accountId: string,
    field: "user" | "pass" | "login",
    opts?: { submit?: boolean; pauseMs?: number },
  ) =>
    request<{
      ok: boolean;
      message: string;
      label: string;
      field: string;
    }>(`/remote/accounts/fill${q({ device })}`, {
      method: "POST",
      body: JSON.stringify({
        account_id: accountId,
        field,
        submit: opts?.submit ?? false,
        pause_ms: opts?.pauseMs ?? 280,
      }),
    }),
  remoteKeyevent: (device: string, keycode: number, longpress = false) =>
    request<{ ok: boolean; keycode: number; longpress?: boolean }>(
      `/remote/keyevent${q({ device })}`,
      { method: "POST", body: JSON.stringify({ keycode, longpress }) },
    ),
  remoteStayAwake: (device: string, enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>(
      `/remote/stay-awake${q({ device })}`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    ),
  remotePreview: (device: string, maxSide = 720) =>
    request<{
      ok: boolean;
      mime: string;
      jpeg_base64: string;
      width: number;
      height: number;
    }>(`/remote/preview${q({ device, max_side: maxSide })}`),
  scrcpyStatus: (device: string) =>
    request<{
      available: boolean;
      running: boolean;
      embed_available?: boolean;
      embed_reason?: string;
      embed_running?: boolean;
      recording?: boolean;
      record_path?: string;
      device: string;
    }>(`/remote/scrcpy/status${q({ device })}`),
  scrcpyStart: (device: string, maxSize = 0) =>
    request<{ ok: boolean; message: string; pid?: number }>(
      `/remote/scrcpy/start${q({ device, max_size: maxSize })}`,
      { method: "POST" },
    ),
  scrcpyStop: (device: string, keepRecord = false) =>
    request<{ ok: boolean; message: string; recording?: boolean }>(
      `/remote/scrcpy/stop${q({
        device,
        keep_record: keepRecord || undefined,
      })}`,
      { method: "POST" },
    ),
  scrcpyRecordStart: (device: string) =>
    request<{
      ok: boolean;
      already?: boolean;
      path: string;
      message: string;
      device: string;
    }>(`/remote/scrcpy/record/start${q({ device })}`, { method: "POST" }),
  scrcpyRecordStop: (device: string) =>
    request<{
      ok: boolean;
      stopped?: boolean;
      path: string;
      frames?: number;
      message: string;
      device: string;
    }>(`/remote/scrcpy/record/stop${q({ device })}`, { method: "POST" }),
  scrcpyRecordStatus: (device: string) =>
    request<{
      device: string;
      recording: boolean;
      path: string;
      embed_running: boolean;
    }>(`/remote/scrcpy/record/status${q({ device })}`),
  /** 内嵌 scrcpy WebSocket 路径（相对 wsBase） */
  scrcpyEmbedWsPath: (device: string, maxSide = 960) =>
    `/remote/scrcpy/embed/ws${q({ device, max_side: maxSide })}`,

  emmcSteps: () =>
    request<{ steps: Array<{ id: string; label: string }> }>("/emmc/steps"),
  emmcDirs: () =>
    request<{ reports_dir: string; logs_dir: string }>("/emmc/dirs"),
  emmcReport: (flowNo: string) =>
    request<{
      flow_no: string;
      path: string;
      exists: boolean;
      reports_dir: string;
      header: Record<string, string | boolean>;
      feishu_report_url?: string;
    }>(`/emmc/report${q({ flow_no: flowNo })}`),
  emmcSaveReportHeader: (body: {
    flow_no: string;
    import_project: string;
    internal_model?: string;
    emmc_brand?: string;
    emmc_capacity_gb?: string;
    read_speed_mbs?: string;
    write_speed_mbs?: string;
    emmc_model?: string;
    sw_test_userdebug?: string;
    emmc_spec?: string;
    gota_version?: string;
    tester?: string;
    test_time?: string;
    initial_result?: string;
    remarks?: string;
    ab_upgrade?: boolean;
  }) =>
    request<{
      ok: boolean;
      created: boolean;
      path: string;
      message: string;
    }>("/emmc/report/header", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  emmcStart: (
    device: string,
    steps: string[],
    flowNo = "1",
    params?: {
      loop_num?: number | null;
      stress_max_run_minutes?: number | null;
      iozone_file_size_mb?: number | null;
      samsung_emmc?: boolean | null;
      iozone_write_min_mbs?: number | null;
      iozone_read_min_mbs?: number | null;
      reboot_run_hours?: number | null;
      reboot_boot_timeout_sec?: number | null;
      reboot_count?: number | null;
      rpmb_run_minutes?: number | null;
      ota_upgrade_count?: number | null;
      ota_file_path?: string | null;
      ota_retry_limit?: number | null;
      ota_max_run_minutes?: number | null;
      ota_timeout_minutes?: number | null;
      ota_round_interval_minutes?: number | null;
    },
    stopOnFail = false,
  ) =>
    request<{
      job_id: string;
      report_path: string;
      feishu_report_url?: string;
      feishu_report_warn?: string;
    }>("/emmc/jobs", {
      method: "POST",
      body: JSON.stringify({
        device,
        steps,
        flow_no: flowNo,
        stop_on_fail: stopOnFail,
        params: params || {},
      }),
    }),
  emmcStatus: (jobId: string, since?: number) =>
    request<{
      job_id: string;
      running: boolean;
      ok: boolean | null;
      error: string;
      logs: string[];
      log_cursor: number;
      report_path: string;
      feishu_report_url?: string;
      current_step?: string;
      step_results?: Record<string, string>;
      step_progress?: Record<
        string,
        { current: number; total: number; text: string }
      >;
      progress_current?: number;
      progress_total?: number;
      progress_text?: string;
      steps_done?: number;
      steps_total?: number;
    }>(`/emmc/jobs/${encodeURIComponent(jobId)}${q({ since })}`, {
      timeoutMs: 6000,
    }),
  emmcStop: (jobId: string) =>
    request<{ ok: boolean }>(`/emmc/jobs/${jobId}/stop`, { method: "POST" }),
  emmcFeishuConfig: (flowNo = "") =>
    request<{
      app_id: string;
      has_secret: boolean;
      template_url: string;
      notify_enabled: boolean;
      user_open_id: string;
      user_name: string;
      user_logged_in: boolean;
      flow_report_url: string;
      synced_exists: boolean;
      synced_path: string;
      synced_mtime: string;
    }>(`/emmc/feishu/config${q({ flow_no: flowNo })}`),
  emmcSaveFeishuConfig: (body: {
    app_id?: string;
    app_secret?: string;
    template_url?: string;
    flow_no?: string;
    report_url?: string;
    notify_enabled?: boolean;
  }) =>
    request<{
      app_id: string;
      has_secret: boolean;
      template_url: string;
      notify_enabled: boolean;
      user_open_id: string;
      user_name: string;
      user_logged_in: boolean;
      flow_report_url: string;
      synced_exists: boolean;
      synced_path: string;
      synced_mtime: string;
    }>("/emmc/feishu/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  emmcFeishuOAuthUrl: (appId = "") =>
    request<{ url: string; redirect_uri: string }>(
      `/emmc/feishu/oauth/url${q({ app_id: appId })}`,
    ),
  emmcFeishuLogout: (flowNo = "") =>
    request<{
      user_open_id: string;
      user_name: string;
      user_logged_in: boolean;
    }>(`/emmc/feishu/logout${q({ flow_no: flowNo })}`, { method: "POST" }),
  emmcTestFeishu: (body: {
    app_id?: string;
    app_secret?: string;
    template_url?: string;
  }) =>
    request<{ ok: boolean; message: string; title?: string }>(
      "/emmc/feishu/test",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  emmcCopyFeishuTemplate: (body: {
    app_id?: string;
    app_secret?: string;
    template_url?: string;
    flow_no?: string;
    report_name?: string;
  }) =>
    request<{
      ok: boolean;
      url: string;
      spreadsheet_token: string;
      name: string;
      flow_report_url: string;
    }>("/emmc/feishu/copy-template", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  emmcSyncFeishuReport: (body: {
    app_id?: string;
    app_secret?: string;
    flow_no?: string;
    report_url?: string;
    notify_enabled?: boolean;
  }) =>
    request<{
      ok: boolean;
      url: string;
      spreadsheet_token: string;
      updated_cells: number;
      flow_report_url: string;
      notified?: string;
      notify_error?: string;
    }>("/emmc/feishu/sync-report", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  emmcTestFeishuNotify: (body: {
    app_id?: string;
    app_secret?: string;
    flow_no?: string;
    report_url?: string;
  }) =>
    request<{ ok: boolean; tester: string; message_id: string }>(
      "/emmc/feishu/test-notify",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  emmcSyncFeishuTemplate: (body: {
    app_id?: string;
    app_secret?: string;
    template_url?: string;
  }) =>
    request<{
      ok: boolean;
      app_id: string;
      has_secret: boolean;
      template_url: string;
      synced_exists: boolean;
      synced_path: string;
      synced_mtime: string;
      title?: string;
    }>("/emmc/feishu/sync-template", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  emmcResetFeishuTemplate: () =>
    request<{
      ok: boolean;
      synced_exists: boolean;
      synced_path: string;
      synced_mtime: string;
    }>("/emmc/feishu/synced-template", { method: "DELETE" }),
  emmcFeishuFolderUrl: () =>
    request<{ url: string }>("/emmc/feishu/folder-url"),
  emmcCopyFlowLocalToFeishu: (flowNo: string) =>
    request<{
      url: string;
      spreadsheet_token: string;
      notified: string;
      notify_error: string;
    }>("/emmc/feishu/copy-flow-local-report", {
      method: "POST",
      body: JSON.stringify({ flow_no: flowNo }),
    }),
  emmcTideOaStatus: () =>
    request<{
      base_url: string;
      ws_id: string;
      user_name: string;
      email: string;
      logged_in: boolean;
    }>("/emmc/tide-oa/status"),
  emmcTideOaSaveToken: (token: string, wsId = "2") =>
    request<{
      base_url: string;
      ws_id: string;
      user_name: string;
      email: string;
      logged_in: boolean;
    }>("/emmc/tide-oa/token", {
      method: "POST",
      body: JSON.stringify({ token, ws_id: wsId }),
    }),
  emmcTideOaLogout: () =>
    request<{
      base_url: string;
      ws_id: string;
      user_name: string;
      email: string;
      logged_in: boolean;
    }>("/emmc/tide-oa/logout", { method: "POST" }),
  emmcTideOaFetchFlow: (flowNo: string) =>
    request<{
      ok: boolean;
      flow_no: string;
      apply_id: string;
      header: Record<string, string>;
    }>(`/emmc/tide-oa/flow/${encodeURIComponent(flowNo)}`),
  emmcCopyLocalReportToFeishu: (file: File, flowNo = "") => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{
      url: string;
      spreadsheet_token: string;
      notified: string;
      notify_error: string;
    }>(`/emmc/feishu/copy-local-report${q({ flow_no: flowNo || undefined })}`, {
      method: "POST",
      body: fd,
    });
  },

  apkAnalyze: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<ApkAnalyzeResponse>("/adb/device/apk/analyze", {
      method: "POST",
      body: fd,
    });
  },
  apkCompare: (device: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<ApkCompareResponse>(
      `/adb/device/apk/compare${q({ device })}`,
      { method: "POST", body: fd },
    );
  },
};
