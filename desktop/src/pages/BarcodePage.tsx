import { useEffect, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { useStatusNotify } from "../components/toast";
import { Button, EmptyState, PageHeader, Toolbar } from "../ui";

function safeName(text: string): string {
  const s = text.trim().replace(/[<>:"/\\|?*\s]+/g, "_").slice(0, 64);
  return s || "barcode";
}

export default function BarcodePage() {
  const [data, setData] = useState("");
  const [img, setImg] = useState("");
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [lines, setLines] = useState<string[]>([]);
  const [lineIdx, setLineIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const reqId = useRef(0);

  async function preview(raw?: string) {
    const text = (raw ?? data).trim();
    if (!text) {
      setStatus("请输入条码内容");
      return;
    }
    const id = ++reqId.current;
    setBusy(true);
    setStatus("生成中…");
    try {
      const r = await api.barcodePreview(text);
      if (id !== reqId.current) return;
      setData(text);
      setImg(`data:${r.mime};base64,${r.png_base64}`);
      setStatus(`Code128 · ${r.width}×${r.height}`);
    } catch (e) {
      if (id !== reqId.current) return;
      setImg("");
      setStatus(`生成条码失败：${toErrorMessage(e)}`);
    } finally {
      if (id === reqId.current) setBusy(false);
    }
  }

  function showLine(idx: number, list = lines) {
    if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, idx));
    setLineIdx(i);
    void preview(list[i]);
  }

  function importTxtFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const next = text
        .split(/\r?\n/)
        .map((ln) => ln.trim())
        .filter(Boolean);
      if (!next.length) {
        setStatus("文件无有效行");
        return;
      }
      setLines(next);
      setLineIdx(0);
      setStatus(`已导入 ${next.length} 条`);
      void preview(next[0]);
    };
    reader.onerror = () => setStatus("读取文件失败");
    reader.readAsText(file, "UTF-8");
  }

  function downloadPng() {
    if (!img) return;
    const a = document.createElement("a");
    a.href = img;
    a.download = `${safeName(data)}.png`;
    a.click();
    setStatus(`已下载 ${safeName(data)}.png`);
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!lines.length) return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        showLine(lineIdx - 1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        showLine(lineIdx + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lineIdx]);

  const multi = lines.length > 1;

  return (
    <div className="panel">
      <PageHeader
        title="条形码预览"
        description="Code128 预览与批量 txt 导入；可下载 PNG。"
      />
      <div className="tool-panel barcode-panel">
        <Toolbar
          start={
            <>
              <input
                className="field mono grow"
                value={data}
                disabled={busy}
                onChange={(e) => setData(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void preview();
                }}
                placeholder="条码内容（Code128）"
                spellCheck={false}
              />
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || !data.trim()}
                onClick={() => void preview()}
              >
                预览
              </Button>
              <label className={`btn file-btn${busy ? " disabled" : ""}`}>
                导入 txt
                <input
                  type="file"
                  accept=".txt,text/plain"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) importTxtFile(f);
                  }}
                />
              </label>
              <Button disabled={!img || busy} onClick={downloadPng}>
                下载 PNG
              </Button>
            </>
          }
        />

        {lines.length ? (
          <Toolbar
            start={
              <>
                <Button
                  disabled={busy || lineIdx <= 0}
                  onClick={() => showLine(lineIdx - 1)}
                >
                  上一条
                </Button>
                <span className="barcode-nav-idx">
                  {lineIdx + 1} / {lines.length}
                </span>
                <Button
                  disabled={busy || lineIdx >= lines.length - 1}
                  onClick={() => showLine(lineIdx + 1)}
                >
                  下一条
                </Button>
                {multi ? (
                  <span className="hint-inline">方向键 ← → 也可切换</span>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setLines([]);
                    setLineIdx(0);
                    setStatus("已清除导入列表");
                  }}
                >
                  清除列表
                </Button>
              </>
            }
          />
        ) : null}

        <div className="tool-bar wrap barcode-zoom-bar">
          <span className="label">缩放</span>
          <button
            type="button"
            className="shell-icon-btn"
            disabled={zoom <= 0.5}
            onClick={() =>
              setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
            }
          >
            −
          </button>
          <button
            type="button"
            className="shell-icon-btn"
            onClick={() => setZoom(1)}
            title="重置"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="shell-icon-btn"
            disabled={zoom >= 3}
            onClick={() =>
              setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))
            }
          >
            +
          </button>
        </div>

        <div
          className={`barcode-preview${dragOver ? " dragover" : ""}${busy ? " busy" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepth.current += 1;
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepth.current = 0;
            setDragOver(false);
            if (busy) return;
            const f = e.dataTransfer.files?.[0];
            if (!f) return;
            if (/\.txt$/i.test(f.name) || f.type.startsWith("text/")) {
              importTxtFile(f);
            } else {
              setStatus("请拖入 txt 文本文件");
            }
          }}
        >
          {img ? (
            <img
              src={img}
              alt={data || "barcode"}
              className="barcode-img"
              style={{ transform: `scale(${zoom})` }}
            />
          ) : (
            <EmptyState
              className="barcode-empty"
              title="尚未生成预览"
              description="输入内容后点「预览」，或拖入 / 导入序列号 txt。"
            />
          )}
          {dragOver ? (
            <div className="barcode-drop-hint">松开以导入 txt</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
