import { useEffect, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { useStatusNotify } from "../components/toast";
import { Button, EmptyState, PageHeader, Toolbar } from "../ui";

type FindScope = "input" | "output" | "both";
type FindSide = "input" | "output";

function locate(
  hay: string,
  needle: string,
  from: number,
  backwards: boolean,
  caseSensitive: boolean,
): number {
  if (!needle) return -1;
  const H = caseSensitive ? hay : hay.toLowerCase();
  const N = caseSensitive ? needle : needle.toLowerCase();
  if (backwards) {
    if (from < 0) return -1;
    return H.lastIndexOf(N, from);
  }
  if (from > H.length) return -1;
  return H.indexOf(N, from);
}

export default function Base64Page() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [urlsafe, setUrlsafe] = useState(false);
  const [prettyJson, setPrettyJson] = useState(true);
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findScope, setFindScope] = useState<FindScope>("both");
  const [findCase, setFindCase] = useState(false);
  const dragDepth = useRef(0);
  const findPosRef = useRef<{ side: FindSide; index: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  function textOf(side: FindSide) {
    return side === "input" ? input : output;
  }

  function sidesInScope(): FindSide[] {
    if (findScope === "input") return ["input"];
    if (findScope === "output") return ["output"];
    return ["input", "output"];
  }

  function revealMatch(
    side: FindSide,
    index: number,
    needle: string,
    wrapped = false,
  ) {
    findPosRef.current = { side, index };
    const el = side === "input" ? inputRef.current : outputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(index, index + needle.length);
      // 粗略滚到选区附近
      const lineHeight = 18;
      const linesBefore = textOf(side).slice(0, index).split("\n").length - 1;
      el.scrollTop = Math.max(0, linesBefore * lineHeight - el.clientHeight / 3);
    }
    const line = textOf(side).slice(0, index).split("\n").length;
    setStatus(
      `找到「${needle}」— ${side === "input" ? "输入" : "输出"} 第 ${line} 行${
        wrapped ? "（已回绕）" : ""
      }`,
    );
  }

  function findStep(backwards: boolean) {
    const needle = findQ;
    if (!needle) {
      setStatus("请输入查找内容");
      findInputRef.current?.focus();
      return;
    }
    const sides = sidesInScope();
    if (!sides.length) return;

    const cur = findPosRef.current;
    let startSide: FindSide =
      cur && sides.includes(cur.side) ? cur.side : sides[0];
    const startFrom =
      cur && cur.side === startSide
        ? backwards
          ? cur.index - 1
          : cur.index + needle.length
        : backwards
          ? textOf(startSide).length
          : 0;

    const si0 = sides.indexOf(startSide);
    const order = [...sides.slice(si0), ...sides.slice(0, si0)];

    for (let i = 0; i < order.length; i++) {
      const side = order[i];
      const hay = textOf(side);
      const from = i === 0 ? startFrom : backwards ? hay.length : 0;
      const hit = locate(hay, needle, from, backwards, findCase);
      if (hit >= 0) {
        revealMatch(side, hit, needle);
        return;
      }
    }

    // 整圈回绕再找一次
    for (const side of order) {
      const hay = textOf(side);
      const hit = locate(
        hay,
        needle,
        backwards ? hay.length : 0,
        backwards,
        findCase,
      );
      if (hit >= 0) {
        revealMatch(side, hit, needle, true);
        return;
      }
    }

    findPosRef.current = null;
    setStatus(`未找到「${needle}」`);
  }

  function clearFind() {
    findPosRef.current = null;
    const sel = window.getSelection?.();
    sel?.removeAllRanges?.();
    setStatus("已清除查找位置");
  }

  async function encode() {
    setBusy(true);
    findPosRef.current = null;
    try {
      const r = await api.base64Encode(input, { urlsafe });
      setOutput(r.result);
      setStatus(`编码完成 · ${r.result.length} 字符`);
    } catch (e) {
      setStatus(`Base64 编解码失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function decode() {
    setBusy(true);
    findPosRef.current = null;
    try {
      const r = await api.base64Decode(input, { urlsafe, prettyJson });
      setOutput(r.result);
      setStatus(`解码完成 · ${r.result.length} 字符`);
    } catch (e) {
      setStatus(`Base64 编解码失败：${toErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function swap() {
    findPosRef.current = null;
    setInput(output);
    setOutput(input);
    setStatus("已交换左右内容");
  }

  function clearAll() {
    findPosRef.current = null;
    setInput("");
    setOutput("");
    setStatus("已清空");
  }

  async function copyOutput() {
    if (!output) {
      setStatus("输出为空");
      return;
    }
    try {
      await navigator.clipboard.writeText(output);
      setStatus("已复制输出");
    } catch {
      setStatus("复制失败");
    }
  }

  function downloadOutput() {
    if (!output) {
      setStatus("输出为空");
      return;
    }
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "base64_output.txt";
    a.click();
    URL.revokeObjectURL(url);
    setStatus("已下载输出");
  }

  function loadTextFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      findPosRef.current = null;
      setInput(String(reader.result || ""));
      setStatus(`已导入 ${file.name}`);
    };
    reader.onerror = () => setStatus("读取文件失败");
    reader.readAsText(file, "UTF-8");
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "f" || ev.key === "F")) {
        ev.preventDefault();
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "g") {
        ev.preventDefault();
        findStep(ev.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQ, findScope, findCase, input, output]);

  return (
    <div className="panel">
      <PageHeader
        title="BASE64"
        description="编码 / 解码文本；支持 URL-safe、JSON 美化与查找。"
      />
      <div className="tool-panel base64-panel">
        <Toolbar
          start={
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={urlsafe}
                  disabled={busy}
                  onChange={(e) => setUrlsafe(e.target.checked)}
                />
                URL-safe
              </label>
              <label className="check" title="解码结果若为 JSON 则缩进美化">
                <input
                  type="checkbox"
                  checked={prettyJson}
                  disabled={busy}
                  onChange={(e) => setPrettyJson(e.target.checked)}
                />
                JSON 美化
              </label>
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || !input}
                onClick={() => void encode()}
              >
                编码
              </Button>
              <Button
                disabled={busy || !input.trim()}
                onClick={() => void decode()}
              >
                解码
              </Button>
              <Button disabled={busy} onClick={swap}>
                交换
              </Button>
              <Button disabled={busy} onClick={clearAll}>
                清空
              </Button>
              <Button
                disabled={busy || !output}
                onClick={() => void copyOutput()}
              >
                复制输出
              </Button>
              <label className={`btn file-btn${busy ? " disabled" : ""}`}>
                导入
                <input
                  type="file"
                  accept=".txt,.json,.b64,.base64,text/plain,application/json"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) loadTextFile(f);
                  }}
                />
              </label>
              <Button disabled={busy || !output} onClick={downloadOutput}>
                保存输出
              </Button>
            </>
          }
        />

        <Toolbar
          className="base64-find-bar"
          start={
            <>
              <span className="label">查找</span>
              <input
                ref={findInputRef}
                className="field base64-find-input"
                value={findQ}
                disabled={busy}
                placeholder="关键字（Ctrl+F）"
                onChange={(e) => {
                  setFindQ(e.target.value);
                  findPosRef.current = null;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    findStep(e.shiftKey);
                  } else if (e.key === "Escape") {
                    clearFind();
                  }
                }}
              />
              <select
                className="field base64-find-scope"
                value={findScope}
                disabled={busy}
                title="查找范围"
                onChange={(e) => {
                  setFindScope(e.target.value as FindScope);
                  findPosRef.current = null;
                }}
              >
                <option value="both">两侧</option>
                <option value="input">输入</option>
                <option value="output">输出</option>
              </select>
              <label className="check">
                <input
                  type="checkbox"
                  checked={findCase}
                  disabled={busy}
                  onChange={(e) => {
                    setFindCase(e.target.checked);
                    findPosRef.current = null;
                  }}
                />
                区分大小写
              </label>
              <Button
                disabled={busy || !findQ}
                onClick={() => findStep(true)}
              >
                上一个
              </Button>
              <Button
                disabled={busy || !findQ}
                onClick={() => findStep(false)}
              >
                下一个
              </Button>
              <Button variant="ghost" disabled={busy} onClick={clearFind}>
                清除
              </Button>
            </>
          }
        />

        <div className="base64-panes">
          <div
            className={`base64-pane${dragOver ? " dragover" : ""}`}
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
              if (f) loadTextFile(f);
              else {
                const text = e.dataTransfer.getData("text/plain");
                if (text) {
                  findPosRef.current = null;
                  setInput(text);
                  setStatus("已粘贴拖入文本");
                }
              }
            }}
          >
            <div className="base64-pane-head">
              <strong>输入</strong>
              <span>{input.length} 字符 · 可拖入文件</span>
            </div>
            <textarea
              ref={inputRef}
              className="field area base64-area"
              value={input}
              disabled={busy}
              onChange={(e) => {
                findPosRef.current = null;
                setInput(e.target.value);
              }}
              placeholder="明文或 Base64… 支持拖入文件"
              spellCheck={false}
            />
            {dragOver ? (
              <div className="base64-drop-hint">松开以导入到输入区</div>
            ) : null}
          </div>

          <div className="base64-pane">
            <div className="base64-pane-head">
              <strong>输出</strong>
              <span>{output.length} 字符</span>
            </div>
            {output ? (
              <textarea
                ref={outputRef}
                className="field area base64-area"
                readOnly
                value={output}
                spellCheck={false}
              />
            ) : (
              <>
                <EmptyState
                  className="base64-output-empty"
                  title="尚未转换"
                  description="在输入区填写内容后点「编码」或「解码」。"
                />
                <textarea
                  ref={outputRef}
                  className="base64-area-hidden"
                  readOnly
                  value=""
                  tabIndex={-1}
                  aria-hidden
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
