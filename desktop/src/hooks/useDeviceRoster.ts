import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DeviceRow, type DevicesResponse } from "../api/client";
import { useStatusNotify } from "../components/toast";
import { readAppPrefs, subscribeAppPrefs } from "../appPrefs";
import { toErrorMessage } from "../errors";
import {
  deviceSelectOptions,
  mergeDeviceList,
  pendingDeviceRows,
  retainDeviceSelection,
  sameDeviceRows,
} from "../adbDevices";

/**
 * 设备页 / eMMC / Monkey 共用的在线列表。
 * 只在页面可见时轮询；列表内容没变时保持原数组。
 */
export function useDeviceRoster(pageActive: boolean) {
  const [devices, setDevices] = useState<string[]>([]);
  const [deviceRows, setDeviceRows] = useState<DeviceRow[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pollMs, setPollMs] = useState(() => readAppPrefs().devicePollMs);
  const setStatus = useStatusNotify();
  const pickingRef = useRef(false);
  const pollInFlightRef = useRef(false);

  const applySnapshot = useCallback(
    (snap: DevicesResponse) => {
      setDevices((prev) => mergeDeviceList(prev, snap.devices));
      setDeviceRows((prev) => {
        const next = Array.isArray(snap.rows) ? snap.rows : [];
        return sameDeviceRows(prev, next) ? prev : next;
      });
      if (!pickingRef.current) {
        setSelected((prev) => {
          const next = retainDeviceSelection(prev, snap.devices);
          return next === prev ? prev : next;
        });
      }
      if (snap.message) {
        setStatus((prev) => (prev === snap.message ? prev : snap.message));
      }
      if (!snap.adb_available) {
        const msg = snap.message || "adb 不可用";
        setError((prev) => (prev === msg ? prev : msg));
      } else if (
        !(snap.devices || []).length &&
        (snap.rows || []).some((row) => (row.state || "") !== "device")
      ) {
        const msg =
          snap.message || "设备已连接但未就绪，请在电视上允许 USB 调试";
        setError((prev) => (prev === msg ? prev : msg));
      } else {
        setError((prev) => (prev ? "" : prev));
      }
    },
    [setStatus],
  );

  const refresh = useCallback(async () => {
    pickingRef.current = false;
    setBusy(true);
    try {
      applySnapshot(await api.refresh());
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [applySnapshot]);

  useEffect(() => subscribeAppPrefs((p) => setPollMs(p.devicePollMs)), []);

  useEffect(() => {
    if (!pageActive) return;
    let cancelled = false;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void pollOnce();
      }, pollMs);
    };

    const pollOnce = async () => {
      if (cancelled || document.hidden || pollInFlightRef.current) {
        schedule();
        return;
      }
      pollInFlightRef.current = true;
      try {
        const snap = await api.devices();
        if (!cancelled) applySnapshot(snap);
      } catch {
        /* 轮询失败留给下一次 */
      } finally {
        pollInFlightRef.current = false;
        schedule();
      }
    };

    const onVisibility = () => {
      if (!document.hidden && !cancelled) {
        void pollOnce();
      }
    };

    void refresh().finally(schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pageActive, refresh, applySnapshot, pollMs]);

  const onlineSet = useMemo(() => new Set(devices), [devices]);
  const deviceOptions = useMemo(
    () => deviceSelectOptions(devices, selected),
    [devices, selected],
  );
  const pendingRows = useMemo(
    () => pendingDeviceRows(deviceRows, devices),
    [deviceRows, devices],
  );

  const beginPick = useCallback(() => {
    pickingRef.current = true;
  }, []);
  const endPick = useCallback(() => {
    pickingRef.current = false;
  }, []);
  const choose = useCallback((sn: string) => {
    setSelected(sn);
    pickingRef.current = false;
  }, []);

  return {
    devices,
    selected,
    setSelected,
    error,
    setError,
    busy,
    setBusy,
    onlineSet,
    deviceOptions,
    pendingRows,
    refresh,
    applySnapshot,
    setStatus,
    beginPick,
    endPick,
    choose,
  };
}
