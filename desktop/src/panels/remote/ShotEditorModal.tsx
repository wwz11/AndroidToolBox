import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Modal from "../../components/Modal";
import { Button } from "../../ui";
import { type Shot } from "./remoteHelpers";

export type EditorTool =
  | "crop"
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "mosaic"
  | "text";

type Point = { x: number; y: number };

type RectBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type Annotation =
  | {
      kind: "rect";
      color: string;
      size: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: "ellipse";
      color: string;
      size: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: "arrow";
      color: string;
      size: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      kind: "pen";
      color: string;
      size: number;
      points: Point[];
    }
  | {
      kind: "mosaic";
      size: number;
      points: Point[];
    }
  | {
      kind: "text";
      color: string;
      size: number;
      x: number;
      y: number;
      text: string;
    };

type HistoryStep = {
  baseDataUrl: string;
  width: number;
  height: number;
  annotations: Annotation[];
};

type CropDragMode =
  | "create"
  | "move"
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

const COLORS = [
  { value: "#ef4444", label: "红色" },
  { value: "#f97316", label: "橙色" },
  { value: "#eab308", label: "黄色" },
  { value: "#22c55e", label: "绿色" },
  { value: "#3b82f6", label: "蓝色" },
  { value: "#a855f7", label: "紫色" },
  { value: "#ffffff", label: "白色" },
  { value: "#111827", label: "黑色" },
];

const SIZES: Array<{ key: "sm" | "md" | "lg"; label: string; width: number }> = [
  { key: "sm", label: "细", width: 3 },
  { key: "md", label: "中", width: 5 },
  { key: "lg", label: "粗", width: 8 },
];

const TOOLS: Array<{
  key: EditorTool;
  label: string;
  icon: string;
  hint: string;
}> = [
  { key: "rect", label: "矩形", icon: "▭", hint: "拖拽绘制矩形框标注" },
  { key: "ellipse", label: "椭圆", icon: "◯", hint: "拖拽绘制椭圆/圆框标注" },
  { key: "arrow", label: "箭头", icon: "↗", hint: "拖拽绘制指示箭头" },
  { key: "pen", label: "画笔", icon: "✎", hint: "自由涂鸦画笔" },
  { key: "text", label: "文字", icon: "T", hint: "点击画面输入文字标注" },
  { key: "mosaic", label: "马赛克", icon: "▒", hint: "涂抹遮挡敏感信息" },
  { key: "crop", label: "裁剪", icon: "Crop", hint: "框选区域裁剪画面（Enter 确认裁剪）" },
];

function normalizeRect(x1: number, y1: number, x2: number, y2: number): RectBox {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return { x, y, w, h };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  lineWidth: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;

  const angle = Math.atan2(dy, dx);
  const headLen = Math.max(lineWidth * 3.8, 14);
  const headAngle = Math.PI / 6.2;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const shaftEndX = x2 - Math.cos(angle) * (headLen * 0.65);
  const shaftEndY = y2 - Math.sin(angle) * (headLen * 0.65);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - headAngle),
    y2 - headLen * Math.sin(angle - headAngle),
  );
  ctx.lineTo(
    x2 - headLen * 0.72 * Math.cos(angle),
    y2 - headLen * 0.72 * Math.sin(angle),
  );
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + headAngle),
    y2 - headLen * Math.sin(angle + headAngle),
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function renderAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  scaleFactor: number,
  mosaicPatternCanvas: HTMLCanvasElement | null,
) {
  const lw = Math.max(2, ann.size * scaleFactor);
  ctx.save();
  if (ann.kind === "rect") {
    const r = normalizeRect(ann.x1, ann.y1, ann.x2, ann.y2);
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = lw;
    ctx.lineJoin = "round";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else if (ann.kind === "ellipse") {
    const r = normalizeRect(ann.x1, ann.y1, ann.x2, ann.y2);
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.ellipse(
      r.x + r.w / 2,
      r.y + r.h / 2,
      Math.max(1, r.w / 2),
      Math.max(1, r.h / 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (ann.kind === "arrow") {
    drawArrow(ctx, ann.x1, ann.y1, ann.x2, ann.y2, ann.color, lw);
  } else if (ann.kind === "pen") {
    if (ann.points.length > 0) {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x, ann.points[0].y);
      for (let i = 1; i < ann.points.length; i++) {
        ctx.lineTo(ann.points[i].x, ann.points[i].y);
      }
      if (ann.points.length === 1) {
        ctx.lineTo(ann.points[0].x + 0.5, ann.points[0].y + 0.5);
      }
      ctx.stroke();
    }
  } else if (ann.kind === "mosaic") {
    if (ann.points.length > 0 && mosaicPatternCanvas) {
      const pat = ctx.createPattern(mosaicPatternCanvas, "no-repeat");
      if (pat) {
        ctx.strokeStyle = pat;
        ctx.lineWidth = Math.max(14, ann.size * 4.5 * scaleFactor);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(ann.points[0].x, ann.points[0].y);
        for (let i = 1; i < ann.points.length; i++) {
          ctx.lineTo(ann.points[i].x, ann.points[i].y);
        }
        if (ann.points.length === 1) {
          ctx.lineTo(ann.points[0].x + 0.5, ann.points[0].y + 0.5);
        }
        ctx.stroke();
      }
    }
  } else if (ann.kind === "text") {
    const fontSize = Math.round(Math.max(16, (ann.size * 4 + 8) * scaleFactor));
    ctx.font = `700 ${fontSize}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const lines = ann.text.split(/\r?\n/);
    const lineHeight = Math.round(fontSize * 1.25);
    const haloColor =
      ann.color.toLowerCase() === "#111827" ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.72)";
    ctx.strokeStyle = haloColor;
    ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.16));
    ctx.fillStyle = ann.color;
    for (let i = 0; i < lines.length; i++) {
      const ly = ann.y + i * lineHeight;
      ctx.strokeText(lines[i], ann.x, ly);
      ctx.fillText(lines[i], ann.x, ly);
    }
  }
  ctx.restore();
}

function buildMosaicCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const blockSize = Math.max(10, Math.round(Math.max(w, h) / 75));
  const sw = Math.max(1, Math.ceil(w / blockSize));
  const sh = Math.max(1, Math.ceil(h / blockSize));

  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext("2d");
  if (sctx) {
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(img, 0, 0, sw, sh);
  }

  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
  }
  return c;
}

type Props = {
  open: boolean;
  shot: Shot | null;
  onClose: () => void;
  /** 完成并复制：将编辑后的 Shot 回传父组件更新预览并写入系统剪贴板 */
  onCopyEdited: (edited: Shot) => Promise<void> | void;
  /** 保存文件：将编辑后的 Shot 回传父组件并触发下载保存 */
  onSaveEdited: (edited: Shot) => void;
  /** 仅应用修改到预览图 */
  onApplyEdited: (edited: Shot) => void;
};

export default function ShotEditorModal({
  open,
  shot,
  onClose,
  onCopyEdited,
  onSaveEdited,
  onApplyEdited,
}: Props) {
  const [tool, setTool] = useState<EditorTool>("rect");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [sizeKey, setSizeKey] = useState<"sm" | "md" | "lg">("md");
  const [history, setHistory] = useState<HistoryStep[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(0);
  const [draftAnn, setDraftAnn] = useState<Annotation | null>(null);
  const [cropRect, setCropRect] = useState<RectBox | null>(null);
  const [textDraft, setTextDraft] = useState<{
    x: number;
    y: number;
    value: string;
  } | null>(null);
  const [copying, setCopying] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const mosaicCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);

  const dragRef = useRef<{
    active: boolean;
    startPt: Point;
    cropMode?: CropDragMode;
    initialCrop?: RectBox;
  }>({
    active: false,
    startPt: { x: 0, y: 0 },
  });

  const currentStep = history[historyIdx] || null;
  const strokeWidth = useMemo(
    () => SIZES.find((s) => s.key === sizeKey)?.width ?? 5,
    [sizeKey],
  );

  const scaleFactor = useMemo(() => {
    if (!currentStep) return 1;
    return Math.max(0.75, Math.max(currentStep.width, currentStep.height) / 1280);
  }, [currentStep]);

  // 初始化截图加载
  useEffect(() => {
    if (!open || !shot) return;
    const dataUrl = `data:${shot.mime};base64,${shot.b64}`;
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || shot.width || 1280;
      const h = img.naturalHeight || shot.height || 720;
      baseImgRef.current = img;
      mosaicCanvasRef.current = buildMosaicCanvas(img, w, h);
      setHistory([
        {
          baseDataUrl: dataUrl,
          width: w,
          height: h,
          annotations: [],
        },
      ]);
      setHistoryIdx(0);
      setDraftAnn(null);
      setCropRect(null);
      setTextDraft(null);
    };
    img.src = dataUrl;
  }, [open, shot]);

  // 当历史步骤中的 baseDataUrl 改变（例如裁剪或撤销裁剪）时，重新加载底图与马赛克纹理
  useEffect(() => {
    if (!open || !currentStep) return;
    if (baseImgRef.current && baseImgRef.current.src === currentStep.baseDataUrl) {
      redrawCanvas();
      return;
    }
    const img = new Image();
    img.onload = () => {
      baseImgRef.current = img;
      mosaicCanvasRef.current = buildMosaicCanvas(
        img,
        currentStep.width,
        currentStep.height,
      );
      redrawCanvas();
    };
    img.src = currentStep.baseDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStep?.baseDataUrl, currentStep?.width, currentStep?.height]);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = baseImgRef.current;
    if (!canvas || !img || !currentStep) return;

    if (canvas.width !== currentStep.width || canvas.height !== currentStep.height) {
      canvas.width = currentStep.width;
      canvas.height = currentStep.height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    for (const ann of currentStep.annotations) {
      renderAnnotation(ctx, ann, scaleFactor, mosaicCanvasRef.current);
    }
    if (draftAnn) {
      renderAnnotation(ctx, draftAnn, scaleFactor, mosaicCanvasRef.current);
    }

    // 绘制裁剪遮罩与控制柄
    if (tool === "crop" && cropRect && (cropRect.w > 2 || cropRect.h > 2)) {
      const { x, y, w, h } = cropRect;
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.56)";
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(x, y, w, h);
      ctx.fill("evenodd");

      // 裁剪框边线与九宫格辅助线
      const borderW = Math.max(2, 2 * scaleFactor);
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = borderW;
      ctx.strokeRect(x, y, w, h);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.38)";
      ctx.lineWidth = Math.max(1, scaleFactor);
      ctx.beginPath();
      ctx.moveTo(x + w / 3, y);
      ctx.lineTo(x + w / 3, y + h);
      ctx.moveTo(x + (w * 2) / 3, y);
      ctx.lineTo(x + (w * 2) / 3, y + h);
      ctx.moveTo(x, y + h / 3);
      ctx.lineTo(x + w, y + h / 3);
      ctx.moveTo(x, y + (h * 2) / 3);
      ctx.lineTo(x + w, y + (h * 2) / 3);
      ctx.stroke();

      // 8 个控制点
      const hs = Math.max(8, Math.round(9 * scaleFactor));
      const handles: Array<[number, number]> = [
        [x, y],
        [x + w / 2, y],
        [x + w, y],
        [x + w, y + h / 2],
        [x + w, y + h],
        [x + w / 2, y + h],
        [x, y + h],
        [x, y + h / 2],
      ];
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = Math.max(1.5, 1.5 * scaleFactor);
      for (const [hx, hy] of handles) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }

      // 尺寸角标
      const label = `${Math.round(w)} × ${Math.round(h)}`;
      const fontSize = Math.max(13, Math.round(13 * scaleFactor));
      ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
      const tw = ctx.measureText(label).width;
      const padX = Math.round(7 * scaleFactor);
      const padY = Math.round(4 * scaleFactor);
      const boxH = fontSize + padY * 2;
      const boxW = tw + padX * 2;
      const bx = clamp(x, 4, Math.max(4, canvas.width - boxW - 4));
      const by = y > boxH + 8 ? y - boxH - 6 : y + 6;
      ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "top";
      ctx.fillText(label, bx + padX, by + padY);
      ctx.restore();
    }
  }, [currentStep, draftAnn, scaleFactor, tool, cropRect]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  function pushAnnotation(ann: Annotation) {
    if (!currentStep) return;
    const nextStep: HistoryStep = {
      ...currentStep,
      annotations: [...currentStep.annotations, ann],
    };
    setHistory((prev) => [...prev.slice(0, historyIdx + 1), nextStep]);
    setHistoryIdx((idx) => idx + 1);
  }

  function commitTextDraft() {
    if (!textDraft) return;
    const trimmed = textDraft.value.trim();
    const { x, y } = textDraft;
    setTextDraft(null);
    if (!trimmed) return;
    pushAnnotation({
      kind: "text",
      color,
      size: strokeWidth,
      x,
      y,
      text: trimmed,
    });
  }

  function getCanvasPoint(e: ReactMouseEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: clamp((e.clientX - rect.left) * scaleX, 0, canvas.width),
      y: clamp((e.clientY - rect.top) * scaleY, 0, canvas.height),
    };
  }

  function hitCropHandle(pt: Point, r: RectBox): CropDragMode {
    const tol = Math.max(14, 16 * scaleFactor);
    const handles: Array<{ mode: CropDragMode; x: number; y: number }> = [
      { mode: "nw", x: r.x, y: r.y },
      { mode: "n", x: r.x + r.w / 2, y: r.y },
      { mode: "ne", x: r.x + r.w, y: r.y },
      { mode: "e", x: r.x + r.w, y: r.y + r.h / 2 },
      { mode: "se", x: r.x + r.w, y: r.y + r.h },
      { mode: "s", x: r.x + r.w / 2, y: r.y + r.h },
      { mode: "sw", x: r.x, y: r.y + r.h },
      { mode: "w", x: r.x, y: r.y + r.h / 2 },
    ];
    for (const h of handles) {
      if (Math.abs(pt.x - h.x) <= tol && Math.abs(pt.y - h.y) <= tol) {
        return h.mode;
      }
    }
    if (
      pt.x >= r.x &&
      pt.x <= r.x + r.w &&
      pt.y >= r.y &&
      pt.y <= r.y + r.h
    ) {
      return "move";
    }
    return "create";
  }

  function onCanvasMouseDown(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || !currentStep) return;
    const pt = getCanvasPoint(e);

    if (textDraft) {
      commitTextDraft();
      return;
    }

    if (tool === "text") {
      setTextDraft({ x: pt.x, y: pt.y, value: "" });
      window.setTimeout(() => textInputRef.current?.focus(), 20);
      return;
    }

    if (tool === "crop") {
      const mode = cropRect && cropRect.w > 8 && cropRect.h > 8
        ? hitCropHandle(pt, cropRect)
        : "create";
      dragRef.current = {
        active: true,
        startPt: pt,
        cropMode: mode,
        initialCrop: cropRect ? { ...cropRect } : undefined,
      };
      if (mode === "create") {
        setCropRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
      }
      return;
    }

    dragRef.current = { active: true, startPt: pt };
    if (tool === "rect" || tool === "ellipse" || tool === "arrow") {
      setDraftAnn({
        kind: tool,
        color,
        size: strokeWidth,
        x1: pt.x,
        y1: pt.y,
        x2: pt.x,
        y2: pt.y,
      });
    } else if (tool === "pen") {
      setDraftAnn({
        kind: "pen",
        color,
        size: strokeWidth,
        points: [pt],
      });
    } else if (tool === "mosaic") {
      setDraftAnn({
        kind: "mosaic",
        size: strokeWidth,
        points: [pt],
      });
    }
  }

  function onCanvasMouseMove(e: ReactMouseEvent<HTMLCanvasElement>) {
    if (!dragRef.current.active || !currentStep) return;
    const pt = getCanvasPoint(e);
    const { startPt, cropMode, initialCrop } = dragRef.current;

    if (tool === "crop") {
      const maxW = currentStep.width;
      const maxH = currentStep.height;
      if (!cropMode || cropMode === "create" || !initialCrop) {
        setCropRect(normalizeRect(startPt.x, startPt.y, pt.x, pt.y));
        return;
      }
      if (cropMode === "move") {
        const dx = pt.x - startPt.x;
        const dy = pt.y - startPt.y;
        const nx = clamp(initialCrop.x + dx, 0, Math.max(0, maxW - initialCrop.w));
        const ny = clamp(initialCrop.y + dy, 0, Math.max(0, maxH - initialCrop.h));
        setCropRect({ x: nx, y: ny, w: initialCrop.w, h: initialCrop.h });
        return;
      }
      let x1 = initialCrop.x;
      let y1 = initialCrop.y;
      let x2 = initialCrop.x + initialCrop.w;
      let y2 = initialCrop.y + initialCrop.h;
      if (cropMode.includes("w")) x1 = pt.x;
      if (cropMode.includes("e")) x2 = pt.x;
      if (cropMode.includes("n")) y1 = pt.y;
      if (cropMode.includes("s")) y2 = pt.y;
      setCropRect(normalizeRect(x1, y1, x2, y2));
      return;
    }

    if (!draftAnn) return;
    if (
      draftAnn.kind === "rect" ||
      draftAnn.kind === "ellipse" ||
      draftAnn.kind === "arrow"
    ) {
      setDraftAnn({ ...draftAnn, x2: pt.x, y2: pt.y });
    } else if (draftAnn.kind === "pen" || draftAnn.kind === "mosaic") {
      setDraftAnn({
        ...draftAnn,
        points: [...draftAnn.points, pt],
      });
    }
  }

  function onCanvasMouseUp() {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;

    if (tool === "crop") {
      if (cropRect && (cropRect.w < 12 || cropRect.h < 12)) {
        setCropRect(null);
      }
      return;
    }

    if (draftAnn) {
      const ann = draftAnn;
      setDraftAnn(null);
      if (
        ann.kind === "rect" ||
        ann.kind === "ellipse" ||
        ann.kind === "arrow"
      ) {
        if (Math.hypot(ann.x2 - ann.x1, ann.y2 - ann.y1) < 4) return;
      }
      pushAnnotation(ann);
    }
  }

  /** 将当前画布（若存在有效裁剪框则裁剪对应区域）烘焙为脱机 Canvas */
  const renderMergedCanvas = useCallback(
    (applyPendingCrop: boolean): HTMLCanvasElement | null => {
      const img = baseImgRef.current;
      if (!img || !currentStep) return null;

      const full = document.createElement("canvas");
      full.width = currentStep.width;
      full.height = currentStep.height;
      const fctx = full.getContext("2d");
      if (!fctx) return null;

      fctx.drawImage(img, 0, 0, full.width, full.height);
      for (const ann of currentStep.annotations) {
        renderAnnotation(fctx, ann, scaleFactor, mosaicCanvasRef.current);
      }

      if (
        applyPendingCrop &&
        cropRect &&
        cropRect.w >= 12 &&
        cropRect.h >= 12
      ) {
        const sx = clamp(Math.round(cropRect.x), 0, full.width - 1);
        const sy = clamp(Math.round(cropRect.y), 0, full.height - 1);
        const sw = clamp(Math.round(cropRect.w), 1, full.width - sx);
        const sh = clamp(Math.round(cropRect.h), 1, full.height - sy);
        const cropped = document.createElement("canvas");
        cropped.width = sw;
        cropped.height = sh;
        const cctx = cropped.getContext("2d");
        if (!cctx) return full;
        cctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
        return cropped;
      }

      return full;
    },
    [currentStep, scaleFactor, cropRect],
  );

  const confirmCrop = useCallback(() => {
    if (!cropRect || cropRect.w < 12 || cropRect.h < 12 || !currentStep) return;
    const cropped = renderMergedCanvas(true);
    if (!cropped) return;
    const newUrl = cropped.toDataURL("image/png");
    const nextStep: HistoryStep = {
      baseDataUrl: newUrl,
      width: cropped.width,
      height: cropped.height,
      annotations: [],
    };
    setHistory((prev) => [...prev.slice(0, historyIdx + 1), nextStep]);
    setHistoryIdx((idx) => idx + 1);
    setCropRect(null);
  }, [cropRect, currentStep, renderMergedCanvas, historyIdx]);

  const canUndo = historyIdx > 0 || (currentStep?.annotations.length ?? 0) > 0;
  const canRedo = historyIdx < history.length - 1;
  const hasEdits = historyIdx > 0 || Boolean(cropRect);

  const handleUndo = useCallback(() => {
    if (textDraft) {
      setTextDraft(null);
      return;
    }
    if (cropRect) {
      setCropRect(null);
      return;
    }
    if (historyIdx > 0) {
      setHistoryIdx((i) => i - 1);
    }
  }, [textDraft, cropRect, historyIdx]);

  const handleRedo = useCallback(() => {
    if (historyIdx < history.length - 1) {
      setHistoryIdx((i) => i + 1);
    }
  }, [historyIdx, history.length]);

  const handleReset = useCallback(() => {
    setCropRect(null);
    setTextDraft(null);
    setDraftAnn(null);
    if (history.length > 0) {
      setHistory([history[0]]);
      setHistoryIdx(0);
    }
  }, [history]);

  const exportShot = useCallback((): Shot | null => {
    if (textDraft && textDraft.value.trim()) {
      commitTextDraft();
    }
    const merged = renderMergedCanvas(true);
    if (!merged) return null;
    const dataUrl = merged.toDataURL("image/png");
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return {
      mime: m[1],
      b64: m[2],
      width: merged.width,
      height: merged.height,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderMergedCanvas, textDraft]);

  const handleCopyAndClose = useCallback(async () => {
    if (copying) return;
    const edited = exportShot();
    if (!edited) return;
    setCopying(true);
    try {
      await onCopyEdited(edited);
      onClose();
    } finally {
      setCopying(false);
    }
  }, [copying, exportShot, onCopyEdited, onClose]);

  const handleSave = useCallback(() => {
    const edited = exportShot();
    if (!edited) return;
    onSaveEdited(edited);
  }, [exportShot, onSaveEdited]);

  const handleApplyOnly = useCallback(() => {
    const edited = exportShot();
    if (!edited) return;
    onApplyEdited(edited);
    onClose();
  }, [exportShot, onApplyEdited, onClose]);

  // 快捷键支持：Ctrl+Z 撤销、Ctrl+Y 重做、Ctrl+C 复制、Enter 确认裁剪
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (textDraft) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopyAndClose();
      } else if (e.key === "Enter" && tool === "crop" && cropRect) {
        e.preventDefault();
        confirmCrop();
      } else if (e.key === "Escape" && cropRect) {
        e.preventDefault();
        e.stopPropagation();
        setCropRect(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    open,
    textDraft,
    tool,
    cropRect,
    handleUndo,
    handleRedo,
    handleCopyAndClose,
    confirmCrop,
  ]);

  // 计算文字输入框在画布容器上的百分比位置
  const textOverlayStyle = useMemo(() => {
    if (!textDraft || !currentStep) return undefined;
    const leftPct = (textDraft.x / Math.max(1, currentStep.width)) * 100;
    const topPct = (textDraft.y / Math.max(1, currentStep.height)) * 100;
    return {
      left: `${ clamp(leftPct, 1, 92) }%`,
      top: `${ clamp(topPct, 1, 90) }%`,
      color,
    };
  }, [textDraft, currentStep, color]);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (textDraft) {
          setTextDraft(null);
          return;
        }
        onClose();
      }}
      size="lg"
      className="shot-editor-modal"
      dismissOnBackdrop={false}
      title={
        <div className="shot-editor-title">
          <strong>截图编辑</strong>
          {currentStep ? (
            <span className="shot-editor-dim">
              {currentStep.width} × {currentStep.height} px
            </span>
          ) : null}
        </div>
      }
      footer={
        <div className="shot-editor-foot">
          <span className="shot-editor-foot-hint">
            {tool === "crop"
              ? cropRect
                ? `已框选 ${Math.round(cropRect.w)}×${Math.round(cropRect.h)} · 按 Enter 或点「确认裁剪」生效，也可直接点「完成并复制」`
                : "在画面上拖拽框选要保留的区域"
              : "拖拽画面进行标注 · Ctrl+Z 撤销 · Ctrl+C 直接复制"}
          </span>
          <div className="shot-editor-foot-actions">
            <Button onClick={onClose}>取消</Button>
            <Button onClick={handleSave} title="保存编辑后的图片到本地">
              保存图片
            </Button>
            {hasEdits ? (
              <Button onClick={handleApplyOnly} title="仅将编辑结果更新到预览区">
                完成编辑
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={copying}
              onClick={() => void handleCopyAndClose()}
              title="将编辑后的图片复制到系统剪贴板并关闭（快捷键 Ctrl+C）"
            >
              {copying ? "复制中…" : "完成并复制"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="shot-editor-toolbar">
        <div className="shot-editor-tools" role="toolbar" aria-label="标注与裁剪工具">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`shot-tool-btn${tool === t.key ? " active" : ""}`}
              title={t.hint}
              onClick={() => {
                if (textDraft) commitTextDraft();
                if (t.key !== "crop") setCropRect(null);
                setTool(t.key);
              }}
            >
              <span className="shot-tool-icon" aria-hidden>
                {t.key === "crop" ? "◩" : t.icon}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {tool === "crop" && cropRect && cropRect.w >= 12 && cropRect.h >= 12 ? (
          <div className="shot-editor-crop-actions">
            <Button size="sm" variant="primary" onClick={confirmCrop}>
              确认裁剪
            </Button>
            <Button size="sm" onClick={() => setCropRect(null)}>
              重选
            </Button>
          </div>
        ) : null}

        {tool !== "crop" ? (
          <div className="shot-editor-styles">
            <div className="shot-size-group" role="group" aria-label="粗细">
              {SIZES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`shot-size-btn${sizeKey === s.key ? " active" : ""}`}
                  title={`线条/字号：${s.label}`}
                  onClick={() => setSizeKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {tool !== "mosaic" ? (
              <div className="shot-color-group" role="group" aria-label="颜色">
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`shot-color-swatch${color === c.value ? " active" : ""}`}
                    style={{ backgroundColor: c.value }}
                    title={c.label}
                    aria-label={c.label}
                    onClick={() => setColor(c.value)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="shot-editor-history">
          <Button
            size="sm"
            disabled={!canUndo && !cropRect}
            title="撤销上一步 (Ctrl+Z)"
            onClick={handleUndo}
          >
            撤销
          </Button>
          <Button
            size="sm"
            disabled={!canRedo}
            title="重做 (Ctrl+Y)"
            onClick={handleRedo}
          >
            重做
          </Button>
          <Button
            size="sm"
            disabled={!hasEdits}
            title="还原为初始截图"
            onClick={handleReset}
          >
            还原
          </Button>
        </div>
      </div>

      <div className="shot-editor-stage">
        <div className="shot-editor-canvas-wrap">
          <canvas
            ref={canvasRef}
            className={`shot-editor-canvas tool-${tool}`}
            onMouseDown={onCanvasMouseDown}
            onMouseMove={onCanvasMouseMove}
            onMouseUp={onCanvasMouseUp}
            onMouseLeave={onCanvasMouseUp}
          />
          {textDraft ? (
            <textarea
              ref={textInputRef}
              className="shot-editor-text-input"
              style={textOverlayStyle}
              value={textDraft.value}
              placeholder="输入标注文字，Enter 确认…"
              rows={2}
              onChange={(e) =>
                setTextDraft((prev) =>
                  prev ? { ...prev, value: e.target.value } : null,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitTextDraft();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setTextDraft(null);
                }
              }}
              onBlur={() => commitTextDraft()}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
