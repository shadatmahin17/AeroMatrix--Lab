import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Download, RotateCcw } from "lucide-react";
import type { Coord2D } from "../types/airfoil.ts";
import { BZ } from "../lib/lbm/bezierShape.js";
import { downloadText } from "../lib/files.js";

const W = 340;
const H = 164;
const DPR = 2;
const SC = 280;
const X0 = 30;
const Y0 = 80;

const toPx = (x: number, y: number): [number, number] => [X0 + x * SC, Y0 - y * SC];
const toW = (px: number, py: number): [number, number] => [(px - X0) / SC, (Y0 - py) / SC];
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

interface BezierShape {
  camber: Coord2D[];
  thick: Coord2D[];
}

interface HandlePoint {
  kind: "c" | "t";
  i: number;
  side?: number;
  x: number;
  y: number;
}

const cloneShape = (s: BezierShape): BezierShape => ({
  camber: s.camber.map((p) => p.slice()),
  thick: s.thick.map((p) => p.slice()),
});

interface ShapeEditor2DProps {
  sourceCoords: Coord2D[];
  foilName: string;
  onCoordsChange: (coords: Coord2D[]) => void;
  onResetSource: () => void;
  onSendTo3D?: () => void;
}

export default function ShapeEditor2D({
  sourceCoords,
  foilName,
  onCoordsChange,
  onResetSource,
  onSendTo3D,
}: ShapeEditor2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fittedRef = useRef<BezierShape | null>(null);
  const shapeRef = useRef<BezierShape | null>(null);
  const dragRef = useRef<HandlePoint | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [fitErr, setFitErr] = useState(0);
  const [edited, setEdited] = useState(false);
  const [metrics, setMetrics] = useState({ camber: 0, camberX: 0.4, thick: 0.12, thickX: 0.3 });

  function getHandles(shape: BezierShape): HandlePoint[] {
    const out: HandlePoint[] = [];
    shape.camber.forEach((p, i) => {
      if (i === 1 || i === 2) out.push({ kind: "c", i, x: p[0], y: p[1] });
    });
    shape.thick.forEach((p, i) => {
      if (i < 1 || i > 3) return;
      const yc = BZ.yAt(shape.camber, Math.max(p[0], 1e-6));
      out.push({ kind: "t", i, side: 1, x: p[0], y: yc + p[1] / 2 });
      out.push({ kind: "t", i, side: -1, x: p[0], y: yc - p[1] / 2 });
    });
    return out;
  }

  const draw = () => {
    const cv = canvasRef.current;
    const shape = shapeRef.current;
    if (!cv || !shape) return;
    const cx = cv.getContext("2d");
    if (!cx) return;
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx.fillStyle = "#F7F9FA";
    cx.fillRect(0, 0, W, H);

    cx.strokeStyle = "#D9DEE2";
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(...toPx(0, 0));
    cx.lineTo(...toPx(1, 0));
    cx.stroke();

    cx.fillStyle = "#5C6670";
    cx.font = "9.5px 'JetBrains Mono', ui-monospace, monospace";
    cx.textAlign = "center";
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      cx.fillText(t.toFixed(2), toPx(t, 0)[0], H - 6);
    }

    const pts = BZ.coords(shape, 121);
    cx.beginPath();
    pts.forEach((p, i) => {
      const [a, b] = toPx(p[0], p[1]);
      if (i) cx.lineTo(a, b);
      else cx.moveTo(a, b);
    });
    cx.closePath();
    cx.fillStyle = "rgba(23, 105, 170, 0.12)";
    cx.fill();
    cx.strokeStyle = "#161A1D";
    cx.lineWidth = 1.5;
    cx.stroke();

    cx.setLineDash([4, 3]);
    cx.strokeStyle = "#D97706";
    cx.lineWidth = 1.3;
    cx.beginPath();
    for (let k = 0; k <= 80; k++) {
      const [x, y] = BZ.point(shape.camber, k / 80);
      const [a, b] = toPx(x, y);
      if (k) cx.lineTo(a, b);
      else cx.moveTo(a, b);
    }
    cx.stroke();

    cx.strokeStyle = "rgba(217, 119, 6, 0.35)";
    cx.lineWidth = 1;
    cx.beginPath();
    shape.camber.forEach((p, i) => {
      const [a, b] = toPx(p[0], p[1]);
      if (i) cx.lineTo(a, b);
      else cx.moveTo(a, b);
    });
    cx.stroke();
    cx.setLineDash([]);

    const drag = dragRef.current;
    const handles = getHandles(shape);
    for (const h of handles) {
      const [a, b] = toPx(h.x, h.y);
      if (h.kind === "t") {
        const yc = BZ.yAt(shape.camber, Math.max(h.x, 1e-6));
        cx.strokeStyle = "rgba(23, 105, 170, 0.35)";
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(...toPx(h.x, yc));
        cx.lineTo(a, b);
        cx.stroke();
      }
      const col = h.kind === "c" ? "#D97706" : "#1769AA";
      const active =
        drag && drag.kind === h.kind && drag.i === h.i && (h.kind === "c" || drag.side === h.side);
      cx.beginPath();
      cx.arc(a, b, active ? 6.5 : 5.2, 0, 2 * Math.PI);
      if (h.kind === "t" && (h.side ?? 1) < 0) {
        cx.fillStyle = "#FFFFFF";
        cx.fill();
        cx.strokeStyle = col;
        cx.lineWidth = 1.8;
        cx.stroke();
      } else {
        cx.fillStyle = col;
        cx.fill();
        cx.strokeStyle = "#FFFFFF";
        cx.lineWidth = 1.4;
        cx.stroke();
      }
    }
  };

  useEffect(() => {
    if (!sourceCoords || sourceCoords.length < 3) return;
    const { shape, err } = BZ.fit(sourceCoords);
    fittedRef.current = cloneShape(shape);
    shapeRef.current = cloneShape(shape);
    setFitErr(err);
    setEdited(false);
    setMetrics(BZ.stats(shape));
    draw();
  }, [sourceCoords]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const pushCoords = (immediate: boolean) => {
    clearTimeout(timerRef.current);
    const commit = () => {
      if (!shapeRef.current) return;
      onCoordsChange(BZ.coords(shapeRef.current, 81));
    };
    if (immediate) commit();
    else timerRef.current = setTimeout(commit, 65);
  };

  const pointerPos = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const shape = shapeRef.current;
    const cv = canvasRef.current;
    if (!shape || !cv) return;
    const [px, py] = pointerPos(e);
    let best: HandlePoint | null = null;
    let bd = 16;
    for (const h of getHandles(shape)) {
      const [a, b] = toPx(h.x, h.y);
      const d = Math.hypot(a - px, b - py);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    if (!best) return;
    dragRef.current = best;
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = "grabbing";
    e.preventDefault();
    draw();
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const shape = shapeRef.current;
    const cv = canvasRef.current;
    if (!shape || !cv) return;
    const [px, py] = pointerPos(e);
    const [x, y] = toW(px, py);
    const drag = dragRef.current;
    if (!drag) {
      const near = getHandles(shape).some((h) => {
        const [a, b] = toPx(h.x, h.y);
        return Math.hypot(a - px, b - py) < 16;
      });
      cv.style.cursor = near ? "grab" : "default";
      return;
    }
    if (drag.kind === "c") {
      const P = shape.camber;
      const i = drag.i;
      const xmin = i === 1 ? 0.02 : P[1][0] + 0.05;
      const xmax = i === 1 ? P[2][0] - 0.05 : 0.98;
      P[i][0] = clamp(x, xmin, xmax);
      P[i][1] = clamp(y, -0.15, 0.15);
    } else {
      const T = shape.thick;
      const i = drag.i;
      const side = drag.side ?? 1;
      if (i === 1) {
        T[1][1] = clamp(side * 2 * y, 0.005, 0.3);
      } else {
        const xmin = i === 2 ? 0.02 : T[2][0] + 0.05;
        const xmax = i === 2 ? T[3][0] - 0.05 : 0.98;
        T[i][0] = clamp(x, xmin, xmax);
        const yc = BZ.yAt(shape.camber, T[i][0]);
        T[i][1] = clamp(side * 2 * (y - yc), 0, 0.3);
      }
    }
    setEdited(true);
    setMetrics(BZ.stats(shape));
    draw();
    pushCoords(false);
  };

  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = "default";
    draw();
    pushCoords(true);
  };

  const handleReset = () => {
    if (!fittedRef.current) return;
    shapeRef.current = cloneShape(fittedRef.current);
    setEdited(false);
    clearTimeout(timerRef.current);
    setMetrics(BZ.stats(shapeRef.current));
    draw();
    onResetSource();
  };

  const handleDownload = () => {
    const pts = edited && shapeRef.current ? BZ.coords(shapeRef.current, 81) : sourceCoords;
    const base = (foilName || "airfoil").replace(/\.(dat|txt)$/i, "");
    const title = edited ? `${base} (edited)` : base;
    const text =
      title +
      "\n" +
      pts.map(([x, y]) => `${x.toFixed(6).padStart(10)} ${y.toFixed(6).padStart(10)}`).join("\n") +
      "\n";
    const fname = (title.replace(/[^\w.-]+/g, "_").replace(/_+$/, "") || "airfoil") + ".dat";
    downloadText(fname, text);
  };

  return (
    <div id="shape-editor" className="flex flex-col gap-3">
      <div className="grid grid-cols-3 divide-x divide-[var(--border)] border border-[var(--border)] rounded-lg bg-[var(--bg)] text-center py-2">
        <div className="px-2">
          <div className="text-[10px] font-semibold text-[#5C6670]">Camber</div>
          <div className="text-xs font-bold font-mono tabular-nums text-[#D97706] mt-0.5">
            {(metrics.camber * 100).toFixed(1)}%
          </div>
        </div>
        <div className="px-2">
          <div className="text-[10px] font-semibold text-[#5C6670]">Thickness</div>
          <div className="text-xs font-bold font-mono tabular-nums text-[#1769AA] mt-0.5">
            {(metrics.thick * 100).toFixed(1)}%
          </div>
        </div>
        <div className="px-2">
          <div className="text-[10px] font-semibold text-[#5C6670]">Fit Error</div>
          <div className="text-xs font-bold font-mono tabular-nums text-[#161A1D] mt-0.5">
            ±{(fitErr * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={W * DPR}
        height={H * DPR}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="w-full h-auto block rounded-lg border border-[var(--border)] bg-[#F7F9FA]"
        style={{ aspectRatio: `${W} / ${H}`, touchAction: "none" }}
      />

      <p className="text-[11.5px] text-[#5C6670] leading-snug">
        Drag amber camber handles or blue thickness handles to reshape the foil inside the live tunnel.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleReset} disabled={!edited}>
          <RotateCcw size={13} aria-hidden="true" />
          <span>Reset Shape</span>
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleDownload}>
          <Download size={13} aria-hidden="true" />
          <span>Save .dat</span>
        </button>
      </div>
      {onSendTo3D && (
        <button type="button" className="btn btn-primary-accent btn-sm w-full" onClick={onSendTo3D}>
          <span>Test Wing in 3D Wind Tunnel</span>
        </button>
      )}
    </div>
  );
}
