import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../../errors";
import { api } from "../../api/client";
import { Button, EmptyState } from "../../ui";

type Props = {
  deviceSn: string;
  snOk: boolean;
  active: boolean;
  onStatus: (msg: string | ((prev: string) => string)) => void;
};

type FieldDef = { key: string; label: string; mono?: boolean };
type DetailSection = { title: string; rows: FieldDef[] };

const COPY_FIELDS: FieldDef[] = [
  { key: "model", label: "型号" },
  { key: "brand", label: "品牌" },
  { key: "manufacturer", label: "厂商" },
  { key: "board", label: "Board" },
  { key: "device", label: "Device" },
  { key: "product", label: "Product" },
  { key: "hardware", label: "硬件" },
  { key: "serial", label: "序列号" },
  { key: "version", label: "软件版本" },
  { key: "incremental", label: "内部版本" },
  { key: "android", label: "Android" },
  { key: "sdk", label: "SDK" },
  { key: "security_patch", label: "安全补丁" },
  { key: "build_type", label: "构建类型" },
  { key: "build_tags", label: "构建标签" },
  { key: "build_id", label: "Build ID" },
  { key: "abi", label: "ABI" },
  { key: "abi_list", label: "ABI 列表" },
  { key: "ddr", label: "DDR" },
  { key: "emmc", label: "eMMC" },
  { key: "emmc_free", label: "eMMC 剩余" },
  { key: "emmc_pct", label: "eMMC 占用" },
  { key: "display", label: "分辨率" },
  { key: "density", label: "密度" },
  { key: "locale", label: "语言区域" },
  { key: "timezone", label: "时区" },
  { key: "bootloader", label: "Bootloader" },
  { key: "ip", label: "IP" },
  { key: "fingerprint", label: "Fingerprint" },
];

/** 明细分区（速览指标已展示的值会再过滤） */
const DETAIL_SECTIONS: DetailSection[] = [
  {
    title: "基本信息",
    rows: [
      { key: "model", label: "型号" },
      { key: "brand", label: "品牌" },
      { key: "manufacturer", label: "厂商" },
      { key: "android", label: "Android" },
      { key: "sdk", label: "SDK" },
      { key: "build_type", label: "构建类型" },
      { key: "build_tags", label: "构建标签", mono: true },
      { key: "version", label: "软件版本", mono: true },
      { key: "serial", label: "序列号", mono: true },
    ],
  },
  {
    title: "产品标识",
    rows: [
      { key: "board", label: "Board", mono: true },
      { key: "device", label: "Device", mono: true },
      { key: "product", label: "Product", mono: true },
      { key: "hardware", label: "硬件" },
      { key: "abi", label: "ABI", mono: true },
      { key: "abi_list", label: "ABI 列表", mono: true },
    ],
  },
  {
    title: "构建信息",
    rows: [
      { key: "incremental", label: "内部版本", mono: true },
      { key: "build_id", label: "Build ID", mono: true },
      { key: "security_patch", label: "安全补丁" },
      { key: "fingerprint", label: "Fingerprint", mono: true },
    ],
  },
  {
    title: "显示与区域",
    rows: [
      { key: "display", label: "分辨率", mono: true },
      { key: "density", label: "密度" },
      { key: "locale", label: "语言区域" },
      { key: "timezone", label: "时区", mono: true },
    ],
  },
  {
    title: "其它",
    rows: [{ key: "bootloader", label: "Bootloader", mono: true }],
  },
];

function trimVal(v: string | undefined): string {
  return (v || "").trim();
}

function fieldValue(
  info: Record<string, string>,
  key: string,
  deviceSn = "",
): string {
  const v = trimVal(info[key]);
  if (v) return v;
  if (key === "serial") return trimVal(deviceSn);
  return "";
}

function norm(v: string | undefined): string {
  return trimVal(v).toLowerCase();
}

function same(a: string | undefined, b: string | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && x === y);
}

function containsNorm(hay: string | undefined, needle: string | undefined): boolean {
  const h = norm(hay);
  const n = norm(needle);
  return Boolean(h && n && n.length >= 2 && h.includes(n));
}

/** 速览（DDR/eMMC/IP）已展示的值，明细中不再出现 */
function summaryValues(info: Record<string, string>): Set<string> {
  const keys = ["ddr", "emmc", "emmc_free", "emmc_pct", "ip"];
  const set = new Set<string>();
  for (const k of keys) {
    const v = norm(info[k]);
    if (v) set.add(v);
  }
  return set;
}

function shouldShowDetail(
  key: string,
  info: Record<string, string>,
  shown: Set<string>,
  deviceSn: string,
): boolean {
  const val = fieldValue(info, key, deviceSn);
  if (!val) return false;
  const n = norm(val);
  if (shown.has(n)) return false;

  const ver = info.version;
  const bid = info.build_id;
  const inc = info.incremental;
  const model = info.model;
  const device = info.device;
  const product = info.product;
  const hardware = info.hardware;
  const board = info.board;
  const abi = info.abi;

  if (key === "brand" && same(val, model)) return false;
  if (
    key === "manufacturer" &&
    (same(val, model) || same(val, info.brand))
  ) {
    return false;
  }
  if (key === "build_id") {
    if (same(bid, ver) || containsNorm(ver, bid) || containsNorm(bid, ver)) {
      return false;
    }
  }
  if (key === "incremental") {
    if (
      same(inc, ver) ||
      same(inc, bid) ||
      containsNorm(ver, inc) ||
      containsNorm(bid, inc)
    ) {
      return false;
    }
  }
  if (
    key === "device" ||
    key === "product" ||
    key === "hardware" ||
    key === "board"
  ) {
    if (
      same(val, model) ||
      same(val, info.brand) ||
      same(val, info.manufacturer)
    ) {
      return false;
    }
  }
  if (key === "product" && same(product, device)) return false;
  if (key === "board" && (same(board, device) || same(board, product))) {
    return false;
  }
  if (
    key === "hardware" &&
    (same(hardware, device) ||
      same(hardware, product) ||
      same(hardware, board))
  ) {
    return false;
  }
  if (key === "abi_list") {
    if (
      same(val, abi) ||
      (containsNorm(val, abi) && !val.includes(","))
    ) {
      return false;
    }
  }
  if (key === "build_tags" && same(val, info.build_type)) return false;
  if (key === "fingerprint" && (same(val, ver) || same(val, bid))) return false;
  if (key === "bootloader") {
    const junk = new Set(["unknown", "n/a", "na", "none", "0"]);
    if (junk.has(n)) return false;
  }

  return true;
}

export default function InfoPanel({ deviceSn, snOk, active, onStatus }: Props) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Record<string, string>>({});
  const [props, setProps] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const loadGen = useRef(0);

  const pushStatus = useCallback((msg: string) => {
    setFlash(msg);
    onStatusRef.current(msg);
  }, []);

  const loadedSn = useRef("");

  const loadInfo = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!snOk || !deviceSn) return;
      const gen = ++loadGen.current;
      setBusy(true);
      setError("");
      if (!opts?.quiet) pushStatus("读取设备信息…");
      try {
        const data = await api.deviceInfo(deviceSn);
        if (gen !== loadGen.current) return;
        setInfo(data.info || {});
        setProps(data.props || {});
        setLoaded(true);
        loadedSn.current = deviceSn;
        if (!opts?.quiet) pushStatus("设备信息已更新");
      } catch (e) {
        if (gen !== loadGen.current) return;
        const msg = toErrorMessage(e);
        setError(msg);
        pushStatus(msg);
      } finally {
        if (gen === loadGen.current) setBusy(false);
      }
    },
    [deviceSn, pushStatus, snOk],
  );

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(""), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!snOk) loadedSn.current = "";
  }, [snOk]);

  useEffect(() => {
    if (!active || !snOk || !deviceSn) return;
    if (loadedSn.current === deviceSn) return;
    // 延后一拍再请求，避免与重连时的实时流/开发模式双挂载叠在一起卡顿。
    const timer = window.setTimeout(() => {
      void loadInfo();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active, snOk, deviceSn, loadInfo]);

  const metrics = useMemo(() => {
    const items: {
      key: string;
      label: string;
      value: string;
      hint?: string;
      pct?: number;
      primary?: boolean;
      empty?: boolean;
    }[] = [];
    const ddr = trimVal(info.ddr);
    const emmc = trimVal(info.emmc);
    const emmcFree = trimVal(info.emmc_free);
    const emmcPct = trimVal(info.emmc_pct);
    const pctNum = Number(info.emmc_pct_num || "");
    const ip = trimVal(info.ip);
    items.push({
      key: "ddr",
      label: "DDR",
      value: ddr || "—",
      primary: true,
      empty: !ddr,
    });
    const emmcHint = [emmc ? `共 ${emmc}` : "", emmcPct]
      .filter(Boolean)
      .join(" · ");
    items.push({
      key: "emmc",
      label: "eMMC 剩余",
      value: emmcFree || "—",
      hint: emmcHint || undefined,
      pct: Number.isFinite(pctNum) && pctNum >= 0 ? pctNum : undefined,
      primary: true,
      empty: !emmcFree && !emmc,
    });
    if (ip) items.push({ key: "ip", label: "IP", value: ip });
    return items;
  }, [info.ddr, info.emmc, info.emmc_free, info.emmc_pct, info.emmc_pct_num, info.ip]);

  const detailSections = useMemo(() => {
    const shown = summaryValues(info);
    const sections: Array<{ title: string; rows: FieldDef[] }> = [];
    for (const sec of DETAIL_SECTIONS) {
      const rows: FieldDef[] = [];
      for (const row of sec.rows) {
        if (!shouldShowDetail(row.key, info, shown, deviceSn)) continue;
        const n = norm(fieldValue(info, row.key, deviceSn));
        shown.add(n);
        rows.push(row);
      }
      if (rows.length) sections.push({ title: sec.title, rows });
    }
    return sections;
  }, [info, deviceSn]);

  async function copyText(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushStatus(okMsg);
      return;
    } catch {
      /* Electron / 权限不足时走后备 */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      pushStatus(ok ? okMsg : "复制失败");
    } catch {
      pushStatus("复制失败");
    }
  }

  function copyAll() {
    const lines: string[] = [`# device ${deviceSn}`, ""];
    const seen = new Set<string>();
    for (const row of COPY_FIELDS) {
      const val =
        row.key === "serial"
          ? fieldValue(info, "serial", deviceSn)
          : trimVal(info[row.key]);
      if (!val) continue;
      const n = norm(val);
      // 复制清单也去重：同值只出现一次（保留靠前的标签）
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(`${row.label}: ${val}`);
    }
    if (Object.keys(props).length) {
      lines.push("", "# raw getprop");
      for (const [k, v] of Object.entries(props)) {
        lines.push(`${k}=${v}`);
      }
    }
    void copyText(lines.join("\n"), "已复制全部");
  }

  function copyField(key: string, label: string) {
    if (key === "emmc") {
      const parts = [
        trimVal(info.emmc_free) ? `剩余 ${trimVal(info.emmc_free)}` : "",
        trimVal(info.emmc) ? `共 ${trimVal(info.emmc)}` : "",
        trimVal(info.emmc_pct),
      ].filter(Boolean);
      if (!parts.length) return;
      void copyText(parts.join(" · "), `已复制${label}`);
      return;
    }
    const raw = fieldValue(info, key, deviceSn);
    if (!raw) return;
    void copyText(raw, `已复制${label}`);
  }

  if (!snOk) {
    return (
      <EmptyState
        className="info-empty"
        title="未绑定设备"
        description="打开设备会话后可查看型号、软件版本、DDR / eMMC 等信息。"
      />
    );
  }

  return (
    <div className="info-panel">
      {error ? <div className="banner-err info-banner">{error}</div> : null}

      {!loaded && busy ? (
        <EmptyState
          className="info-empty"
          title="读取中…"
          description="正在通过 adb 拉取设备属性。"
        />
      ) : null}

      {loaded ? (
        <div className="info-card">
          <header className="info-head">
            <div className="info-title-row">
              <div className="info-title-block">
                <strong className="info-model">设备信息</strong>
                {flash ? <span className="info-flash">{flash}</span> : null}
              </div>
              <div className="info-head-actions">
                <Button size="sm" disabled={busy} onClick={() => void loadInfo()}>
                  刷新
                </Button>
                <Button size="sm" disabled={!loaded || busy} onClick={() => void copyAll()}>
                  复制
                </Button>
              </div>
            </div>
          </header>

          {metrics.length ? (
            <div
              className="info-metrics"
              role="group"
              aria-label="关键指标"
            >
              {metrics.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`info-metric${m.primary ? " primary" : ""}${
                    m.empty ? " is-empty" : ""
                  }`}
                  title={
                    m.empty
                      ? `${m.label} 未读到`
                      : `点击复制${m.label}`
                  }
                  disabled={Boolean(m.empty)}
                  onClick={() => copyField(m.key, m.label)}
                >
                  <span className="info-metric-label">{m.label}</span>
                  <span className="info-metric-value mono">{m.value}</span>
                  {m.hint ? (
                    <span className="info-metric-hint">{m.hint}</span>
                  ) : null}
                  {typeof m.pct === "number" ? (
                    <span className="info-metric-bar" aria-hidden>
                      <span
                        className="info-metric-bar-fill"
                        style={{ width: `${Math.max(2, Math.min(100, m.pct))}%` }}
                      />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {detailSections.length ? (
            <div className="info-detail-wrap">
              {detailSections.map((sec) => (
                <section key={sec.title} className="info-section">
                  <h3 className="info-section-title">{sec.title}</h3>
                  <dl className="info-detail">
                    {sec.rows.map((row) => {
                      const raw = fieldValue(info, row.key, deviceSn);
                      return (
                        <button
                          key={row.key}
                          type="button"
                          className={`info-row${
                            row.key === "fingerprint" ||
                            row.key === "version" ||
                            row.key === "serial" ||
                            row.key === "incremental" ||
                            row.key === "build_id" ||
                            row.key === "abi_list"
                              ? " is-wide"
                              : ""
                          }`}
                          title={`点击复制${row.label}`}
                          onClick={() => copyField(row.key, row.label)}
                        >
                          <dt>{row.label}</dt>
                          <dd className={row.mono ? "mono" : undefined}>
                            <span title={raw}>{raw}</span>
                          </dd>
                        </button>
                      );
                    })}
                  </dl>
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
