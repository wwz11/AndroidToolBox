import { useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { useStatusNotify } from "../components/toast";
import { Button, EmptyState, PageHeader, Toolbar } from "../ui";

function fileDisplayPath(f: File): string {
  const fromBridge = window.toolbox?.pathForFile?.(f)?.trim() || "";
  if (fromBridge) return fromBridge;
  const legacy = (f as File & { path?: string }).path?.trim() || "";
  return legacy || f.name || "";
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Md5Page() {
  const [text, setText] = useState("");
  const [upper, setUpper] = useState(false);
  const [result, setResult] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const upperRef = useRef(upper);
  upperRef.current = upper;

  async function copyMd5() {
    if (!result) return;
    try {
      if (window.toolbox?.clipboardWriteText) {
        await window.toolbox.clipboardWriteText(result);
      } else {
        await navigator.clipboard.writeText(result);
      }
      setStatus("已复制 MD5");
    } catch {
      setStatus("复制失败");
    }
  }

  async function runText() {
    if (!text.trim()) return;
    setBusy(true);
    setStatus("计算中…");
    try {
      const r = await api.md5Text(text, upper);
      setResult(r.md5);
      setStatus(`${r.chars} 字符`);
    } catch (e) {
      setStatus(`计算文本 MD5 失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function hashFile(f: File) {
    const path = fileDisplayPath(f);
    setSourcePath(path);
    setBusy(true);
    setStatus(`计算 ${path || f.name}…`);
    void api
      .md5File(f, upperRef.current)
      .then((r) => {
        setResult(r.md5);
        setStatus(
          `${path || r.filename} · ${formatBytes(r.bytes) || `${r.bytes} B`}`,
        );
      })
      .catch((err: unknown) => {
        setStatus(`计算文件 ${f.name} MD5 失败：${toErrorMessage(err)}`);
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className="panel">
      <PageHeader
        title="MD5 值生成"
        description="输入文本或拖入文件计算 MD5。"
      />
      <div className="tool-panel md5-panel">
        <Toolbar
          start={
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={upper}
                  disabled={busy}
                  onChange={(e) => setUpper(e.target.checked)}
                />
                大写
              </label>
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || !text.trim()}
                onClick={() => void runText()}
              >
                计算文本
              </Button>
              <label className={`btn file-btn${busy ? " disabled" : ""}`}>
                选择文件
                <input
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) hashFile(f);
                  }}
                />
              </label>
            </>
          }
        />
        <div
          className={`md5-drop${dragOver ? " dragover" : ""}${busy ? " busy" : ""}`}
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
            if (f) hashFile(f);
            else setStatus("未识别到文件");
          }}
        >
          <textarea
            className="field area md5-text"
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void runText();
              }
            }}
            placeholder="输入文本，或拖入文件"
          />
          {dragOver ? (
            <div className="md5-drop-hint">松开以计算文件 MD5</div>
          ) : null}
        </div>

        {result || sourcePath ? (
          <div className="md5-out">
            {sourcePath ? (
              <div className="md5-out-row" title={sourcePath}>
                <span className="md5-out-label">文件</span>
                <span className="md5-out-path mono">{sourcePath}</span>
              </div>
            ) : null}
            {result ? (
              <div className="md5-out-row">
                <span className="md5-out-label">MD5</span>
                <input className="field mono grow" readOnly value={result} />
                <Button onClick={() => void copyMd5()}>复制</Button>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            className="local-result-empty"
            title="尚未计算"
            description="点「计算文本」或拖入文件。"
          />
        )}
      </div>
    </div>
  );
}
