import { useEffect, useMemo, useState } from "react";
import type {
  ApkAnalyzeInfo,
  ApkCompareInfo,
  ApkIntentFilterInfo,
} from "../api/client";
import Modal from "./Modal";

export type ApkAnalyzeView = {
  info: ApkAnalyzeInfo;
  compare?: ApkCompareInfo | null;
  /** 后端生成的完整对比报告文本 */
  compareReport?: string;
  /** 后端生成的完整分析报告文本 */
  report?: string;
};

type Props = {
  open: boolean;
  results: ApkAnalyzeView[];
  activeIndex?: number;
  onClose: () => void;
  /** 复制成功后的状态提示文案 */
  onCopySummary?: (message: string) => void;
};

type TabId = "compare" | "perms" | "intents" | "comps";

const DANGEROUS = new Set([
  "android.permission.READ_CALENDAR",
  "android.permission.WRITE_CALENDAR",
  "android.permission.CAMERA",
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.GET_ACCOUNTS",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_PHONE_NUMBERS",
  "android.permission.CALL_PHONE",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.ADD_VOICEMAIL",
  "android.permission.USE_SIP",
  "android.permission.PROCESS_OUTGOING_CALLS",
  "android.permission.BODY_SENSORS",
  "android.permission.BODY_SENSORS_BACKGROUND",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_WAP_PUSH",
  "android.permission.RECEIVE_MMS",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.ACTIVITY_RECOGNITION",
  "android.permission.ACCESS_MEDIA_LOCATION",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.UWB_RANGING",
  "android.permission.RANGING",
]);

const SPECIAL = new Set([
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_SETTINGS",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.SCHEDULE_EXACT_ALARM",
  "android.permission.USE_EXACT_ALARM",
  "android.permission.ACCESS_NOTIFICATION_POLICY",
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.MANAGE_MEDIA",
  "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
  "android.permission.CAPTURE_VIDEO_OUTPUT",
  "android.permission.CAPTURE_AUDIO_OUTPUT",
  "android.permission.MEDIA_CONTENT_CONTROL",
]);

function classifyLocal(perms: string[]) {
  const auto: string[] = [];
  const runtime: string[] = [];
  const special: string[] = [];
  for (const raw of perms) {
    const p = raw.trim();
    if (!p) continue;
    if (SPECIAL.has(p)) special.push(p);
    else if (DANGEROUS.has(p)) runtime.push(p);
    else auto.push(p);
  }
  return {
    auto: auto.slice().sort(),
    runtime: runtime.slice().sort(),
    special: special.slice().sort(),
  };
}

function resolvePermBuckets(info: ApkAnalyzeInfo) {
  const hasBuckets =
    info.permissions_auto != null ||
    info.permissions_runtime != null ||
    info.permissions_special != null;
  if (hasBuckets) {
    return {
      auto: info.permissions_auto || [],
      runtime: info.permissions_runtime || [],
      special: info.permissions_special || [],
    };
  }
  return classifyLocal(info.permissions || []);
}

function formatIntentData(d: {
  scheme?: string;
  host?: string;
  port?: string;
  path?: string;
  pathPrefix?: string;
  pathPattern?: string;
  mimeType?: string;
}): string {
  const parts: string[] = [];
  if (d.scheme || d.host || d.port || d.path || d.pathPrefix || d.pathPattern) {
    let uri = d.scheme || "*";
    if (d.host) {
      uri += "://" + d.host;
      if (d.port) uri += ":" + d.port;
    } else if (d.scheme) {
      uri += ":";
    }
    const path = d.path || d.pathPrefix || d.pathPattern;
    if (path) uri += path;
    parts.push(uri);
  }
  if (d.mimeType) parts.push(`type=${d.mimeType}`);
  return parts.join(" ");
}

function verdictClass(kind?: string): string {
  switch (kind) {
    case "upgrade":
    case "fresh":
      return "ok";
    case "same":
      return "same";
    case "downgrade":
    case "error":
      return "bad";
    default:
      return "muted";
  }
}

function formatPermGroup(title: string, items: string[]): string {
  if (!items.length) return "";
  return [`## ${title} (${items.length})`, ...items.map((p) => p)].join("\n");
}

function buildPermsText(info: ApkAnalyzeInfo): string {
  const buckets = resolvePermBuckets(info);
  const parts = [
    `# 声明权限 · ${info.package || ""}`,
    formatPermGroup("系统默认授予", buckets.auto),
    formatPermGroup("需运行时授权", buckets.runtime),
    formatPermGroup("需特殊授权", buckets.special),
  ].filter(Boolean);
  return parts.join("\n\n");
}

function buildCompareText(info: ApkAnalyzeInfo, cmp: ApkCompareInfo): string {
  const lines = [
    `# 设备对比 · ${cmp.package || info.package || ""}`,
    `结论: ${cmp.verdict || "—"}`,
  ];
  if (cmp.installed) {
    lines.push(
      `设备版本: ${[cmp.device_version_name || "", cmp.device_version_code ? `(${cmp.device_version_code})` : ""].filter(Boolean).join(" ") || "—"}`,
    );
    lines.push(
      `新包版本: ${[cmp.apk_version_name || info.version_name || "", (cmp.apk_version_code || info.version_code) ? `(${cmp.apk_version_code || info.version_code})` : ""].filter(Boolean).join(" ") || "—"}`,
    );
  } else {
    lines.push("设备尚未安装该包");
  }
  const groups = [
    formatPermGroup("系统默认已授予", cmp.install_granted || []),
    formatPermGroup("运行时已授予", cmp.runtime_granted || []),
    formatPermGroup("运行时未授予", cmp.runtime_denied || []),
    formatPermGroup("新包多出", cmp.perms_added || []),
    formatPermGroup("新包少了", cmp.perms_removed || []),
  ].filter(Boolean);
  if (groups.length) {
    lines.push("", "# 权限对比", ...groups.flatMap((g, i) => (i ? ["", g] : [g])));
  }
  return lines.join("\n");
}

function buildIntentsText(info: ApkAnalyzeInfo): string {
  const intents = info.intent_filters || [];
  const lines = [`# Intent Filter · ${info.package || ""} (${intents.length})`];
  if (!intents.length) {
    lines.push("(无)");
    return lines.join("\n");
  }
  intents.forEach((it, i) => {
    lines.push("");
    lines.push(`[${i + 1}] ${it.component_kind || "component"} ${it.component || "?"}`);
    if (it.exported != null) lines.push(`exported: ${it.exported}`);
    if ((it.actions || []).length) {
      lines.push("actions:");
      lines.push(...(it.actions || []).map((a) => `  ${a}`));
    }
    if ((it.categories || []).length) {
      lines.push("categories:");
      lines.push(...(it.categories || []).map((c) => `  ${c}`));
    }
    const data = (it.data || []).map(formatIntentData).filter(Boolean);
    if (data.length) {
      lines.push("data:");
      lines.push(...data.map((d) => `  ${d}`));
    }
  });
  return lines.join("\n");
}

function buildCompsText(info: ApkAnalyzeInfo): string {
  const sections: [string, { name: string; exported?: boolean | null; intent_filters?: ApkIntentFilterInfo[] }[]][] = [
    ["Activity", info.activities || []],
    ["Service", info.services || []],
    ["Receiver", info.receivers || []],
    ["Provider", info.providers || []],
  ];
  const lines = [`# 组件 · ${info.package || ""}`];
  for (const [title, items] of sections) {
    lines.push("");
    lines.push(`## ${title} (${items.length})`);
    if (!items.length) {
      lines.push("(无)");
      continue;
    }
    for (const c of items) {
      const tags = [
        c.exported == null ? "" : c.exported ? "exported" : "private",
        (c.intent_filters || []).length ? `intent×${(c.intent_filters || []).length}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(tags ? `${c.name}  [${tags}]` : c.name);
    }
  }
  return lines.join("\n");
}

function resolveCompareText(view: ApkAnalyzeView): string {
  if (view.compareReport?.trim()) return view.compareReport.trim();
  if (view.compare) return buildCompareText(view.info, view.compare);
  return "";
}

async function copyText(text: string, onDone?: (msg: string) => void, msg = "已复制") {
  if (!text.trim()) {
    onDone?.("没有可复制内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    onDone?.(msg);
  } catch {
    onDone?.("复制失败");
  }
}

function PermGroup({
  title,
  note,
  items,
  tone,
}: {
  title: string;
  note: string;
  items: string[];
  tone: string;
}) {
  if (!items.length) return null;
  return (
    <div className={`apk-pg tone-${tone}`}>
      <div className="apk-pg-head">
        <strong>{title}</strong>
        <span>{items.length}</span>
      </div>
      <p className="apk-pg-note">{note}</p>
      <ul className="apk-pg-list">
        {items.map((p) => (
          <li key={p} title={p}>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="apk-empty">{text}</div>;
}

export default function ApkAnalyzeModal({
  open,
  results,
  activeIndex = 0,
  onClose,
  onCopySummary,
}: Props) {
  const [idx, setIdx] = useState(activeIndex);
  const [tab, setTab] = useState<TabId>("perms");

  useEffect(() => {
    if (!open) return;
    setIdx(activeIndex);
    setTab(results[activeIndex]?.compare ? "compare" : "perms");
  }, [open, activeIndex, results]);

  const safeIdx = Math.min(Math.max(idx, 0), Math.max(results.length - 1, 0));
  const view = results[safeIdx];

  const title = useMemo(() => {
    if (results.length <= 1) return "APK 分析结果";
    return `APK 分析结果（${safeIdx + 1}/${results.length}）`;
  }, [results.length, safeIdx]);

  const doCopy = (text: string, msg: string) => {
    void copyText(text, onCopySummary, msg);
  };

  if (!open || !view) return null;
  const info = view.info;
  const cmp = view.compare;
  const buckets = resolvePermBuckets(info);
  const intents = info.intent_filters || [];
  const activities = info.activities || [];
  const services = info.services || [];
  const receivers = info.receivers || [];
  const providers = info.providers || [];
  const comps = [
    ...activities.map((c) => ({ ...c, _kind: c.kind || "activity" })),
    ...services.map((c) => ({ ...c, _kind: c.kind || "service" })),
    ...receivers.map((c) => ({ ...c, _kind: c.kind || "receiver" })),
    ...providers.map((c) => ({ ...c, _kind: c.kind || "provider" })),
  ];

  const copyCurrentTab = () => {
    if (tab === "compare") doCopy(resolveCompareText(view), "已复制对比");
    else if (tab === "perms") doCopy(buildPermsText(info), "已复制权限");
    else if (tab === "intents") doCopy(buildIntentsText(info), "已复制 Intent");
    else doCopy(buildCompsText(info), "已复制组件");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      className="apk-result-modal"
      title={
        <div className="apk-result-title">
          <strong>{title}</strong>
          {info.filename ? <span className="apk-result-file">{info.filename}</span> : null}
        </div>
      }
      footer={
        <>
          {results.length > 1 ? (
            <div className="apk-result-nav">
              <button
                type="button"
                className="btn"
                disabled={safeIdx <= 0}
                onClick={() => setIdx((v) => Math.max(0, v - 1))}
              >
                上一个
              </button>
              <button
                type="button"
                className="btn"
                disabled={safeIdx >= results.length - 1}
                onClick={() => setIdx((v) => Math.min(results.length - 1, v + 1))}
              >
                下一个
              </button>
            </div>
          ) : (
            <span />
          )}
          <button type="button" className="btn" onClick={copyCurrentTab}>
            复制本页
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="apk-result">
        <header className="apk-head">
          <div className="apk-head-pkg" title={info.package}>
            {info.package || "未知包名"}
          </div>
          <dl className="apk-head-meta">
            <div>
              <dt>版本</dt>
              <dd>
                {[info.version_name || "", info.version_code ? `(${info.version_code})` : ""]
                  .filter(Boolean)
                  .join(" ") || "—"}
              </dd>
            </div>
            <div>
              <dt>SDK</dt>
              <dd>
                {[
                  info.min_sdk ? `min ${info.min_sdk}` : "",
                  info.target_sdk ? `target ${info.target_sdk}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{info.file_size_label || "—"}</dd>
            </div>
            <div>
              <dt>ABI</dt>
              <dd>{(info.abis || []).join(", ") || "纯 Java"}</dd>
            </div>
          </dl>
          <div className="apk-head-sub">
            <span title={info.md5 || ""}>MD5 {info.md5 || "—"}</span>
            <span>
              DEX {info.has_dex ? `×${info.dex_count || 1}` : "无"}
              {info.has_native ? " · Native" : ""}
            </span>
            {info.debuggable === true ? <span className="apk-pill warn">debuggable</span> : null}
          </div>
        </header>

        {(info.warnings || []).length ? (
          <div className="apk-warns">
            {(info.warnings || []).map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        ) : null}

        <div className="apk-tabs" role="tablist">
          {cmp ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "compare"}
              className={tab === "compare" ? "active" : ""}
              onClick={() => setTab("compare")}
            >
              对比
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={tab === "perms"}
            className={tab === "perms" ? "active" : ""}
            onClick={() => setTab("perms")}
          >
            权限 {(info.permissions || []).length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "intents"}
            className={tab === "intents" ? "active" : ""}
            onClick={() => setTab("intents")}
          >
            Intent {intents.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "comps"}
            className={tab === "comps" ? "active" : ""}
            onClick={() => setTab("comps")}
          >
            组件 {comps.length}
          </button>
        </div>

        <div className="apk-tab-panel" role="tabpanel">
          {tab === "compare" && cmp ? (
            <div className="apk-tab-body">
              <div className={`apk-compare kind-${verdictClass(cmp.verdict_kind)}`}>
                <div className="apk-compare-top">
                  <span>设备对比</span>
                  <strong className={`apk-pill verdict kind-${verdictClass(cmp.verdict_kind)}`}>
                    {cmp.verdict || "—"}
                  </strong>
                </div>
                {cmp.installed ? (
                  <div className="apk-compare-ver">
                    <span>
                      设备{" "}
                      {[
                        cmp.device_version_name || "",
                        cmp.device_version_code ? `(${cmp.device_version_code})` : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || "—"}
                    </span>
                    <span aria-hidden>→</span>
                    <span>
                      新包{" "}
                      {[
                        cmp.apk_version_name || info.version_name || "",
                        (cmp.apk_version_code || info.version_code)
                          ? `(${cmp.apk_version_code || info.version_code})`
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || "—"}
                    </span>
                  </div>
                ) : (
                  <p className="apk-compare-note">设备尚未安装该包</p>
                )}
              </div>
              {cmp.installed ? (
                <>
                  <PermGroup
                    title="系统默认已授予"
                    note="安装即生效，无需用户再点授权"
                    items={cmp.install_granted || []}
                    tone="auto"
                  />
                  <PermGroup
                    title="运行时已授予"
                    note="用户已授权"
                    items={cmp.runtime_granted || []}
                    tone="auto"
                  />
                  <PermGroup
                    title="运行时未授予"
                    note="需用户手动授权"
                    items={cmp.runtime_denied || []}
                    tone="need"
                  />
                  <PermGroup
                    title="新包多出"
                    note="相对设备已装版本"
                    items={cmp.perms_added || []}
                    tone="add"
                  />
                  <PermGroup
                    title="新包少了"
                    note="相对设备已装版本"
                    items={cmp.perms_removed || []}
                    tone="del"
                  />
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "perms" ? (
            <div className="apk-tab-body">
              {!buckets.auto.length && !buckets.runtime.length && !buckets.special.length ? (
                <EmptyLine text="未声明权限" />
              ) : (
                <>
                  <PermGroup
                    title="系统默认授予"
                    note="普通权限，安装后即生效，一般不用用户再点授权"
                    items={buckets.auto}
                    tone="auto"
                  />
                  <PermGroup
                    title="需运行时授权"
                    note="危险权限，首次使用时需用户确认"
                    items={buckets.runtime}
                    tone="need"
                  />
                  <PermGroup
                    title="需特殊授权"
                    note="通常要进系统设置页手动开启"
                    items={buckets.special}
                    tone="special"
                  />
                </>
              )}
            </div>
          ) : null}

          {tab === "intents" ? (
            <div className="apk-tab-body">
              {!intents.length ? (
                <EmptyLine text="无 Intent Filter" />
              ) : (
                <ul className="apk-simple-list">
                  {intents.map((it: ApkIntentFilterInfo, i) => {
                    const actions = it.actions || [];
                    const cats = it.categories || [];
                    const data = (it.data || []).map(formatIntentData).filter(Boolean);
                    return (
                      <li key={`${it.component}-${i}`}>
                        <div className="apk-simple-title">
                          <span className="apk-pill">{it.component_kind || "component"}</span>
                          <code>{it.component || "?"}</code>
                          {it.exported != null ? (
                            <span className={`apk-pill${it.exported ? " warn" : ""}`}>
                              {it.exported ? "exported" : "private"}
                            </span>
                          ) : null}
                        </div>
                        {actions.length ? (
                          <div className="apk-simple-block">
                            <span className="apk-simple-label">action</span>
                            <ul className="apk-pg-list">
                              {actions.map((a) => (
                                <li key={a}>{a}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {cats.length ? (
                          <div className="apk-simple-block">
                            <span className="apk-simple-label">category</span>
                            <ul className="apk-pg-list">
                              {cats.map((c) => (
                                <li key={c}>{c}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {data.length ? (
                          <div className="apk-simple-block">
                            <span className="apk-simple-label">data</span>
                            <ul className="apk-pg-list">
                              {data.map((d) => (
                                <li key={d}>{d}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {tab === "comps" ? (
            <div className="apk-tab-body">
              {!comps.length ? (
                <EmptyLine text="无组件" />
              ) : (
                <ul className="apk-simple-list">
                  {comps.map((c) => (
                    <li key={`${c._kind}-${c.name}`}>
                      <div className="apk-simple-title">
                        <span className="apk-pill">{c._kind}</span>
                        <code>{c.name}</code>
                        {c.exported != null ? (
                          <span className={`apk-pill${c.exported ? " warn" : ""}`}>
                            {c.exported ? "exported" : "private"}
                          </span>
                        ) : null}
                        {(c.intent_filters || []).length ? (
                          <span className="apk-pill muted">
                            intent ×{(c.intent_filters || []).length}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
