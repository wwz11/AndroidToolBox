import { useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../../errors";
import { api } from "../../api/client";
import { Button, EmptyState } from "../../ui";

type Props = {
  deviceSn: string;
  snOk: boolean;
  active: boolean; // active && tab === "ui"
  onStatus: (msg: string | ((prev: string) => string)) => void;
  onAppend?: (line: string) => void;
};

type UiNode = {
  depth: number;
  text: string;
  resource_id: string;
  class: string;
  content_desc: string;
  bounds: string;
  label: string;
  clickable?: boolean;
  package?: string;
};

/** 列表展示用：竖排/多行 text 压成一行，避免表格被撑开 */
function flattenUiText(s: string): string {
  return (s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function shortResourceId(id: string): string {
  const s = (id || "").trim();
  if (!s) return "";
  const i = s.indexOf(":id/");
  return i >= 0 ? s.slice(i) : s;
}

function shortClassName(cls: string): string {
  const s = (cls || "").trim();
  if (!s) return "";
  const parts = s.split(".");
  return parts[parts.length - 1] || s;
}

export default function UiDumpPanel({
  deviceSn,
  snOk,
  active: _active,
  onStatus,
  onAppend,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [onlyWithId, setOnlyWithId] = useState(false);
  const [uiNodes, setUiNodes] = useState<UiNode[]>([]);
  const [uiFilter, setUiFilter] = useState("");
  const [uiSelected, setUiSelected] = useState(-1);
  const [uiXml, setUiXml] = useState("");
  const uiTableRef = useRef<HTMLDivElement | null>(null);

  const filteredUi = useMemo(() => {
    const n = uiFilter.trim().toLowerCase();
    if (!n) return uiNodes;
    return uiNodes.filter((node) => {
      const hay = [
        node.label,
        node.text,
        node.resource_id,
        node.class,
        node.content_desc,
        node.bounds,
        node.package || "",
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(n);
    });
  }, [uiNodes, uiFilter]);

  function copyUiText(text: string, okMsg: string) {
    if (!text) {
      onStatus("无内容可复制");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => onStatus(okMsg),
      () => onStatus("复制失败"),
    );
  }

  function formatUiNode(n: UiNode): string {
    return [
      n.label && `text: ${flattenUiText(n.label)}`,
      n.resource_id && `id: ${n.resource_id}`,
      n.class && `class: ${n.class}`,
      n.content_desc && `desc: ${flattenUiText(n.content_desc)}`,
      n.package && `package: ${n.package}`,
      n.bounds && `bounds: ${n.bounds}`,
      n.clickable != null && `clickable: ${n.clickable}`,
      `depth: ${n.depth}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function wrap(
    label: string,
    fn: () => Promise<void>,
    opts?: { requireDevice?: boolean },
  ) {
    if ((opts?.requireDevice ?? true) && !snOk) return;
    setBusy(true);
    onStatus(label);
    try {
      await fn();
    } catch (e) {
      const op = label.replace(/…$/, "").trim();
      const raw = toErrorMessage(e);
      onStatus(op && !raw.startsWith(op) ? `${op}失败：${raw}` : raw);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ui-panel">
      <div className="ui-controls">
        <div className="ui-row ui-row-main">
          <input
            className="field ui-filter"
            placeholder="过滤 text / id / class / bounds…"
            value={uiFilter}
            onChange={(e) => {
              setUiFilter(e.target.value);
              setUiSelected(-1);
            }}
          />
          <Button
            variant="primary"
            className="ui-btn-fetch"
            disabled={!snOk || busy}
            loading={busy}
            onClick={() =>
              void wrap("抓取界面…", async () => {
                const r = await api.uiDump(deviceSn, onlyWithId);
                setUiNodes(r.nodes as UiNode[]);
                setUiXml(r.xml_preview || "");
                setUiSelected(-1);
                onStatus(`控件 ${r.count} 个`);
                onAppend?.(`# UI dump ${r.count} nodes`);
              })
            }
          >
            获取界面
          </Button>
        </div>
        <div className="ui-row ui-row-tools">
          <label className="ui-check" title="只保留带 resource-id 的节点">
            <input
              type="checkbox"
              checked={onlyWithId}
              disabled={!snOk || busy}
              onChange={(e) => setOnlyWithId(e.target.checked)}
            />
            仅 ID
          </label>
          <div className="ui-actions">
            <button
              type="button"
              className="shell-icon-btn"
              disabled={uiSelected < 0 || !filteredUi[uiSelected]}
              title="复制选中节点全部字段"
              onClick={() => {
                const n = filteredUi[uiSelected];
                if (!n) return;
                copyUiText(formatUiNode(n), "已复制节点");
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="shell-icon-btn"
              disabled={uiSelected < 0 || !filteredUi[uiSelected]?.resource_id}
              title="仅复制 resource-id"
              onClick={() => {
                const id = filteredUi[uiSelected]?.resource_id || "";
                copyUiText(id, `已复制 ${shortResourceId(id) || id}`);
              }}
            >
              ID
            </button>
            <button
              type="button"
              className="shell-icon-btn"
              disabled={!filteredUi.length}
              title="导出当前过滤结果为 JSON"
              onClick={() => {
                const blob = new Blob(
                  [JSON.stringify(filteredUi.slice(0, 2000), null, 2)],
                  { type: "application/json;charset=utf-8" },
                );
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `ui_nodes_${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
                onStatus(`已导出 ${Math.min(filteredUi.length, 2000)} 个节点`);
              }}
            >
              JSON
            </button>
            <button
              type="button"
              className="shell-icon-btn"
              disabled={!uiXml}
              title="下载最近一次 dump 的 XML"
              onClick={() => {
                const blob = new Blob([uiXml], {
                  type: "application/xml;charset=utf-8",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `window_dump_${Date.now()}.xml`;
                a.click();
                URL.revokeObjectURL(url);
                onStatus("已下载 XML");
              }}
            >
              XML
            </button>
          </div>
        </div>
      </div>

      <div className="ui-main">
        <div className="ui-table-card">
          <div className="ui-table-head">
            <span className="ui-stats">
              {uiFilter.trim()
                ? `${filteredUi.length}/${uiNodes.length}`
                : uiNodes.length}{" "}
              个控件
              {filteredUi.length > 500 ? " · 前 500" : ""}
            </span>
            <span className="ui-stats-hint">↑↓ 选择 · 双击复制</span>
          </div>
          <div
            className="ui-table-wrap"
            ref={uiTableRef}
            tabIndex={0}
            onKeyDown={(e) => {
              if (!filteredUi.length) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setUiSelected((i) =>
                  Math.min(
                    Math.min(filteredUi.length, 500) - 1,
                    (i < 0 ? -1 : i) + 1,
                  ),
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setUiSelected((i) => Math.max(0, (i < 0 ? 0 : i) - 1));
              } else if (e.key === "Enter" && uiSelected >= 0) {
                const n = filteredUi[uiSelected];
                if (n) {
                  copyUiText(
                    n.resource_id || flattenUiText(n.label) || n.class,
                    "已复制",
                  );
                }
              } else if (e.key === "c" && (e.ctrlKey || e.metaKey) && uiSelected >= 0) {
                const n = filteredUi[uiSelected];
                if (n) {
                  e.preventDefault();
                  copyUiText(formatUiNode(n), "已复制节点");
                }
              }
            }}
          >
            {filteredUi.length ? (
              <table className="ui-table">
                <thead>
                  <tr>
                    <th className="ui-col-label">控件</th>
                    <th className="ui-col-id">resource-id</th>
                    <th className="ui-col-class">class</th>
                    <th className="ui-col-bounds">bounds</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUi.slice(0, 500).map((n, i) => {
                    const line = flattenUiText(n.label);
                    const idShort = shortResourceId(n.resource_id);
                    return (
                      <tr
                        key={`${n.resource_id}-${n.bounds}-${i}`}
                        className={uiSelected === i ? "selected" : ""}
                        onClick={() => setUiSelected(i)}
                        onDoubleClick={() => {
                          setUiSelected(i);
                          copyUiText(
                            n.resource_id || line || n.class,
                            `已复制 ${idShort || line || shortClassName(n.class)}`,
                          );
                        }}
                      >
                        <td title={n.label || undefined}>
                          <span
                            className="ui-tree-label"
                            style={{ paddingLeft: 2 + Math.min(n.depth, 6) * 8 }}
                          >
                            <span className="ui-tree-guide" aria-hidden>
                              {n.depth > 0 ? "└" : ""}
                            </span>
                            {n.clickable ? (
                              <span className="ui-badge" title="clickable">
                                点
                              </span>
                            ) : null}
                            {line ? (
                              <span className="ui-tree-text">{line}</span>
                            ) : (
                              <span className="ui-muted">(无文本)</span>
                            )}
                          </span>
                        </td>
                        <td className="mono" title={n.resource_id}>
                          {idShort || <span className="ui-muted">—</span>}
                        </td>
                        <td className="mono" title={n.class}>
                          {shortClassName(n.class) || (
                            <span className="ui-muted">—</span>
                          )}
                        </td>
                        <td className="mono" title={n.bounds}>
                          {n.bounds || <span className="ui-muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <EmptyState
                className="ui-dump-empty"
                title={
                  uiNodes.length
                    ? "无匹配控件"
                    : snOk
                      ? "尚未抓取界面"
                      : "未绑定设备"
                }
                description={
                  uiNodes.length
                    ? "试试改过滤条件。"
                    : snOk
                      ? "点「获取界面」抓取控件树。"
                      : "打开设备标签后可用。"
                }
                action={
                  snOk && !uiNodes.length ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      loading={busy}
                      onClick={() =>
                        void wrap("抓取界面…", async () => {
                          const r = await api.uiDump(deviceSn, onlyWithId);
                          setUiNodes(r.nodes as UiNode[]);
                          setUiXml(r.xml_preview || "");
                          setUiSelected(-1);
                          onStatus(`控件 ${r.count} 个`);
                          onAppend?.(`# UI dump ${r.count} nodes`);
                        })
                      }
                    >
                      获取界面
                    </Button>
                  ) : null
                }
              />
            )}
          </div>
        </div>

        <aside className="ui-detail">
          <div className="ui-detail-head">
            <span>节点详情</span>
            {filteredUi[uiSelected] ? (
              <Button
                variant="ghost"
                size="sm"
                className="ui-detail-copy-all"
                onClick={() =>
                  copyUiText(formatUiNode(filteredUi[uiSelected]), "已复制节点")
                }
              >
                复制全部
              </Button>
            ) : null}
          </div>
          {filteredUi[uiSelected] ? (
            <dl className="ui-detail-list">
              {(
                [
                  ["text", filteredUi[uiSelected].label],
                  ["resource-id", filteredUi[uiSelected].resource_id],
                  ["class", filteredUi[uiSelected].class],
                  ["desc", filteredUi[uiSelected].content_desc],
                  ["package", filteredUi[uiSelected].package || ""],
                  ["bounds", filteredUi[uiSelected].bounds],
                  [
                    "clickable",
                    filteredUi[uiSelected].clickable == null
                      ? ""
                      : String(filteredUi[uiSelected].clickable),
                  ],
                  ["depth", String(filteredUi[uiSelected].depth)],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="ui-detail-row">
                  <dt>{k}</dt>
                  <dd
                    className={
                      v
                        ? k === "text" || k === "desc"
                          ? "ui-detail-text"
                          : "mono"
                        : "ui-muted"
                    }
                    title={v || undefined}
                    onDoubleClick={() => {
                      if (!v) return;
                      copyUiText(v, `已复制 ${k}`);
                    }}
                  >
                    {v ? (k === "text" || k === "desc" ? v : v) : "—"}
                    {v && (k === "text" || k === "desc") && /[\r\n]/.test(v) ? (
                      <div className="ui-detail-flat" title="单行预览">
                        {flattenUiText(v)}
                      </div>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="ui-detail-empty">选中左侧控件查看详情</div>
          )}
        </aside>
      </div>
    </div>
  );
}
