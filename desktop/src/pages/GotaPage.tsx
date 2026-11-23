import { useEffect, useMemo, useRef, useState } from "react";
import { toErrorMessage } from "../errors";
import { api } from "../api/client";
import { patchAppPrefs, readAppPrefs } from "../appPrefs";
import Modal from "../components/Modal";
import { useDialog } from "../components/dialog";
import { useStatusNotify } from "../components/toast";
import { Button, PageHeader } from "../ui";

const PROJECTS_KEY = "toolbox.gota.projects.v2";
const LAST_PROJECT_KEY = "toolbox.gota.lastProject";
const CHUNK_KEY = "toolbox.gota.chunk";
const OUT_DIR_KEY = "toolbox.gota.outDir";
const LEGACY_PREFIXES_KEY = "toolbox.gota.prefixes.v1";
const LEGACY_LAST_PREFIX_KEY = "toolbox.gota.lastPrefix";

type GotaProject = { name: string; prefix: string };

const DEFAULT_PREFIX = "serial:YVR:";
const DEFAULT_PROJECT: GotaProject = { name: "默认", prefix: DEFAULT_PREFIX };
const MAX_PROJECTS = 40;

function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function normalizePrefix(raw: string): string {
  return raw.trim();
}

function projectLabelFromPrefix(prefix: string): string {
  const p = prefix.trim();
  const m = /^serial:([^:]+):?$/i.exec(p);
  if (m?.[1]) return m[1];
  const stripped = p.replace(/^serial:/i, "").replace(/:$/, "");
  return stripped || p || "未命名";
}

function suggestPrefix(name: string, fallback = DEFAULT_PREFIX): string {
  const n = normalizeName(name);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(n)) return `serial:${n}:`;
  return fallback;
}

function safePathSegment(name: string): string {
  const s = normalizeName(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  return s || "project";
}

function joinDir(base: string, segment: string): string {
  const b = base.replace(/[/\\]+$/, "");
  const sep = /\\/.test(b) && !/\//.test(b) ? "\\" : "/";
  return `${b}${sep}${safePathSegment(segment)}`;
}

function countLines(text: string): number {
  if (!text.trim()) return 0;
  return text.split(/\r?\n/).filter((l) => l.trim()).length;
}

function estimateParts(lines: number, chunk: number): number {
  if (lines <= 0) return 0;
  const n = Math.max(1, chunk | 0);
  return Math.ceil(lines / n);
}

function isLikelyTextFile(f: File): boolean {
  if (/\.(txt|csv|log)$/i.test(f.name)) return true;
  if (!f.type) return true;
  return f.type.startsWith("text/") || f.type === "application/json";
}

function loadProjects(): GotaProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const list: GotaProject[] = [];
        const seen = new Set<string>();
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const name = normalizeName(String((item as GotaProject).name || ""));
          const prefix = normalizePrefix(String((item as GotaProject).prefix || ""));
          if (!name || !prefix || seen.has(name)) continue;
          seen.add(name);
          list.push({ name, prefix });
          if (list.length >= MAX_PROJECTS) break;
        }
        if (list.length) return list;
      }
    }
  } catch {
    /* migrate */
  }

  try {
    const raw = localStorage.getItem(LEGACY_PREFIXES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const list: GotaProject[] = [];
        const seen = new Set<string>();
        for (const x of parsed) {
          const prefix = normalizePrefix(String(x || ""));
          if (!prefix) continue;
          let name = projectLabelFromPrefix(prefix);
          if (seen.has(name)) {
            let i = 2;
            while (seen.has(`${name}-${i}`)) i += 1;
            name = `${name}-${i}`;
          }
          seen.add(name);
          list.push({ name, prefix });
          if (list.length >= MAX_PROJECTS) break;
        }
        if (list.length) {
          saveProjects(list);
          return list;
        }
      }
    }
  } catch {
    /* ignore */
  }

  return [DEFAULT_PROJECT];
}

function saveProjects(list: GotaProject[]) {
  try {
    localStorage.setItem(
      PROJECTS_KEY,
      JSON.stringify(list.slice(0, MAX_PROJECTS)),
    );
  } catch {
    /* ignore */
  }
}

function loadLastProjectName(list: GotaProject[]): string {
  try {
    const last = normalizeName(localStorage.getItem(LAST_PROJECT_KEY) || "");
    if (last && list.some((p) => p.name === last)) return last;
  } catch {
    /* ignore */
  }
  try {
    const legacy = normalizePrefix(
      localStorage.getItem(LEGACY_LAST_PREFIX_KEY) || "",
    );
    if (legacy) {
      const hit = list.find((p) => p.prefix === legacy);
      if (hit) return hit.name;
    }
  } catch {
    /* ignore */
  }
  return list[0]?.name || DEFAULT_PROJECT.name;
}

function loadChunk(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(CHUNK_KEY) || "", 10);
    if (Number.isFinite(n) && n >= 1) return n;
  } catch {
    /* ignore */
  }
  return 1000;
}

function loadOutDir(): string {
  try {
    const fromPrefs = readAppPrefs().gotaOutDir;
    if (fromPrefs) return fromPrefs;
    return (localStorage.getItem(OUT_DIR_KEY) || "").trim();
  } catch {
    return "";
  }
}

export default function GotaPage() {
  const dialog = useDialog();
  const initialProjects = loadProjects();
  const [projects, setProjects] = useState(initialProjects);
  const [projectName, setProjectName] = useState(() =>
    loadLastProjectName(initialProjects),
  );
  const [prefix, setPrefix] = useState(() => {
    const name = loadLastProjectName(initialProjects);
    return (
      initialProjects.find((p) => p.name === name)?.prefix ||
      initialProjects[0]?.prefix ||
      DEFAULT_PREFIX
    );
  });
  const [chunk, setChunk] = useState(loadChunk);
  const [outDir, setOutDir] = useState(loadOutDir);
  const [text, setText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [lastResult, setLastResult] = useState<{
    summary: string;
    outDir: string;
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"create" | "edit">("create");
  const [createName, setCreateName] = useState("");
  const [createPrefix, setCreatePrefix] = useState(DEFAULT_PREFIX);
  const [createPrefixAuto, setCreatePrefixAuto] = useState(true);
  const [editFromName, setEditFromName] = useState("");
  const createNameRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const outDirRef = useRef(outDir);
  const prefixRef = useRef(prefix);
  const chunkRef = useRef(chunk);
  const projectNameRef = useRef(projectName);
  const projectsRef = useRef(projects);
  outDirRef.current = outDir;
  prefixRef.current = prefix;
  chunkRef.current = chunk;
  projectNameRef.current = projectName;
  projectsRef.current = projects;

  useEffect(() => {
    try {
      const name = normalizeName(projectName);
      if (name) localStorage.setItem(LAST_PROJECT_KEY, name);
    } catch {
      /* ignore */
    }
  }, [projectName]);

  useEffect(() => {
    try {
      localStorage.setItem(CHUNK_KEY, String(Math.max(1, chunk | 0)));
    } catch {
      /* ignore */
    }
  }, [chunk]);

  useEffect(() => {
    try {
      if (outDir.trim()) {
        localStorage.setItem(OUT_DIR_KEY, outDir.trim());
        patchAppPrefs({ gotaOutDir: outDir.trim() });
      }
    } catch {
      /* ignore */
    }
  }, [outDir]);

  const activeName = useMemo(() => {
    if (projects.some((p) => p.name === projectName)) return projectName;
    return projects[0]?.name || DEFAULT_PROJECT.name;
  }, [projects, projectName]);

  const savedPrefix = useMemo(
    () =>
      normalizePrefix(
        projects.find((p) => p.name === activeName)?.prefix || "",
      ),
    [projects, activeName],
  );

  // 主界面前缀只读：始终与当前项目绑定
  useEffect(() => {
    if (savedPrefix && savedPrefix !== normalizePrefix(prefix)) {
      setPrefix(savedPrefix);
    }
  }, [savedPrefix, prefix]);

  const lines = useMemo(() => countLines(text), [text]);
  const parts = useMemo(
    () => estimateParts(lines, Math.max(1, chunk | 0)),
    [lines, chunk],
  );
  const effectiveOut = useMemo(() => {
    const base = outDir.trim();
    if (!base) return "";
    return joinDir(base, activeName);
  }, [outDir, activeName]);

  function commitProjects(next: GotaProject[]) {
    const list = next.length ? next.slice(0, MAX_PROJECTS) : [DEFAULT_PROJECT];
    saveProjects(list);
    projectsRef.current = list;
    setProjects(list);
    return list;
  }

  function selectProject(name: string) {
    const n = normalizeName(name);
    if (!n || n === normalizeName(projectNameRef.current)) return;
    const hit = projectsRef.current.find((p) => p.name === n);
    if (!hit) return;
    setProjectName(n);
    setPrefix(hit.prefix);
  }

  function upsertProject(
    rawName: string,
    rawPrefix: string,
    replaceName = "",
  ): string | null {
    const name = normalizeName(rawName);
    const pfx = normalizePrefix(rawPrefix);
    if (!name || !pfx) return null;
    const drop = new Set(
      [normalizeName(replaceName), name].filter(Boolean),
    );
    const next = [
      { name, prefix: pfx },
      ...projectsRef.current.filter((x) => !drop.has(x.name)),
    ];
    commitProjects(next);
    setProjectName(name);
    setPrefix(pfx);
    return name;
  }

  function openCreateProject() {
    if (busy) return;
    setCreateMode("create");
    setEditFromName("");
    setCreateName("");
    setCreatePrefix(DEFAULT_PREFIX);
    setCreatePrefixAuto(true);
    setCreateOpen(true);
    requestAnimationFrame(() => createNameRef.current?.focus());
  }

  function openEditProject() {
    if (busy) return;
    const name = activeName;
    const pfx =
      projectsRef.current.find((p) => p.name === name)?.prefix || prefix;
    setCreateMode("edit");
    setEditFromName(name);
    setCreateName(name);
    setCreatePrefix(pfx);
    setCreatePrefixAuto(false);
    setCreateOpen(true);
    requestAnimationFrame(() => createNameRef.current?.focus());
  }

  function submitProjectForm() {
    const name = normalizeName(createName);
    const pfx = normalizePrefix(createPrefix);
    if (!name) {
      setStatus("请填写项目名称");
      createNameRef.current?.focus();
      return;
    }
    if (!pfx) {
      setStatus("请填写前缀");
      return;
    }

    if (createMode === "create") {
      if (projectsRef.current.some((p) => p.name === name)) {
        setStatus(`「${name}」已存在，已切换`);
        setCreateOpen(false);
        selectProject(name);
        return;
      }
      upsertProject(name, pfx);
      setCreateOpen(false);
      setStatus(`已创建「${name}」`);
      return;
    }

    const from = normalizeName(editFromName) || activeName;
    if (name !== from && projectsRef.current.some((p) => p.name === name)) {
      setStatus(`「${name}」已存在`);
      return;
    }
    upsertProject(name, pfx, from);
    setCreateOpen(false);
    setStatus(`已更新「${name}」`);
  }

  async function deleteProject() {
    const name = normalizeName(projectName);
    if (!name || !projects.some((p) => p.name === name)) {
      setStatus("请先选择要删除的项目");
      return;
    }
    if (projects.length <= 1) {
      setStatus("至少保留一个项目");
      return;
    }
    const ok = await dialog.confirm({
      title: "删除项目",
      message: `确定删除「${name}」？`,
      detail: projects.find((p) => p.name === name)?.prefix || "",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const next = projects.filter((p) => p.name !== name);
    const list = commitProjects(next);
    const fallback = list[0] || DEFAULT_PROJECT;
    setProjectName(fallback.name);
    setPrefix(fallback.prefix);
    setStatus(`已删除「${name}」`);
  }

  useEffect(() => {
    if (outDirRef.current.trim()) return;
    let cancelled = false;
    void (async () => {
      try {
        const fromApp = (await window.toolbox?.defaultGotaDir?.()) || "";
        if (cancelled) return;
        if (fromApp) {
          setOutDir(fromApp);
          return;
        }
        const r = await api.gotaDefaultDir();
        if (cancelled) return;
        if (r.out_dir) setOutDir(r.out_dir);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensureBaseOutDir(): Promise<string> {
    let dest = outDirRef.current.trim();
    if (dest) return dest;
    try {
      dest =
        (await window.toolbox?.defaultGotaDir?.()) ||
        (await api.gotaDefaultDir()).out_dir ||
        "";
    } catch {
      dest = "";
    }
    if (!dest) {
      const pick = window.toolbox?.chooseDirectory;
      if (!pick) {
        setStatus("请先设置输出目录");
        return "";
      }
      dest = (await pick({ title: "选择分割输出文件夹" })) || "";
      if (!dest) {
        setStatus("已取消");
        return "";
      }
    }
    setOutDir(dest);
    return dest;
  }

  async function pickOutDir() {
    const pick = window.toolbox?.chooseDirectory;
    if (!pick) {
      setStatus("当前环境无法选择目录");
      return;
    }
    const dir = await pick({
      title: "选择分割输出根目录（其下按项目建子目录）",
      defaultPath: outDir || undefined,
    });
    if (dir) {
      setOutDir(dir);
      setStatus(`输出根目录：${dir}`);
    }
  }

  async function openDir(path: string) {
    const p = path.trim();
    if (!p) {
      setStatus("尚未设置输出目录");
      return;
    }
    try {
      const r = await api.openPath(p);
      setStatus(r.message || `已打开 ${p}`);
    } catch (e) {
      setStatus(`打开路径失败：${toErrorMessage(e)}`);
    }
  }

  async function loadTextFile(f: File) {
    if (!isLikelyTextFile(f)) {
      setStatus("请选择 txt 文本文件");
      return;
    }
    try {
      const content = await f.text();
      setText(content);
      setSourceLabel(f.name);
      const n = countLines(content);
      setStatus(n ? `已载入 ${f.name}（${n} 行）` : `已载入 ${f.name}（无有效行）`);
    } catch (e) {
      setStatus(`读取文件 ${f.name} 失败：${toErrorMessage(e)}`);
    }
  }

  async function applyResult(
    r: { total_lines: number; part_count: number; out_dir: string },
  ) {
    const name = normalizeName(projectNameRef.current) || activeName;
    const summary = `${name}：${r.total_lines} 行 → ${r.part_count} 个文件`;
    setLastResult({ summary, outDir: r.out_dir });
    setStatus(summary);
  }

  async function splitText() {
    if (busy) return;
    const body = text.trim();
    if (!body) {
      setStatus("请先粘贴或载入序列号");
      return;
    }
    const pfx = normalizePrefix(prefixRef.current);
    if (!pfx) {
      setStatus("请填写前缀");
      return;
    }
    const base = await ensureBaseOutDir();
    if (!base) return;
    const dest = joinDir(base, projectNameRef.current || activeName);
    const n = Math.max(1, chunkRef.current | 0);
    setBusy(true);
    setStatus("分割中…");
    try {
      const r = await api.gotaSplitText(text, pfx, n, dest);
      await applyResult(r);
    } catch (err: unknown) {
      setStatus(`分割序列号失败：${toErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const canDelete = projects.length > 1 && projects.some((p) => p.name === activeName);

  return (
    <div className="panel">
      <PageHeader
        title="GOTA 序列号分割"
        description="按项目前缀和每文件行数，把序列号拆成多个文本。"
      />
      <div className="tool-panel gota-panel">
        <div className={`gota-bar${busy ? " is-busy" : ""}`}>
          <div className="gota-project-group">
            <select
              className="field gota-project-select"
              value={activeName}
              disabled={busy}
              aria-label="项目"
              onChange={(e) => selectProject(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="gota-prefix-btn mono"
              disabled={busy}
              title="点击编辑项目与前缀"
              onClick={openEditProject}
            >
              {prefix || "设置前缀"}
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title="新建项目"
              onClick={openCreateProject}
            >
              +
            </Button>
          </div>

          <label className="gota-chunk-wrap" title="每文件行数">
            <input
              className="field gota-chunk"
              type="number"
              min={1}
              value={chunk}
              disabled={busy}
              aria-label="每文件行数"
              onChange={(e) =>
                setChunk(Math.max(1, Number(e.target.value) || 1))
              }
            />
          </label>

          <Button
            size="sm"
            disabled={busy}
            title={effectiveOut || outDir || "选择输出根目录"}
            onClick={() => void pickOutDir()}
          >
            输出
          </Button>

          <span className="gota-bar-gap" />

          <label className={`btn file-btn${busy ? " disabled" : ""}`}>
            载入
            <input
              type="file"
              accept=".txt,.csv,.log,text/plain"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void loadTextFile(f);
              }}
            />
          </label>
          <Button
            variant="primary"
            loading={busy}
            disabled={busy || !text.trim() || !normalizePrefix(prefix)}
            onClick={() => void splitText()}
          >
            分割
          </Button>
        </div>

        <div
          className={`gota-main${dragOver ? " dragover" : ""}${busy ? " busy" : ""}`}
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
            if (f) void loadTextFile(f);
            else setStatus("未识别到文件");
          }}
        >
          <textarea
            className="field mono gota-text-area"
            value={text}
            disabled={busy}
            placeholder={"粘贴序列号或拖入 txt\nABC123\nDEF456"}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              if (sourceLabel) setSourceLabel("");
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void splitText();
              }
            }}
          />
          {(lines > 0 || sourceLabel || lastResult) && (
            <div className="gota-main-meta-bar">
              <span>
                {lines
                  ? `${lines} 行 → ${parts} 文件`
                  : sourceLabel || ""}
                {lastResult ? (
                  <>
                    {lines || sourceLabel ? " · " : ""}
                    <button
                      type="button"
                      className="gota-inline-link"
                      title={lastResult.outDir}
                      onClick={() => {
                        if (lastResult.outDir) void openDir(lastResult.outDir);
                      }}
                    >
                      {lastResult.summary}
                    </button>
                  </>
                ) : null}
              </span>
              {text ? (
                <button
                  type="button"
                  className="gota-inline-link"
                  disabled={busy}
                  onClick={() => {
                    setText("");
                    setSourceLabel("");
                    setLastResult(null);
                  }}
                >
                  清空
                </button>
              ) : null}
            </div>
          )}
          {dragOver ? <div className="gota-drop-hint">松开载入</div> : null}
        </div>
      </div>

      <Modal
        open={createOpen}
        size="sm"
        zClass="modal-top"
        title={createMode === "edit" ? "编辑项目" : "新建项目"}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            {createMode === "edit" && canDelete ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setCreateOpen(false);
                  void deleteProject();
                }}
              >
                删除
              </Button>
            ) : null}
            <span className="gota-modal-spacer" />
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={
                !normalizeName(createName) || !normalizePrefix(createPrefix)
              }
              onClick={submitProjectForm}
            >
              {createMode === "edit" ? "保存" : "创建"}
            </Button>
          </>
        }
      >
        <div className="gota-create-form">
          <label className="gota-create-field">
            <span>项目</span>
            <input
              ref={createNameRef}
              className="field"
              value={createName}
              placeholder="如 YVR"
              onChange={(e) => {
                const v = e.target.value;
                setCreateName(v);
                if (createPrefixAuto) {
                  setCreatePrefix(suggestPrefix(v, DEFAULT_PREFIX));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitProjectForm();
                }
              }}
            />
          </label>
          <label className="gota-create-field">
            <span>前缀</span>
            <input
              className="field mono"
              value={createPrefix}
              placeholder="serial:XXX:"
              onChange={(e) => {
                setCreatePrefixAuto(false);
                setCreatePrefix(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitProjectForm();
                }
              }}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
