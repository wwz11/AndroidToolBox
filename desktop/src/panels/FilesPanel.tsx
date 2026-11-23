import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { toErrorMessage } from "../errors";
import { api, type TransferProgressEvent } from "../api/client";
import Modal from "../components/Modal";
import { useDialog } from "../components/dialog";
import { useToast } from "../components/toast";
import { readAppPrefs, patchAppPrefs } from "../appPrefs";
import { Button, EmptyState } from "../ui";

type FillJobView = {
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

export type RemoteFileEntry = {
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
};

type Props = {
  deviceSn: string;
  browseOnly?: boolean;
  active?: boolean;
  append: (line: string) => void;
  setStatus: (s: string) => void;
};

type SortKey = "name" | "size" | "mtime" | "mode";
type Clip = { op: "copy" | "cut"; paths: string[] };

type MenuState = {
  x: number;
  y: number;
  path: string;
} | null;

const SHORTCUTS = [
  { path: "/sdcard", label: "存储卡" },
  { path: "/sdcard/Download", label: "下载" },
  { path: "/data/local/tmp", label: "tmp" },
] as const;

const DEFAULT_FILL_DIR = "/data/local/tmp";
const FILL_DIR_PRESETS = [
  { path: "/data/local/tmp", label: "tmp" },
  { path: "/sdcard", label: "sdcard" },
  { path: "/data", label: "data" },
] as const;

function normalizeFillDirInput(raw: string): string {
  const s = (raw || "").trim().replace(/\\/g, "/");
  if (!s) return DEFAULT_FILL_DIR;
  const collapsed = s.replace(/\/{2,}/g, "/");
  return collapsed !== "/" ? collapsed.replace(/\/+$/, "") : "/";
}

function pathIsUnder(cur: string, dir: string): boolean {
  const c = (cur || "").replace(/\/+$/, "") || "/";
  const d = (dir || "").replace(/\/+$/, "") || "/";
  return c === d || c.startsWith(`${d}/`);
}

const PULL_DIR_KEY = "toolbox.files.pullDir";
const BOOKMARKS_KEY = "toolbox.files.bookmarks.v1";

type BookmarkItem = { path: string; label: string };
type DroppedUploadItem = { file: File; relPath: string };

function readBookmarks(): BookmarkItem[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((x) => x && typeof x.path === "string" && typeof x.label === "string")
      : [];
  } catch {
    return [];
  }
}

function saveBookmarks(items: BookmarkItem[]) {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function isPreviewableFileName(name: string): boolean {
  const low = name.toLowerCase();
  return /\.(txt|log|xml|json|prop|conf|cfg|ini|sh|rc|md|yaml|yml|csv|png|jpe?g|webp|gif|bmp)$/.test(
    low,
  );
}

async function readEntryRecursive(
  entry: FileSystemEntry,
  prefix = "",
): Promise<DroppedUploadItem[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (file) => {
          resolve([{ file, relPath: prefix ? `${prefix}/${file.name}` : file.name }]);
        },
        () => resolve([]),
      );
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const allEntries: FileSystemEntry[] = [];
    const readBatch = (): Promise<void> =>
      new Promise((resolve) => {
        reader.readEntries(
          (batch) => {
            if (!batch.length) {
              resolve();
              return;
            }
            allEntries.push(...batch);
            void readBatch().then(resolve);
          },
          () => resolve(),
        );
      });
    await readBatch();
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const out: DroppedUploadItem[] = [];
    for (const child of allEntries) {
      out.push(...(await readEntryRecursive(child, nextPrefix)));
    }
    return out;
  }
  return [];
}

async function collectDroppedUploads(dt: DataTransfer): Promise<DroppedUploadItem[]> {
  const items = Array.from(dt.items || []);
  const entries = items
    .map((it) => it.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (entries.length && entries.some((e) => e.isDirectory)) {
    const out: DroppedUploadItem[] = [];
    for (const entry of entries) {
      out.push(...(await readEntryRecursive(entry)));
    }
    if (out.length) return out;
  }
  return Array.from(dt.files || []).map((file) => ({ file, relPath: file.name }));
}

function readPullDir(): string {
  try {
    const fromPrefs = readAppPrefs().pullDir;
    if (fromPrefs) return fromPrefs;
    return (localStorage.getItem(PULL_DIR_KEY) || "").trim();
  } catch {
    return "";
  }
}

function readBrowsePath(): string {
  try {
    const p = (readAppPrefs().filesBrowsePath || "/sdcard").trim() || "/sdcard";
    return p.startsWith("/") ? p.replace(/\/+$/, "") || "/" : `/${p}`;
  } catch {
    return "/sdcard";
  }
}

function writePullDir(dir: string) {
  try {
    if (dir) localStorage.setItem(PULL_DIR_KEY, dir);
    else localStorage.removeItem(PULL_DIR_KEY);
  } catch {
    /* ignore */
  }
  try {
    patchAppPrefs({ pullDir: dir });
  } catch {
    /* ignore */
  }
}

/** 目录提示：带尾部分隔符，API 会按目录拼接文件名 */
function asLocalDirHint(dir: string): string {
  const d = (dir || "").trim();
  if (!d) return "";
  if (d.endsWith("/") || d.endsWith("\\")) return d;
  const win =
    window.toolbox?.platform === "win32" || /^[A-Za-z]:[\\/]/.test(d);
  return win ? `${d}\\` : `${d}/`;
}

function dirAsRemote(path: string): string {
  const p = (path || "/").trim() || "/";
  if (p === "/") return "/";
  return p.endsWith("/") ? p : `${p}/`;
}

function shortPath(p: string, max = 48): string {
  const s = (p || "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

function formatSize(n?: number): string {
  if (n == null || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileLocalPath(file: File): string {
  try {
    const p = window.toolbox?.pathForFile?.(file);
    if (p) return p;
  } catch {
    /* ignore */
  }
  const anyFile = file as File & { path?: string };
  return typeof anyFile.path === "string" ? anyFile.path : "";
}

function joinRemote(base: string, name: string): string {
  const b = dirAsRemote(base);
  return b === "/" ? `/${name}` : `${b}${name}`;
}

function clampMenu(x: number, y: number, w = 180, h = 420) {
  const pad = 8;
  return {
    x: Math.max(pad, Math.min(x, window.innerWidth - w - pad)),
    y: Math.max(pad, Math.min(y, window.innerHeight - h - pad)),
  };
}

function sortMark(active: boolean, asc: boolean) {
  if (!active) return "";
  return asc ? "▴" : "▾";
}

function TypeIcon({ entry }: { entry: RemoteFileEntry }) {
  const kind = entry.is_dir ? "dir" : entry.is_link ? "link" : "file";
  return <span className={`file-ico ${kind}`} aria-hidden />;
}

function hasDraggedFiles(dt: DataTransfer | null): boolean {
  if (!dt || !dt.types) return false;
  const types = dt.types as unknown as { contains?: (t: string) => boolean } & ArrayLike<string>;
  if (typeof types.contains === "function") return types.contains("Files");
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === "Files") return true;
  }
  return false;
}

const PREFETCH_MAX_BYTES = 32 * 1024 * 1024;

type FileRowProps = {
  entry: RemoteFileEntry;
  selected: boolean;
  cut: boolean;
  snOk: boolean;
  onClick: (ev: MouseEvent<HTMLDivElement>, entry: RemoteFileEntry) => void;
  onContextMenu: (ev: MouseEvent<HTMLDivElement>, entry: RemoteFileEntry) => void;
  onHoverPrefetch: (entry: RemoteFileEntry) => void;
  onHoverCancel: () => void;
  onDragStart: (ev: DragEvent<HTMLDivElement>, entry: RemoteFileEntry) => void;
};

const FileRow = memo(function FileRow({
  entry,
  selected,
  cut,
  snOk,
  onClick,
  onContextMenu,
  onHoverPrefetch,
  onHoverCancel,
  onDragStart,
}: FileRowProps) {
  return (
    <div
      role="option"
      aria-selected={selected}
      draggable={!entry.is_dir && snOk}
      className={`files-table-row${entry.is_dir ? " dir" : ""}${selected ? " selected" : ""}${cut ? " cut" : ""}`}
      title={entry.path}
      onClick={(ev) => onClick(ev, entry)}
      onContextMenu={(ev) => onContextMenu(ev, entry)}
      onMouseEnter={() => onHoverPrefetch(entry)}
      onMouseLeave={onHoverCancel}
      onDragStart={(ev) => onDragStart(ev, entry)}
    >
      <span className="files-col name">
        <TypeIcon entry={entry} />
        <span className="file-name">
          {entry.name}
          {entry.is_link && entry.link_target ? (
            <span className="file-link"> → {entry.link_target}</span>
          ) : null}
        </span>
      </span>
      <span className="files-col size">{entry.is_dir ? "" : formatSize(entry.size)}</span>
      <span className="files-col mtime">{entry.mtime || ""}</span>
      <span className="files-col mode" title={entry.mode || ""}>
        {entry.mode || ""}
      </span>
    </div>
  );
});

export default function FilesPanel({
  deviceSn,
  browseOnly,
  active = true,
  append,
  setStatus,
}: Props) {
  const dialog = useDialog();
  const toast = useToast();
  const snOk = Boolean(deviceSn) && !browseOnly;
  const [busy, setBusy] = useState(false);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [fillPct, setFillPct] = useState(100);
  const [fillDir, setFillDir] = useState(DEFAULT_FILL_DIR);
  const [fillPreview, setFillPreview] = useState<{
    avail_label: string;
    target_label: string;
    message: string;
    ok: boolean;
    path?: string;
    fill_dir?: string;
  } | null>(null);
  const [fillPreviewBusy, setFillPreviewBusy] = useState(false);
  const [fillJob, setFillJob] = useState<FillJobView | null>(null);
  const fillJobIdRef = useRef("");
  const [browsePath, setBrowsePath] = useState(readBrowsePath);
  const [pathInput, setPathInput] = useState(() => dirAsRemote(readBrowsePath()));
  const [parentPath, setParentPath] = useState("/");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [rooted, setRooted] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(readBookmarks);
  const [dfInfo, setDfInfo] = useState<{
    avail?: string;
    total?: string;
    use_pct?: string;
    mount?: string;
  } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findBusy, setFindBusy] = useState(false);
  const [findItems, setFindItems] = useState<
    Array<{ path: string; name: string; parent: string }>
  >([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [previewData, setPreviewData] = useState<{
    kind: "text" | "image";
    path: string;
    name: string;
    size: number;
    text?: string;
    mime?: string;
    base64?: string;
    truncated: boolean;
  } | null>(null);
  const [previewDraft, setPreviewDraft] = useState("");
  const [clip, setClip] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [pullDir, setPullDir] = useState(readPullDir);
  const [defaultPullDir, setDefaultPullDir] = useState("");
  const effectivePullDir = pullDir || defaultPullDir;
  const [transfer, setTransfer] = useState<{
    kind: "push" | "pull";
    name: string;
    index: number;
    totalCount: number;
    doneBytes: number;
    totalBytes: number;
    percent: number | null;
    speedBps: number;
  } | null>(null);
  const transferAbortRef = useRef<AbortController | null>(null);
  const lastClickRef = useRef<{ path: string; t: number } | null>(null);
  const draggingOutRef = useRef(false);
  const dragOutAtRef = useRef(0);
  const pullCache = useRef<Map<string, string>>(new Map());
  const pullInFlight = useRef<Map<string, Promise<string | null>>>(new Map());
  const hoverTimerRef = useRef<number | null>(null);
  const listShellRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
    if (rect.right > window.innerWidth - pad) {
      el.style.left = `${Math.max(pad, Math.min(menu.x, maxLeft))}px`;
    }
    if (rect.bottom > window.innerHeight - pad) {
      el.style.top = `${Math.max(pad, Math.min(menu.y, maxTop))}px`;
    }
  }, [menu]);

  const pathFilter = useMemo(() => {
    const loadedPath = (browsePath || "/").replace(/\/+$/, "") || "/";
    const typed = pathInput.replace(/\\/g, "/");
    const prefix = loadedPath === "/" ? "/" : `${loadedPath}/`;
    if (typed.startsWith(prefix)) {
      return typed.slice(prefix.length).replace(/^\/+|\/+$/g, "");
    }
    return "";
  }, [browsePath, pathInput]);

  const visible = useMemo(() => {
    let list = entries;
    if (!showHidden) list = list.filter((e) => !e.name.startsWith("."));
    const f = pathFilter.trim().toLowerCase();
    if (f) list = list.filter((e) => e.name.toLowerCase().includes(f));
    const dirFirst = (a: RemoteFileEntry, b: RemoteFileEntry) =>
      Number(b.is_dir) - Number(a.is_dir);
    const cmp = (a: RemoteFileEntry, b: RemoteFileEntry) => {
      let r = 0;
      if (sortKey === "name") r = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      else if (sortKey === "size") r = (a.size || 0) - (b.size || 0);
      else if (sortKey === "mtime") r = (a.mtime || "").localeCompare(b.mtime || "");
      else r = (a.mode || "").localeCompare(b.mode || "");
      return sortAsc ? r : -r;
    };
    return [...list].sort((a, b) => dirFirst(a, b) || cmp(a, b));
  }, [entries, showHidden, pathFilter, sortKey, sortAsc]);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.includes(e.path)),
    [entries, selected],
  );

  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setStatus(label);
    try {
      await fn();
    } catch (e) {
      const raw = toErrorMessage(e);
      const op = label.replace(/…$/, "").trim();
      const isPerm =
        /permission denied|access denied|operation not permitted|无权限|权限不足|没有权限|not allowed/i.test(
          raw,
        );
      const msg = isPerm
        ? raw.includes("无权限")
          ? raw
          : `无权限访问\n${raw}`
        : raw;
      append(msg);
      const summary = msg.split(/\r?\n/)[0] || msg;
      const withOp =
        op && !summary.startsWith(op) ? `${op}失败：${summary}` : summary;
      toast.push(
        isPerm && !rooted && !/root/i.test(withOp)
          ? `${withOp}（可点击工具栏「Root」后重试）`
          : withOp,
        "err",
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadDir(path: string, opts?: { quiet?: boolean }) {
    if (!snOk) return;
    const r = await api.listRemote(deviceSn, path || "/");
    setBrowsePath(r.path);
    setPathInput(dirAsRemote(r.path));
    setParentPath(r.parent);
    setEntries(r.entries as RemoteFileEntry[]);
    setSelected([]);
    setLoaded(true);
    setMenu(null);
    if (!opts?.quiet) setStatus(`${r.entries.length} 项 · ${r.path}`);
    void api
      .fsDf(deviceSn, r.path)
      .then((df) => {
        setDfInfo(df.avail ? df : null);
      })
      .catch(() => {
        setDfInfo(null);
      });
  }

  useEffect(() => {
    if (!active || !snOk) return;
    if (loaded) return;
    const start = readBrowsePath();
    void run(`打开 ${start}…`, () => loadDir(start));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, snOk, deviceSn]);

  useEffect(() => {
    const start = readBrowsePath();
    setLoaded(false);
    setEntries([]);
    setSelected([]);
    setBrowsePath(start);
    setPathInput(dirAsRemote(start));
    setParentPath("/");
    setClip(null);
    setRooted(false);
    pullCache.current.clear();
    pullInFlight.current.clear();
  }, [deviceSn]);

  useEffect(() => {
    const resetAllDrag = () => {
      draggingOutRef.current = false;
      setDragOver(false);
    };
    const onWinDragEnd = () => {
      setDragOver(false);
      // ev.preventDefault() 取消 HTML5 拖拽时会立即触发一次 dragend，不能清掉原生拖出标记
      if (Date.now() - dragOutAtRef.current > 400) {
        draggingOutRef.current = false;
      }
    };
    const clearOverlayOnly = () => {
      setDragOver(false);
    };
    const onWinDragLeave = (ev: globalThis.DragEvent) => {
      if (!ev.relatedTarget) setDragOver(false);
    };
    const onWinPointer = (ev: PointerEvent | globalThis.MouseEvent) => {
      if (
        draggingOutRef.current &&
        ev.buttons === 0 &&
        Date.now() - dragOutAtRef.current > 250
      ) {
        draggingOutRef.current = false;
      }
    };
    window.addEventListener("drop", resetAllDrag);
    window.addEventListener("dragend", onWinDragEnd);
    window.addEventListener("blur", clearOverlayOnly);
    window.addEventListener("dragleave", onWinDragLeave);
    window.addEventListener("pointermove", onWinPointer);
    window.addEventListener("mousedown", onWinPointer);
    return () => {
      window.removeEventListener("drop", resetAllDrag);
      window.removeEventListener("dragend", onWinDragEnd);
      window.removeEventListener("blur", clearOverlayOnly);
      window.removeEventListener("dragleave", onWinDragLeave);
      window.removeEventListener("pointermove", onWinPointer);
      window.removeEventListener("mousedown", onWinPointer);
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!dragOver) return;
    const clearStuck = () => {
      draggingOutRef.current = false;
      setDragOver(false);
    };
    window.addEventListener("pointermove", clearStuck, { once: true });
    window.addEventListener("mousedown", clearStuck, { once: true });
    return () => {
      window.removeEventListener("pointermove", clearStuck);
      window.removeEventListener("mousedown", clearStuck);
    };
  }, [dragOver]);

  useEffect(() => {
    if (!active || !snOk) {
      draggingOutRef.current = false;
      setDragOver(false);
    }
  }, [active, snOk]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dir = (await window.toolbox?.defaultPullDir?.()) || "";
        if (!cancelled) setDefaultPullDir(dir);
      } catch {
        if (!cancelled) setDefaultPullDir("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function goPathInput() {
    const raw = pathInput.trim().replace(/\\/g, "/") || "/";
    const loadedPath = (browsePath || "/").replace(/\/+$/, "") || "/";
    const prefix = loadedPath === "/" ? "/" : `${loadedPath}/`;
    if (raw.startsWith(prefix) && pathFilter) {
      const hit = entries.filter(
        (e) => e.is_dir && e.name.toLowerCase().includes(pathFilter.toLowerCase()),
      );
      if (hit.length === 1) {
        void run(`打开 ${hit[0].name}…`, () => loadDir(hit[0].path));
        return;
      }
      const exact = entries.find(
        (e) => e.is_dir && e.name.toLowerCase() === pathFilter.toLowerCase(),
      );
      if (exact) {
        void run(`打开 ${exact.name}…`, () => loadDir(exact.path));
        return;
      }
    }
    void run("打开目录…", () => loadDir(raw));
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function selectClick(e: MouseEvent, entry: RemoteFileEntry) {
    const multi = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    if (range && selected.length) {
      const paths = visible.map((x) => x.path);
      const anchor = selected[selected.length - 1];
      const i0 = paths.indexOf(anchor);
      const i1 = paths.indexOf(entry.path);
      if (i0 >= 0 && i1 >= 0) {
        const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
        setSelected(paths.slice(a, b + 1));
        return;
      }
    }
    if (multi) {
      setSelected((prev) =>
        prev.includes(entry.path)
          ? prev.filter((p) => p !== entry.path)
          : [...prev, entry.path],
      );
      return;
    }
    setSelected([entry.path]);
  }

  function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "AbortError";
  }

  async function pushFiles(files: File[] | DroppedUploadItem[]) {
    if (!snOk || !files.length) return;
    if (transferAbortRef.current) {
      toast.push("已有传输任务正在进行，请等待或先取消", "info");
      return;
    }
    const items: DroppedUploadItem[] = files.map((item) =>
      item instanceof File ? { file: item, relPath: item.name } : item,
    );
    const dest = dirAsRemote(browsePath || "/sdcard/");
    const ac = new AbortController();
    transferAbortRef.current = ac;
    let ok = 0;
    let cancelled = false;
    try {
      for (let i = 0; i < items.length; i++) {
        if (ac.signal.aborted) {
          cancelled = true;
          break;
        }
        const { file: f, relPath } = items[i];
        setTransfer({
          kind: "push",
          name: relPath,
          index: i + 1,
          totalCount: items.length,
          doneBytes: 0,
          totalBytes: f.size || 0,
          percent: f.size ? 0 : null,
          speedBps: 0,
        });
        setStatus(`上传 (${i + 1}/${items.length})：${relPath}`);
        const onProgress = (ev: TransferProgressEvent) => {
          setTransfer((prev) =>
            prev
              ? {
                  ...prev,
                  doneBytes: ev.done_bytes,
                  totalBytes: ev.total_bytes || prev.totalBytes,
                  percent: ev.percent,
                  speedBps: ev.speed_bps,
                }
              : prev,
          );
        };
        try {
          const hasSubDir = relPath.includes("/");
          const local = !hasSubDir ? fileLocalPath(f) : "";
          if (local) {
            const r = await api.pushPathStream(deviceSn, local, dest, {
              onProgress,
              signal: ac.signal,
            });
            append(`[push] ${r.local || local} → ${r.remote}\n${r.output || ""}`.trim());
            if (r.ok) ok += 1;
          } else {
            const remoteTarget = hasSubDir ? joinRemote(dest, relPath) : dest;
            const r = await api.pushFileStream(deviceSn, remoteTarget, f, {
              mkdirParent: hasSubDir,
              onProgress,
              signal: ac.signal,
            });
            append(`[push] ${relPath} → ${r.remote}\n${r.output || ""}`.trim());
            if (r.ok) ok += 1;
          }
        } catch (err) {
          if (isAbortError(err) || ac.signal.aborted) {
            cancelled = true;
            append(`[push] ${relPath}\n已取消`);
            break;
          }
          append(`[push] ${relPath}\n${toErrorMessage(err)}`);
        }
      }
    } finally {
      if (transferAbortRef.current === ac) transferAbortRef.current = null;
      setTransfer(null);
    }
    if (cancelled) {
      setStatus("已取消上传");
      toast.push("已取消上传到设备", "info");
    } else {
      const summary =
        items.length === 1
          ? `已上传 ${items[0].relPath} → ${dest}（${ok}/1）`
          : `已上传 ${ok}/${items.length} 个文件 → ${dest}`;
      setStatus(summary);
      toast.push(summary, ok === items.length ? "ok" : "warn");
    }
    await loadDir(browsePath || dest, { quiet: true });
  }

  function rememberPullDir(dir: string) {
    const d = (dir || "").trim();
    setPullDir(d);
    writePullDir(d);
  }

  /** 通过系统文件夹对话框选择本机目录（不可手输路径） */
  async function choosePullDirectory(opts?: {
    title?: string;
    remember?: boolean;
  }): Promise<string | null> {
    const pick = window.toolbox?.chooseDirectory;
    if (!pick) {
      setStatus("请使用桌面端选择目录（需重启应用以启用文件夹对话框）");
      return null;
    }
    const dir = await pick({
      title: opts?.title || "选择拉取保存目录",
      defaultPath: effectivePullDir || defaultPullDir || undefined,
    });
    if (!dir) return null;
    if (opts?.remember !== false) rememberPullDir(dir);
    return dir;
  }

  async function pullOne(
    remote: string,
    opts?: {
      open?: boolean;
      localDir?: string;
      onProgress?: (ev: TransferProgressEvent) => void;
      signal?: AbortSignal;
    },
  ) {
    // 空字符串 → API 默认 userdata/output/adb_pulls；有值则用所选目录
    const raw =
      opts?.localDir !== undefined ? opts.localDir : pullDir || defaultPullDir;
    const hint = asLocalDirHint(raw);
    const r = await api.pullStream(deviceSn, remote, hint, {
      onProgress: opts?.onProgress,
      signal: opts?.signal,
    });
    append((r.output || `已保存 ${r.saved_path}`).replace(/\r/g, "\n"));
    if (r.saved_path) {
      pullCache.current.set(remote, r.saved_path);
    }
    setStatus(r.ok ? `已拉取 → ${shortPath(r.saved_path, 48)}` : "拉取失败");
    if (opts?.open && r.ok && r.saved_path) {
      try {
        await api.openPath(r.saved_path);
      } catch {
        /* ignore */
      }
    }
    return r;
  }

  async function pullSelected() {
    await pullEntries(selectedEntries, { open: true });
  }

  async function createRemote(kind: "file" | "dir") {
    const base = dirAsRemote(browsePath || "/sdcard/");
    const name = await dialog.prompt({
      title: kind === "dir" ? "新建文件夹" : "新建文件",
      message: "输入名称",
      defaultValue: kind === "dir" ? "NewFolder" : "new.txt",
      okLabel: "创建",
    });
    if (!name?.trim()) return;
    const safe = name.trim().replace(/[\\/]/g, "");
    if (!safe) return;
    const target = `${base}${safe}`;
    await run(kind === "dir" ? "新建文件夹…" : "新建文件…", async () => {
      const r =
        kind === "dir"
          ? await api.mkdir(deviceSn, target)
          : await api.createFile(deviceSn, target);
      append(r.output || r.message);
      setStatus(r.message);
      await loadDir(browsePath || base, { quiet: true });
      setSelected([target]);
    });
  }

  async function refreshFillPreview(pct = fillPct, dir = fillDir) {
    if (!snOk) return;
    setFillPreviewBusy(true);
    try {
      const r = await api.fillMemoryPreview(
        deviceSn,
        pct,
        32,
        normalizeFillDirInput(dir),
      );
      setFillPreview({
        avail_label: r.avail_label,
        target_label: r.target_label,
        message: r.message,
        ok: r.ok,
        path: r.path,
        fill_dir: r.fill_dir,
      });
    } catch (e) {
      const msg = toErrorMessage(e);
      setFillPreview({
        avail_label: "—",
        target_label: "—",
        message: msg,
        ok: false,
      });
      toast.push(msg, "err");
    } finally {
      setFillPreviewBusy(false);
    }
  }

  function openFillDialog() {
    setFillOpen(true);
    if (!fillJob?.running) void refreshFillPreview(fillPct, fillDir);
  }

  async function startFillJob() {
    if (!snOk || fillJob?.running) return;
    const dir = normalizeFillDirInput(fillDir);
    try {
      const r = await api.fillMemory(deviceSn, fillPct, 32, dir);
      const job: FillJobView = {
        job_id: r.job_id,
        state: r.state,
        message: r.message,
        fill_pct: r.fill_pct,
        target_bytes: r.target_bytes,
        target_label: r.target_label,
        written_bytes: r.written_bytes,
        written_label: r.written_label,
        pct: r.pct,
        running: r.running,
      };
      fillJobIdRef.current = r.job_id;
      setFillJob(job);
      append(`填充已启动：${dir} · ${r.target_label}（${r.fill_pct}%）`);
    } catch (e) {
      const msg = toErrorMessage(e);
      append(msg);
      toast.push(msg, "err");
    }
  }

  async function stopFillJob() {
    const id = fillJob?.job_id || fillJobIdRef.current;
    if (!id) return;
    try {
      const r = await api.fillMemoryStop(id);
      toast.push(r.message || "已请求停止空间填充", "warn");
    } catch (e) {
      toast.push(`停止空间填充失败：${toErrorMessage(e)}`, "err");
    }
  }

  async function releaseMemoryFill() {
    if (fillJob?.running) {
      toast.push("填充进行中，请先停止再释放", "warn");
      return;
    }
    const dir = normalizeFillDirInput(fillDir);
    const ok = await dialog.confirm({
      title: "释放 eMMC 填充",
      message: "删除填充测试文件，释放空间。",
      detail: `${dir}/sei_toolbox_mem_fill_*.bin`,
      confirmLabel: "释放",
      cancelLabel: "取消",
    });
    if (!ok) return;
    setReleaseBusy(true);
    try {
      const r = await api.releaseMemoryFill(deviceSn, dir);
      append(r.message || (r.ok ? "已释放" : "释放失败"));
      if (r.ok) toast.push(r.message || "已释放", "ok");
      else toast.push(r.message || "释放失败", "err");
      setFillJob(null);
      fillJobIdRef.current = "";
      const cur = (browsePath || "").replace(/\/+$/, "");
      if (pathIsUnder(cur, dir)) {
        await loadDir(browsePath || dir, { quiet: true });
      }
    } catch (e) {
      const msg = toErrorMessage(e);
      append(msg);
      toast.push(msg, "err");
    } finally {
      setReleaseBusy(false);
    }
  }

  useEffect(() => {
    if (!fillOpen || fillJob?.running) return;
    const t = window.setTimeout(() => {
      void refreshFillPreview(fillPct, fillDir);
    }, 280);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillPct, fillDir, fillOpen, deviceSn]);

  useEffect(() => {
    if (!snOk || !active) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.fillMemoryActive(deviceSn);
        if (cancelled || !r.job) return;
        fillJobIdRef.current = r.job.job_id;
        setFillJob({
          job_id: r.job.job_id,
          state: r.job.state,
          message: r.job.message,
          fill_pct: r.job.fill_pct,
          target_bytes: r.job.target_bytes,
          target_label: r.job.target_label,
          written_bytes: r.job.written_bytes,
          written_label: r.job.written_label,
          pct: r.job.pct,
          running: r.job.running,
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snOk, active, deviceSn]);

  useEffect(() => {
    const id = fillJob?.job_id || fillJobIdRef.current;
    if (!id || !fillJob?.running) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.fillMemoryJob(id);
        if (cancelled) return;
        setFillJob({
          job_id: r.job_id,
          state: r.state,
          message: r.message,
          fill_pct: r.fill_pct,
          target_bytes: r.target_bytes,
          target_label: r.target_label,
          written_bytes: r.written_bytes,
          written_label: r.written_label,
          pct: r.pct,
          running: r.running,
        });
        if (!r.running) {
          append(r.message || (r.state === "done" ? "填充完成" : "填充结束"));
          if (r.state === "done") toast.push(r.message || "填充完成", "ok");
          else if (r.state === "error") toast.push(r.message || "填充失败", "err");
          else if (r.state === "stopped") toast.push(r.message || "已停止", "warn");
          const cur = (browsePath || "").replace(/\/+$/, "");
          const dir = normalizeFillDirInput(fillDir);
          if (pathIsUnder(cur, dir)) {
            void loadDir(browsePath || dir, { quiet: true });
          }
        }
      } catch {
        /* ignore poll errors */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillJob?.job_id, fillJob?.running]);

  async function deleteSelected() {
    const targets = selectedEntries;
    if (!targets.length) return;
    const names = targets.map((t) => t.name).join("、");
    const ok = await dialog.confirm({
      title: "删除文件",
      message: `确定删除？\n${names}\n共 ${targets.length} 项`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await run("删除…", async () => {
      let ok = 0;
      for (const e of targets) {
        const r = await api.deletePath(deviceSn, e.path, true);
        append(r.output || r.message);
        if (r.ok) {
          ok += 1;
          pullCache.current.delete(e.path);
        }
      }
      setStatus(`已删除 ${ok}/${targets.length}`);
      setSelected([]);
      await loadDir(browsePath || "/sdcard", { quiet: true });
    });
  }

  async function renameSelected() {
    const e = selectedEntries[0];
    if (!e) return;
    const next = await dialog.prompt({
      title: "重命名",
      message: `当前名称：${e.name}`,
      defaultValue: e.name,
      okLabel: "重命名",
    });
    if (!next || next.trim() === e.name) return;
    const safe = next.trim().replace(/[\\/]/g, "");
    if (!safe) return;
    const dst = joinRemote(browsePath, safe);
    await run("重命名…", async () => {
      const r = await api.renamePath(deviceSn, e.path, dst);
      append(r.output || r.message);
      setStatus(r.message);
      await loadDir(browsePath, { quiet: true });
      setSelected([dst]);
    });
  }

  function setClipboard(op: "copy" | "cut") {
    if (!selected.length) return;
    setClip({ op, paths: [...selected] });
    setStatus(op === "copy" ? `已复制 ${selected.length} 项` : `已剪切 ${selected.length} 项`);
  }

  async function pasteClipboard() {
    if (!clip?.paths.length) return;
    const destDir = dirAsRemote(browsePath);
    await run(clip.op === "cut" ? "移动…" : "粘贴…", async () => {
      let ok = 0;
      for (const src of clip.paths) {
        const name = src.split("/").filter(Boolean).pop() || "item";
        let dst = joinRemote(destDir, name);
        if (dst === src) {
          dst = joinRemote(destDir, `${name}_copy`);
        }
        try {
          if (clip.op === "cut") {
            const r = await api.renamePath(deviceSn, src, dst);
            append(r.output || r.message);
            if (r.ok) ok += 1;
          } else {
            const r = await api.copyPath(deviceSn, src, dst, true);
            append(r.output || r.message);
            if (r.ok) ok += 1;
          }
        } catch (err) {
          append(toErrorMessage(err));
        }
      }
      if (clip.op === "cut") setClip(null);
      setStatus(`完成 ${ok}/${clip.paths.length}`);
      await loadDir(browsePath, { quiet: true });
    });
  }

  async function chmodSelected() {
    const e = selectedEntries[0];
    if (!e) return;
    const mode = await dialog.prompt({
      title: "修改权限",
      message: "八进制权限，如 644 / 755",
      defaultValue: "644",
      okLabel: "应用",
    });
    if (!mode?.trim()) return;
    await run("chmod…", async () => {
      const r = await api.chmodPath(deviceSn, e.path, mode.trim());
      append(r.output || r.message);
      setStatus(r.message);
      await loadDir(browsePath, { quiet: true });
    });
  }

  async function showProps(path?: string) {
    const p = path || selected[0];
    if (!p) return;
    await run("读取属性…", async () => {
      const r = await api.remoteStat(deviceSn, p);
      const lines = [
        `路径: ${r.path}`,
        `名称: ${r.name}`,
        `类型: ${r.is_dir ? "目录" : r.is_link ? "链接" : "文件"}`,
        r.mode ? `权限: ${r.mode}` : "",
        r.size != null ? `大小: ${formatSize(r.size)}` : "",
        r.mtime ? `修改: ${r.mtime}` : "",
        r.owner ? `所有者: ${r.owner}:${r.group || ""}` : "",
        r.link_target ? `链接到: ${r.link_target}` : "",
        r.raw ? `原始: ${r.raw}` : "",
      ].filter(Boolean);
      append(lines.join("\n"));
      await dialog.alert({ title: "属性", message: lines.join("\n") });
      setStatus("已显示属性");
    });
  }

  async function copyPaths() {
    const text = (selected.length ? selected : [browsePath]).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus("路径已复制");
      toast.push("已复制设备路径", "ok");
    } catch {
      await dialog.prompt({
        title: "复制路径",
        message: "请手动复制以下路径",
        defaultValue: text,
        okLabel: "关闭",
      });
    }
  }

  async function pullEntries(
    targets: RemoteFileEntry[],
    opts?: { open?: boolean; pickDir?: boolean },
  ) {
    if (!targets.length) return;
    if (transferAbortRef.current) {
      toast.push("已有传输任务正在进行，请等待或先取消", "info");
      return;
    }
    // 默认直接拉到已配置/默认目录；仅 pickDir 时才弹文件夹对话框
    let dest = pullDir || defaultPullDir || "";
    if (opts?.pickDir) {
      const picked = await choosePullDirectory({
        remember: true,
        title: "选择保存到哪个本机文件夹",
      });
      if (picked == null) {
        setStatus("就绪");
        return;
      }
      dest = picked;
    }
    const ac = new AbortController();
    transferAbortRef.current = ac;
    let ok = 0;
    let cancelled = false;
    try {
      for (let i = 0; i < targets.length; i++) {
        if (ac.signal.aborted) {
          cancelled = true;
          break;
        }
        const e = targets[i];
        setTransfer({
          kind: "pull",
          name: e.name,
          index: i + 1,
          totalCount: targets.length,
          doneBytes: 0,
          totalBytes: e.is_dir ? 0 : e.size || 0,
          percent: !e.is_dir && e.size ? 0 : null,
          speedBps: 0,
        });
        setStatus(`拉取 (${i + 1}/${targets.length})：${e.name}`);
        try {
          const r = await pullOne(e.path, {
            open: Boolean(opts?.open) && targets.length === 1,
            localDir: dest,
            signal: ac.signal,
            onProgress: (ev) => {
              setTransfer((prev) =>
                prev
                  ? {
                      ...prev,
                      doneBytes: ev.done_bytes,
                      totalBytes: ev.total_bytes || prev.totalBytes,
                      percent: ev.percent,
                      speedBps: ev.speed_bps,
                    }
                  : prev,
              );
            },
          });
          if (r.ok) ok += 1;
        } catch (err) {
          if (isAbortError(err) || ac.signal.aborted) {
            cancelled = true;
            append(`[pull] ${e.name}\n已取消`);
            break;
          }
          append(`[pull] ${e.name}\n${toErrorMessage(err)}`);
        }
      }
    } finally {
      if (transferAbortRef.current === ac) transferAbortRef.current = null;
      setTransfer(null);
    }
    if (cancelled) {
      setStatus("已取消拉取");
      toast.push("已取消拉取", "info");
      return;
    }
    const dirs = targets.filter((t) => t.is_dir).length;
    const files = targets.length - dirs;
    const kind =
      dirs && files
        ? `${files} 文件 / ${dirs} 文件夹`
        : dirs
          ? `${dirs} 个文件夹`
          : `${files} 个文件`;
    const where = dest || defaultPullDir || "userdata/output/adb_pulls";
    const summary =
      targets.length === 1
        ? `已拉取 ${targets[0].name} → ${shortPath(where, 40)}`
        : `已拉取 ${ok}/${targets.length}（${kind}）→ ${shortPath(where, 40)}`;
    setStatus(summary);
    toast.push(summary, ok === targets.length ? "ok" : "warn");
  }

  function onRowActivate(entry: RemoteFileEntry) {
    if (entry.is_dir) {
      void run(`打开 ${entry.name}…`, () => loadDir(entry.path));
      return;
    }
    if (isPreviewableFileName(entry.name)) {
      void openFilePreview(entry);
      return;
    }
    void pullEntries([entry], { open: true });
  }

  function toggleCurrentBookmark() {
    const cur = (browsePath || "/").replace(/\/+$/, "") || "/";
    if (SHORTCUTS.some((s) => s.path === cur)) {
      toast.push("该目录已在默认快捷栏中", "info");
      return;
    }
    setBookmarks((prev) => {
      const exists = prev.some((b) => b.path === cur);
      const next = exists
        ? prev.filter((b) => b.path !== cur)
        : [
            ...prev,
            {
              path: cur,
              label: cur === "/" ? "/" : cur.split("/").filter(Boolean).pop() || cur,
            },
          ];
      saveBookmarks(next);
      toast.push(exists ? `已取消收藏 ${cur}` : `已收藏 ${cur}`, "ok");
      return next;
    });
  }

  async function runRemoteFind() {
    const q = findQuery.trim();
    if (!q || !snOk || findBusy) return;
    setFindBusy(true);
    try {
      const r = await api.fsFind(deviceSn, browsePath || "/", q);
      setFindItems(r.items || []);
      setStatus(`找到 ${r.count} 项匹配「${q}」`);
    } catch (e) {
      toast.push(`查找「${q}」失败：${toErrorMessage(e)}`, "err");
    } finally {
      setFindBusy(false);
    }
  }

  async function openFilePreview(entry: RemoteFileEntry) {
    if (entry.is_dir || !snOk) return;
    setPreviewOpen(true);
    setPreviewBusy(true);
    setPreviewData(null);
    setPreviewDraft("");
    try {
      const r = await api.fsRead(deviceSn, entry.path);
      setPreviewData(r);
      if (r.kind === "text") setPreviewDraft(r.text || "");
    } catch (e) {
      toast.push(`预览 ${entry.name} 失败：${toErrorMessage(e)}`, "err");
      setPreviewOpen(false);
    } finally {
      setPreviewBusy(false);
    }
  }

  async function saveFilePreview() {
    if (!previewData || previewData.kind !== "text" || previewSaving) return;
    setPreviewSaving(true);
    try {
      const r = await api.fsWrite(deviceSn, previewData.path, previewDraft);
      append(`[write] ${previewData.path}\n${r.output || ""}`.trim());
      if (r.ok) {
        toast.push(`已保存 ${previewData.name} 到设备`, "ok");
        setPreviewOpen(false);
        await loadDir(browsePath || "/", { quiet: true });
      } else {
        toast.push(`保存 ${previewData.name} 失败：${r.output || "未知错误"}`, "err");
      }
    } catch (e) {
      toast.push(`保存 ${previewData.name} 失败：${toErrorMessage(e)}`, "err");
    } finally {
      setPreviewSaving(false);
    }
  }

  async function calcMd5(entry: RemoteFileEntry) {
    if (entry.is_dir || !snOk) return;
    await run(`计算 MD5: ${entry.name}…`, async () => {
      const r = await api.fsMd5(deviceSn, entry.path);
      append(`[md5] ${entry.path} = ${r.md5}`);
      setStatus(`MD5: ${r.md5}`);
      try {
        await navigator.clipboard.writeText(r.md5);
        toast.push(`MD5 已复制：${r.md5}`, "ok");
      } catch {
        await dialog.alert({ title: `MD5 · ${entry.name}`, message: r.md5 });
      }
    });
  }

  const canUp = snOk && !busy && parentPath !== browsePath;
  const hasSel = selected.length > 0;
  const footMeta = [
    `${visible.length} 项`,
    hasSel ? `已选 ${selected.length}` : "",
    clip ? `${clip.op === "cut" ? "剪切" : "复制"} ${clip.paths.length}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const ensureDragCached = useCallback(
    (entry: RemoteFileEntry, opts?: { trackProgress?: boolean }): Promise<string | null> => {
      const existing = pullCache.current.get(entry.path);
      if (existing) return Promise.resolve(existing);
      const inflight = pullInFlight.current.get(entry.path);
      if (inflight) return inflight;
      const track = Boolean(opts?.trackProgress) && !transferAbortRef.current;
      const ac = track ? new AbortController() : undefined;
      if (track && ac) {
        transferAbortRef.current = ac;
        setTransfer({
          kind: "pull",
          name: entry.name,
          index: 1,
          totalCount: 1,
          doneBytes: 0,
          totalBytes: entry.size || 0,
          percent: entry.size ? 0 : null,
          speedBps: 0,
        });
      }
      const p = (
        track
          ? api.pullStream(deviceSn, entry.path, "", {
              signal: ac?.signal,
              onProgress: (ev) => {
                setTransfer((prev) =>
                  prev
                    ? {
                        ...prev,
                        doneBytes: ev.done_bytes,
                        totalBytes: ev.total_bytes || prev.totalBytes,
                        percent: ev.percent,
                        speedBps: ev.speed_bps,
                      }
                    : prev,
                );
              },
            })
          : api.pull(deviceSn, entry.path, "")
      )
        .then((r) => {
          if (r.saved_path) {
            pullCache.current.set(entry.path, r.saved_path);
            return r.saved_path;
          }
          return null;
        })
        .catch(() => null)
        .finally(() => {
          pullInFlight.current.delete(entry.path);
          if (track && ac) {
            if (transferAbortRef.current === ac) transferAbortRef.current = null;
            setTransfer(null);
          }
        });
      pullInFlight.current.set(entry.path, p);
      return p;
    },
    [deviceSn],
  );

  const handleHoverPrefetch = useCallback(
    (entry: RemoteFileEntry) => {
      if (hoverTimerRef.current != null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (entry.is_dir || !snOk) return;
      if (pullCache.current.has(entry.path) || pullInFlight.current.has(entry.path)) return;
      if (entry.size != null && entry.size > PREFETCH_MAX_BYTES) return;
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        void ensureDragCached(entry);
      }, 260);
    },
    [snOk, ensureDragCached],
  );

  const handleHoverCancel = useCallback(() => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleRowClick = useCallback(
    (ev: MouseEvent<HTMLDivElement>, entry: RemoteFileEntry) => {
      selectClick(ev, entry);
      listRef.current?.focus();
      const now = Date.now();
      const prev = lastClickRef.current;
      if (
        prev &&
        prev.path === entry.path &&
        now - prev.t < 350 &&
        !ev.ctrlKey &&
        !ev.shiftKey
      ) {
        onRowActivate(entry);
      }
      lastClickRef.current = { path: entry.path, t: now };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, selected, deviceSn, browsePath, pullDir, defaultPullDir],
  );

  const handleRowContextMenu = useCallback(
    (ev: MouseEvent<HTMLDivElement>, entry: RemoteFileEntry) => {
      ev.preventDefault();
      ev.stopPropagation();
      setSelected((prev) => (prev.includes(entry.path) ? prev : [entry.path]));
      const pos = clampMenu(ev.clientX, ev.clientY);
      setMenu({ ...pos, path: entry.path });
    },
    [],
  );

  const handleRowDragStart = useCallback(
    (ev: DragEvent<HTMLDivElement>, entry: RemoteFileEntry) => {
      if (entry.is_dir || !snOk) {
        ev.preventDefault();
        return;
      }
      const cached = pullCache.current.get(entry.path);
      if (cached && window.toolbox?.startDrag) {
        ev.preventDefault();
        draggingOutRef.current = true;
        dragOutAtRef.current = Date.now();
        setDragOver(false);
        window.toolbox.startDrag(cached);
        setStatus(`拖出 ${entry.name}`);
        return;
      }
      ev.preventDefault();
      const alreadyRunning = pullInFlight.current.has(entry.path);
      setStatus(`正在准备拖出 ${entry.name}…`);
      if (!alreadyRunning) {
        toast.push(`正在拉取 ${entry.name}，完成后即可拖出`, "info");
      }
      void ensureDragCached(entry, { trackProgress: true }).then((savedPath) => {
        if (savedPath) {
          setStatus(`已就绪，请再次拖动 ${entry.name} 拖出到电脑`);
          toast.push(`${entry.name} 已就绪，可拖出到电脑`, "ok");
        } else {
          setStatus(`拉取 ${entry.name} 未完成`);
        }
      });
    },
    [snOk, ensureDragCached, setStatus, toast],
  );

  async function runAdbRoot() {
    if (!snOk || busy) return;
    await run("adb root…", async () => {
      const r = await api.deviceRoot(deviceSn);
      const msg = (r.message || "").trim() || "已获取 Root 权限";
      setRooted(true);
      append(`adb root: ${msg}`);
      toast.push(msg, "ok");
      await loadDir(browsePath || "/");
    });
  }

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <div className="files-nav-row">
          <button
            type="button"
            className="files-icon-btn"
            disabled={!canUp}
            title="上级目录"
            onClick={() => void run("上级…", () => loadDir(parentPath || "/"))}
          >
            ←
          </button>
          <div
            className="files-path-field"
            onClick={(e) => {
              if (editingPath || !snOk || busy) return;
              if ((e.target as HTMLElement).closest("button")) return;
              setEditingPath(true);
              window.requestAnimationFrame(() => {
                pathInputRef.current?.focus();
                pathInputRef.current?.select();
              });
            }}
            title="点击空白处可直接输入路径或筛选当前目录"
          >
            {editingPath || pathFilter ? (
              <>
                <input
                  ref={pathInputRef}
                  className="files-path-input"
                  value={pathInput}
                  disabled={!snOk || busy}
                  onChange={(e) => setPathInput(e.target.value.replace(/\\/g, "/"))}
                  onBlur={() => {
                    if (!pathFilter) setEditingPath(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && snOk && !busy) {
                      e.preventDefault();
                      setEditingPath(false);
                      goPathInput();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setPathInput(dirAsRemote(browsePath));
                      setEditingPath(false);
                    }
                  }}
                  placeholder="/sdcard/"
                  spellCheck={false}
                  title="路径；继续输入可筛选当前目录"
                />
                {pathFilter ? (
                  <button
                    type="button"
                    className="files-path-clear"
                    title="清除筛选"
                    onClick={() => {
                      setPathInput(dirAsRemote(browsePath));
                      setEditingPath(false);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </>
            ) : (
              <div className="files-breadcrumbs-inline" aria-label="路径导航">
                <button
                  type="button"
                  className="files-crumb"
                  disabled={!snOk || busy}
                  onClick={() => void run("打开 /…", () => loadDir("/"))}
                >
                  /
                </button>
                {(browsePath || "/")
                  .split("/")
                  .filter(Boolean)
                  .map((seg, idx, arr) => {
                    const target = `/${arr.slice(0, idx + 1).join("/")}`;
                    const isLast = idx === arr.length - 1;
                    return (
                      <span key={target} className="files-crumb-seg">
                        <span className="files-crumb-sep" aria-hidden>
                          ›
                        </span>
                        <button
                          type="button"
                          className={`files-crumb${isLast ? " is-cur" : ""}`}
                          disabled={!snOk || busy}
                          onClick={() => void run(`打开 ${target}…`, () => loadDir(target))}
                        >
                          {seg}
                        </button>
                      </span>
                    );
                  })}
                <button
                  type="button"
                  className="files-path-edit-btn"
                  disabled={!snOk || busy}
                  title="编辑路径 / 筛选"
                  onClick={() => {
                    setEditingPath(true);
                    window.requestAnimationFrame(() => {
                      pathInputRef.current?.focus();
                      pathInputRef.current?.select();
                    });
                  }}
                >
                  ✎
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="files-icon-btn"
            disabled={!snOk || busy}
            title="刷新"
            onClick={() => void run("刷新…", () => loadDir(browsePath || "/"))}
          >
            ↻
          </button>
          <div className="files-shortcuts" role="toolbar" aria-label="常用目录">
            {SHORTCUTS.map((item) => {
              const on = (browsePath || "").replace(/\/$/, "") === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={`files-chip${on ? " on" : ""}`}
                  disabled={!snOk || busy}
                  title={item.path}
                  onClick={() =>
                    void run(`打开 ${item.path}…`, () => loadDir(item.path))
                  }
                >
                  {item.label}
                </button>
              );
            })}
            {bookmarks.map((item) => {
              const on = ((browsePath || "").replace(/\/+$/, "") || "/") === item.path;
              return (
                <button
                  key={item.path}
                  type="button"
                  className={`files-chip is-bookmark${on ? " on" : ""}`}
                  disabled={!snOk || busy}
                  title={`${item.path}\n右键可取消收藏`}
                  onClick={() =>
                    void run(`打开 ${item.path}…`, () => loadDir(item.path))
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setBookmarks((prev) => {
                      const next = prev.filter((b) => b.path !== item.path);
                      saveBookmarks(next);
                      return next;
                    });
                    toast.push(`已取消收藏 ${item.path}`, "info");
                  }}
                >
                  ★ {item.label}
                </button>
              );
            })}
            <button
              type="button"
              className={`files-icon-btn files-fav-btn${
                bookmarks.some(
                  (b) => b.path === (((browsePath || "").replace(/\/+$/, "") || "/")),
                )
                  ? " on"
                  : ""
              }`}
              disabled={!snOk || busy}
              title="收藏或取消收藏当前目录"
              onClick={toggleCurrentBookmark}
            >
              ★
            </button>
            <button
              type="button"
              className={`files-chip${findOpen ? " on" : ""}`}
              disabled={!snOk || busy}
              title="在当前目录下递归搜索文件"
              onClick={() => setFindOpen((v) => !v)}
            >
              递归查找
            </button>
          </div>
        </div>

        {findOpen ? (
          <div className="files-find-bar">
            <input
              className="field mono files-find-input"
              value={findQuery}
              disabled={!snOk || findBusy}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder={`在 ${browsePath || "/"} 下递归查找文件名…`}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runRemoteFind();
                }
              }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!snOk || findBusy || !findQuery.trim()}
              onClick={() => void runRemoteFind()}
            >
              {findBusy ? "查找中…" : "查找"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFindOpen(false);
                setFindItems([]);
              }}
            >
              收起
            </Button>
          </div>
        ) : null}

        {findOpen && findItems.length > 0 ? (
          <div className="files-find-results">
            {findItems.map((it) => (
              <button
                key={it.path}
                type="button"
                className="files-find-hit"
                title={`跳转到 ${it.parent}`}
                onClick={() => {
                  void run(`打开 ${it.parent}…`, async () => {
                    await loadDir(it.parent);
                    setSelected([it.path]);
                  });
                }}
              >
                <strong>{it.name}</strong>
                <span>{it.path}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="files-ops-row">
          <div className="files-ops-group" role="group" aria-label="eMMC 填充">
            <Button
              size="sm"
              variant="primary"
              disabled={!snOk}
              title="按百分比填充 eMMC 可用空间"
              onClick={() => openFillDialog()}
            >
              {fillJob?.running ? `填充 ${fillJob.pct}%` : "填充"}
            </Button>
            <Button
              size="sm"
              disabled={!snOk || releaseBusy || Boolean(fillJob?.running)}
              title="删除 eMMC 填充测试文件"
              onClick={() => void releaseMemoryFill()}
            >
              {releaseBusy ? "释放中…" : "释放"}
            </Button>
          </div>
          <span className="files-ops-sep" aria-hidden />
          <div className="files-ops-group" role="group" aria-label="权限">
            <Button
              size="sm"
              variant={rooted ? "primary" : "ghost"}
              disabled={!snOk || busy}
              title="执行 adb root 以访问受限目录（需要设备支持）"
              onClick={() => void runAdbRoot()}
            >
              {rooted ? "已 Root" : "Root"}
            </Button>
          </div>
          <span className="files-ops-sep" aria-hidden />
          <div className="files-ops-group files-ops-main" role="group" aria-label="文件操作">
            {hasSel ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!snOk || busy}
                  onClick={() =>
                    void run("拉取…", () => pullSelected())
                  }
                >
                  拉取{selected.length > 1 ? ` ${selected.length}` : ""}
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  disabled={!snOk || busy}
                  onClick={() => void deleteSelected()}
                >
                  删除
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!snOk || busy}
                  title="新建文件夹"
                  onClick={() => void createRemote("dir")}
                >
                  新建
                </Button>
                {clip ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!snOk || busy}
                    onClick={() => void pasteClipboard()}
                  >
                    粘贴
                  </Button>
                ) : null}
                <label
                  className={`btn primary ui-btn ui-btn-sm file-btn${
                    busy || !snOk ? " disabled" : ""
                  }`}
                >
                  上传
                  <input
                    type="file"
                    multiple
                    disabled={!snOk || busy}
                    hidden
                    onChange={(e) => {
                      const list = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (!list.length) return;
                      void pushFiles(list);
                    }}
                  />
                </label>
              </>
            )}
          </div>
        </div>
      </div>

      <div
        ref={listShellRef}
        className={`files-list-shell${dragOver ? " drag" : ""}`}
        onDragEnter={(e) => {
          if (draggingOutRef.current || !snOk || !hasDraggedFiles(e.dataTransfer)) return;
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragOver={(e) => {
          if (draggingOutRef.current || !snOk || !hasDraggedFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!dragOver) return;
          const next = e.relatedTarget as Node | null;
          if (next && listShellRef.current?.contains(next)) return;
          setDragOver(false);
        }}
        onDrop={(e) => {
          const wasDraggingOut = draggingOutRef.current;
          draggingOutRef.current = false;
          setDragOver(false);
          if (wasDraggingOut || !snOk) return;
          if (!hasDraggedFiles(e.dataTransfer)) return;
          e.preventDefault();
          const dt = e.dataTransfer;
          void collectDroppedUploads(dt).then((items) => {
            if (items.length) void pushFiles(items);
          });
        }}
      >
        {dragOver ? (
          <div className="files-drop-hint" aria-hidden>
            释放以上传到当前目录
          </div>
        ) : null}

        {transfer ? (
          <div className="files-transfer-card" role="status" aria-live="polite">
            <div className="files-transfer-head">
              <span className={`files-transfer-badge ${transfer.kind}`}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                  {transfer.kind === "push" ? (
                    <path
                      fill="currentColor"
                      d="M8 2.2 3.8 6.4l1.1 1.1 2.35-2.35V12h1.5V5.15l2.35 2.35 1.1-1.1L8 2.2ZM3 13.2h10v1.3H3v-1.3Z"
                    />
                  ) : (
                    <path
                      fill="currentColor"
                      d="M8 11.8 12.2 7.6l-1.1-1.1-2.35 2.35V2h-1.5v6.85L4.9 6.5 3.8 7.6 8 11.8ZM3 13.2h10v1.3H3v-1.3Z"
                    />
                  )}
                </svg>
                {transfer.kind === "push" ? "上传" : "拉取"}
                {transfer.totalCount > 1 ? ` ${transfer.index}/${transfer.totalCount}` : ""}
              </span>
              <span className="files-transfer-pct">
                {transfer.percent != null ? `${transfer.percent}%` : "传输中"}
              </span>
              <button
                type="button"
                className="files-transfer-cancel"
                title="取消当前传输"
                onClick={() => transferAbortRef.current?.abort()}
              >
                取消
              </button>
            </div>
            <div className="files-transfer-name" title={transfer.name}>
              {transfer.name}
            </div>
            <div className="files-transfer-track" aria-hidden>
              <span
                className={`files-transfer-fill${transfer.percent == null ? " indet" : ""}`}
                style={
                  transfer.percent != null
                    ? { width: `${Math.max(2, Math.min(100, transfer.percent))}%` }
                    : undefined
                }
              />
            </div>
            <div className="files-transfer-meta">
              <span>
                {transfer.totalBytes > 0
                  ? `${formatSize(transfer.doneBytes)} / ${formatSize(transfer.totalBytes)}`
                  : transfer.doneBytes > 0
                    ? formatSize(transfer.doneBytes)
                    : "准备中…"}
              </span>
              <span>{transfer.speedBps > 0 ? `${formatSize(transfer.speedBps)}/s` : "—"}</span>
            </div>
          </div>
        ) : null}

        <div
          ref={listRef}
          className={`files-list${dragOver ? " drag" : ""}${busy ? " busy" : ""}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (!snOk || busy) return;
            if (e.key === "Delete" && selected.length) {
              e.preventDefault();
              void deleteSelected();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
              e.preventDefault();
              setClipboard("copy");
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
              e.preventDefault();
              setClipboard("cut");
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
              e.preventDefault();
              void pasteClipboard();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
              e.preventDefault();
              setSelected(visible.map((x) => x.path));
            }
            if (e.key === "F2" && selected.length === 1) {
              e.preventDefault();
              void renameSelected();
            }
            if (e.key === "Enter" && selectedEntries[0]) {
              e.preventDefault();
              onRowActivate(selectedEntries[0]);
            }
            if (e.key === "Backspace" && canUp) {
              e.preventDefault();
              void run("上级…", () => loadDir(parentPath || "/"));
            }
          }}
          onContextMenu={(ev) => {
            if ((ev.target as HTMLElement).closest(".files-table-row")) return;
            ev.preventDefault();
            const pos = clampMenu(ev.clientX, ev.clientY);
            setMenu({ ...pos, path: browsePath });
          }}
        >
          <div className="files-table-head">
            <button
              type="button"
              className={`files-col name${sortKey === "name" ? " sorted" : ""}`}
              onClick={() => toggleSort("name")}
            >
              名称 <span className="sort-mark">{sortMark(sortKey === "name", sortAsc)}</span>
            </button>
            <button
              type="button"
              className={`files-col size${sortKey === "size" ? " sorted" : ""}`}
              onClick={() => toggleSort("size")}
            >
              大小 <span className="sort-mark">{sortMark(sortKey === "size", sortAsc)}</span>
            </button>
            <button
              type="button"
              className={`files-col mtime${sortKey === "mtime" ? " sorted" : ""}`}
              onClick={() => toggleSort("mtime")}
            >
              修改 <span className="sort-mark">{sortMark(sortKey === "mtime", sortAsc)}</span>
            </button>
            <button
              type="button"
              className={`files-col mode${sortKey === "mode" ? " sorted" : ""}`}
              onClick={() => toggleSort("mode")}
            >
              权限 <span className="sort-mark">{sortMark(sortKey === "mode", sortAsc)}</span>
            </button>
          </div>

          {!loaded && snOk ? (
            <div className="files-empty">正在加载…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              className="files-empty"
              title={
                entries.length === 0
                  ? snOk
                    ? "此目录为空"
                    : "尚未绑定设备"
                  : "没有匹配项"
              }
              description={
                entries.length === 0
                  ? snOk
                    ? "拖入本机文件即可上传。"
                    : "打开设备标签后浏览文件。"
                  : "调整路径筛选或显示隐藏文件。"
              }
            />
          ) : (
            visible.map((e) => (
              <FileRow
                key={e.path}
                entry={e}
                selected={selected.includes(e.path)}
                cut={clip?.op === "cut" && clip.paths.includes(e.path)}
                snOk={snOk}
                onClick={handleRowClick}
                onContextMenu={handleRowContextMenu}
                onHoverPrefetch={handleHoverPrefetch}
                onHoverCancel={handleHoverCancel}
                onDragStart={handleRowDragStart}
              />
            ))
          )}
        </div>
      </div>

      <div className="files-foot">
        <span className="files-meta">{footMeta || "—"}</span>
        <span className="files-foot-sep" aria-hidden />
        <button
          type="button"
          className="files-foot-link"
          disabled={busy}
          title={effectivePullDir || "选择拉取目录"}
          onClick={() =>
            void choosePullDirectory({
              title: "选择拉取保存目录",
              remember: true,
            }).then((dir) => {
              if (dir) setStatus(`拉取目录: ${dir}`);
            })
          }
        >
          拉取到{" "}
          {pullDir
            ? shortPath(pullDir, 32)
            : defaultPullDir
              ? `${shortPath(defaultPullDir, 28)}（默认）`
              : "adb_pulls（默认）"}
        </button>
        {pullDir ? (
          <button
            type="button"
            className="files-foot-link muted"
            disabled={busy}
            onClick={() => {
              rememberPullDir("");
              setStatus("已恢复默认目录");
            }}
          >
            恢复默认
          </button>
        ) : null}
        {dfInfo?.avail ? (
          <>
            <span className="files-foot-sep" aria-hidden>
              ·
            </span>
            <span
              className="files-df-badge"
              title={`挂载点 ${dfInfo.mount || ""} · 总容量 ${dfInfo.total || ""}`}
            >
              可用 {dfInfo.avail}
              {dfInfo.total ? ` / ${dfInfo.total}` : ""}
              {dfInfo.use_pct ? ` (${dfInfo.use_pct})` : ""}
            </span>
          </>
        ) : null}
        <label className="files-check grow-end" title="显示以 . 开头的隐藏项">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          隐藏文件
        </label>
      </div>

      {menu ? (
        <div
          ref={menuRef}
          className="files-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.path === browsePath ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  void createRemote("dir");
                }}
              >
                新建文件夹
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  void createRemote("file");
                }}
              >
                新建文件
              </button>
              <div className="files-menu-sep" />
            </>
          ) : (
            <>
              {entries.find((x) => x.path === menu.path)?.is_dir ? (
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    const e = entries.find((x) => x.path === menu.path);
                    if (e) void run(`打开 ${e.name}…`, () => loadDir(e.path));
                  }}
                >
                  打开
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    const e = entries.find((x) => x.path === menu.path);
                    if (e) void openFilePreview(e);
                  }}
                >
                  预览 / 编辑
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  const e = entries.find((x) => x.path === menu.path);
                  const targets =
                    e && selected.includes(e.path) && selectedEntries.length
                      ? selectedEntries
                      : e
                        ? [e]
                        : [];
                  if (!targets.length) return;
                  void pullEntries(targets, { open: true });
                }}
              >
                拉取
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenu(null);
                  const e = entries.find((x) => x.path === menu.path);
                  const targets =
                    e && selected.includes(e.path) && selectedEntries.length
                      ? selectedEntries
                      : e
                        ? [e]
                        : [];
                  if (!targets.length) return;
                  void pullEntries(targets, { open: true, pickDir: true });
                }}
              >
                拉取到其他目录…
              </button>
            </>
          )}
          <button
            type="button"
            disabled={selected.length !== 1}
            onClick={() => {
              setMenu(null);
              void renameSelected();
            }}
          >
            重命名
          </button>
          <button
            type="button"
            disabled={!hasSel}
            onClick={() => {
              setMenu(null);
              setClipboard("copy");
            }}
          >
            复制
          </button>
          <button
            type="button"
            disabled={!hasSel}
            onClick={() => {
              setMenu(null);
              setClipboard("cut");
            }}
          >
            剪切
          </button>
          <button
            type="button"
            disabled={!clip}
            onClick={() => {
              setMenu(null);
              void pasteClipboard();
            }}
          >
            粘贴到此处
          </button>
          <div className="files-menu-sep" />
          <button
            type="button"
            disabled={!hasSel}
            onClick={() => {
              setMenu(null);
              void copyPaths();
            }}
          >
            复制路径
          </button>
          <button
            type="button"
            disabled={selected.length !== 1}
            onClick={() => {
              setMenu(null);
              void chmodSelected();
            }}
          >
            修改权限
          </button>
          {menu.path !== browsePath &&
          !entries.find((x) => x.path === menu.path)?.is_dir ? (
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                const e = entries.find((x) => x.path === menu.path);
                if (e) void calcMd5(e);
              }}
            >
              计算 MD5
            </button>
          ) : null}
          <button
            type="button"
            disabled={!hasSel && menu.path === browsePath}
            onClick={() => {
              setMenu(null);
              void showProps(menu.path === browsePath ? selected[0] : menu.path);
            }}
          >
            属性
          </button>
          <div className="files-menu-sep" />
          <button
            type="button"
            className="danger"
            disabled={!hasSel}
            onClick={() => {
              setMenu(null);
              void deleteSelected();
            }}
          >
            删除
          </button>
        </div>
      ) : null}

      <Modal
        open={fillOpen}
        onClose={() => setFillOpen(false)}
        title={fillJob?.running ? "eMMC 填充进度" : "填充 eMMC"}
        size="sm"
        footer={
          fillJob?.running ? (
            <>
              <Button onClick={() => setFillOpen(false)}>后台继续</Button>
              <Button variant="danger" onClick={() => void stopFillJob()}>
                停止
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setFillOpen(false)}>关闭</Button>
              {fillJob && fillJob.state !== "running" ? (
                <Button
                  onClick={() => {
                    setFillJob(null);
                    fillJobIdRef.current = "";
                    void refreshFillPreview(fillPct, fillDir);
                  }}
                >
                  再填一次
                </Button>
              ) : null}
              <Button
                variant="primary"
                disabled={!snOk || !fillPreview?.ok || fillPreviewBusy}
                onClick={() => void startFillJob()}
              >
                开始填充
              </Button>
            </>
          )
        }
      >
        {fillJob?.running || (fillJob && fillJob.state !== "running" && fillOpen) ? (
          <div className="files-fill-progress">
            <div className="files-fill-progress-meta">
              <strong>{fillJob.pct}%</strong>
              <span>
                {fillJob.written_label || "0 B"} / {fillJob.target_label || "—"}
              </span>
            </div>
            <div className="files-fill-bar" aria-hidden>
              <span
                className="files-fill-bar-fill"
                style={{ width: `${Math.max(2, Math.min(100, fillJob.pct || 0))}%` }}
              />
            </div>
            <p className="files-fill-hint">{fillJob.message || "进行中…"}</p>
            <p className="files-fill-note">关闭后可继续，再点「填充」查看进度。</p>
          </div>
        ) : (
          <div className="files-fill-form">
            <label className="files-fill-label">
              填充路径
              <input
                className="field"
                value={fillDir}
                disabled={!snOk}
                spellCheck={false}
                autoComplete="off"
                placeholder={DEFAULT_FILL_DIR}
                onChange={(e) => setFillDir(e.target.value)}
                onBlur={() => setFillDir(normalizeFillDirInput(fillDir))}
                aria-label="填充路径"
              />
              <div className="files-fill-path-chips" role="group" aria-label="常用填充路径">
                {FILL_DIR_PRESETS.map((item) => {
                  const on = normalizeFillDirInput(fillDir) === item.path;
                  return (
                    <button
                      key={item.path}
                      type="button"
                      className={`files-chip${on ? " on" : ""}`}
                      disabled={!snOk}
                      title={item.path}
                      onClick={() => setFillDir(item.path)}
                    >
                      {item.label}
                    </button>
                  );
                })}
                {browsePath ? (
                  <button
                    type="button"
                    className={`files-chip${
                      normalizeFillDirInput(fillDir) ===
                      normalizeFillDirInput(browsePath)
                        ? " on"
                        : ""
                    }`}
                    disabled={!snOk}
                    title={browsePath}
                    onClick={() => setFillDir(normalizeFillDirInput(browsePath))}
                  >
                    当前目录
                  </button>
                ) : null}
              </div>
            </label>
            <label className="files-fill-label">
              填充比例
              <div className="files-fill-pct-row">
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={fillPct}
                  disabled={!snOk}
                  onChange={(e) => setFillPct(Number(e.target.value))}
                />
                <input
                  className="field files-fill-pct-input"
                  type="number"
                  min={1}
                  max={100}
                  value={fillPct}
                  disabled={!snOk}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setFillPct(Math.max(1, Math.min(100, Math.round(n))));
                  }}
                />
                <span>%</span>
              </div>
            </label>
            <div className="files-fill-summary">
              <span>
                写入{" "}
                <strong title={fillPreview?.path || fillDir}>
                  {fillPreview?.fill_dir || normalizeFillDirInput(fillDir)}
                </strong>
              </span>
              <span className="files-fill-summary-sep" aria-hidden>
                ·
              </span>
              <span>
                剩余{" "}
                <strong>
                  {fillPreviewBusy ? "…" : fillPreview?.avail_label || "—"}
                </strong>
              </span>
              <span className="files-fill-summary-sep" aria-hidden>
                →
              </span>
              <span>
                写入约{" "}
                <strong className="accent">
                  {fillPreviewBusy ? "…" : fillPreview?.target_label || "—"}
                </strong>
              </span>
            </div>
            {!fillPreviewBusy && fillPreview && !fillPreview.ok ? (
              <p className="files-fill-hint">{fillPreview.message}</p>
            ) : null}
          </div>
        )}
      </Modal>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={previewData ? `${previewData.name} (${formatSize(previewData.size)})` : "文件预览"}
        footer={
          previewData?.kind === "text" ? (
            <>
              <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
              <Button
                variant="primary"
                disabled={previewSaving || previewData.truncated}
                title={
                  previewData.truncated
                    ? "文件超过 512KB 预览上限，为防止截断已禁用直接保存"
                    : "保存修改并写回设备"
                }
                onClick={() => void saveFilePreview()}
              >
                {previewSaving ? "保存中…" : "保存回写设备"}
              </Button>
            </>
          ) : (
            <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
          )
        }
      >
        {previewBusy ? (
          <div className="files-empty">正在读取设备文件…</div>
        ) : previewData?.kind === "image" && previewData.base64 ? (
          <div className="files-preview-img-wrap">
            <img
              className="files-preview-img"
              src={`data:${previewData.mime || "image/png"};base64,${previewData.base64}`}
              alt={previewData.name}
            />
          </div>
        ) : previewData?.kind === "text" ? (
          <div className="files-preview-text-wrap">
            {previewData.truncated ? (
              <p className="files-fill-hint">
                文件较大，仅展示前 512 KB 内容（只读，防止截断回写）。
              </p>
            ) : null}
            <textarea
              className="field mono files-preview-editor"
              value={previewDraft}
              readOnly={previewData.truncated}
              onChange={(e) => setPreviewDraft(e.target.value)}
              rows={18}
              spellCheck={false}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
