import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { Download, FileJson, FileSpreadsheet, Plus, RotateCcw, Trash2, TrendingUp } from "lucide-react";
import { downloadText, stem, toCsv } from "../lib/files.js";
import { downloadSvgAsPng, downloadSvgElement } from "../utils/telemetryExport";
import type { BenchmarkRunDoc, NeutralReferenceData } from "../lib/airfoilRepository.ts";
import type { TelemetrySample } from "../types/airfoil.ts";

const PLOT_FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";
const PLOT_FONT_SANS = "'Quicksand', ui-sans-serif, system-ui, sans-serif";

type ChartMode = "history" | "polar" | "ld";

interface PolarPoint {
  alpha: number;
  cl: number;
  cd: number;
  ld: number;
  sep: number;
  count: number;
}

function buildPolarPoints(samples: TelemetrySample[]): PolarPoint[] {
  const buckets = new Map<
    string,
    { alpha: number; clSum: number; cdSum: number; ldSum: number; ldCount: number; sepSum: number; n: number }
  >();
  for (const s of samples) {
    if (s.cl === null || s.cd === null) continue;
    const key = s.alpha.toFixed(1);
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, {
        alpha: s.alpha,
        clSum: s.cl,
        cdSum: s.cd,
        ldSum: s.ld ?? 0,
        ldCount: s.ld !== null ? 1 : 0,
        sepSum: s.separationPct,
        n: 1,
      });
    } else {
      prev.clSum += s.cl;
      prev.cdSum += s.cd;
      if (s.ld !== null) {
        prev.ldSum += s.ld;
        prev.ldCount += 1;
      }
      prev.sepSum += s.separationPct;
      prev.n += 1;
    }
  }
  return Array.from(buckets.values())
    .map((b) => {
      const cl = b.clSum / b.n;
      const cd = b.cdSum / b.n;
      const ld = b.ldCount > 0 ? b.ldSum / b.ldCount : cd > 0.001 ? cl / cd : 0;
      return {
        alpha: b.alpha,
        cl,
        cd,
        ld,
        sep: Math.round(b.sepSum / b.n),
        count: b.n,
      };
    })
    .sort((a, b) => a.alpha - b.alpha);
}

interface ResultsAnalyticsProps {
  samples: TelemetrySample[];
  airfoilName: string;
  neutralRef?: NeutralReferenceData | null;
  bestBenchmark?: BenchmarkRunDoc | null;
  onRecordSnapshot: () => void;
  onClearSamples: () => void;
}

export default function ResultsAnalytics({
  samples,
  airfoilName,
  neutralRef = null,
  bestBenchmark = null,
  onRecordSnapshot,
  onClearSamples,
}: ResultsAnalyticsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const [chartMode, setChartMode] = useState<ChartMode>("history");
  const [dims, setDims] = useState<{ width: number; height: number }>({ width: 340, height: 212 });
  const [zoomTransform, setZoomTransform] = useState<d3.ZoomTransform>(() => d3.zoomIdentity);
  const [probeReadout, setProbeReadout] = useState<string | null>(null);

  const validSamples = useMemo(
    () => samples.filter((s) => s.cl !== null && s.cd !== null),
    [samples]
  );

  const polarPts = useMemo(
    () => (chartMode === "history" ? [] : buildPolarPoints(validSamples)),
    [chartMode, validSamples]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const w = Math.max(240, Math.floor(el.clientWidth));
      const h = Math.max(196, Math.floor(el.clientHeight) || 212);
      setDims((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    sync();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoomTransform(d3.zoomIdentity);
    if (svgRef.current && zoomBehaviorRef.current) {
      d3.select(svgRef.current).call(zoomBehaviorRef.current.transform, d3.zoomIdentity);
    }
  }, []);

  useEffect(() => {
    setProbeReadout(null);
    handleResetZoom();
  }, [chartMode, handleResetZoom]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const { width, height } = dims;
    svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", width)
      .attr("height", height);

    svg
      .append("rect")
      .attr("class", "export-bg")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", width)
      .attr("height", height)
      .attr("fill", "#FFFFFF");

    const isDualAxis = chartMode !== "ld";
    const margin = {
      top: 24,
      right: isDualAxis ? 42 : 14,
      bottom: 26,
      left: 38,
    };
    const innerW = Math.max(100, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const hasData = chartMode === "history" ? validSamples.length > 0 : polarPts.length > 0;

    if (!hasData) {
      g.append("rect")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", innerW)
        .attr("height", innerH)
        .attr("fill", "none")
        .attr("stroke", "#E5E9EC");

      g.append("text")
        .attr("x", innerW / 2)
        .attr("y", innerH / 2)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .style("font-family", PLOT_FONT_SANS)
        .style("font-size", "12px")
        .attr("fill", "#5C6670")
        .text("Waiting for solver telemetry…");
      return;
    }

    const defs = svg.append("defs");
    const clipId = `telemetry-2d-clip-${chartMode}`;
    defs
      .append("clipPath")
      .attr("id", clipId)
      .append("rect")
      .attr("width", innerW)
      .attr("height", innerH);

    const refPrefix = neutralRef?.label?.startsWith("NeuroFoil") ? "NeuroFoil" : "Ref";

    // Compute domains
    let xDomain: [number, number];
    if (chartMode === "history") {
      const xs = validSamples.map((s) => s.id);
      const xMin = d3.min(xs) ?? 1;
      const xMax = d3.max(xs) ?? 2;
      xDomain = xMin === xMax ? [xMin - 1, xMax + 1] : [xMin, xMax];
    } else {
      const xs = [
        ...polarPts.map((p) => p.alpha),
        ...(neutralRef?.rows?.map((r) => r.alpha) ?? []),
        ...(chartMode === "ld" && bestBenchmark ? [bestBenchmark.alpha] : []),
      ];
      const xMin = d3.min(xs) ?? -5;
      const xMax = d3.max(xs) ?? 15;
      xDomain = xMin === xMax ? [xMin - 2, xMax + 2] : [xMin - 0.5, xMax + 0.5];
    }

    const baseX = d3.scaleLinear().domain(xDomain).range([0, innerW]);
    const x = zoomTransform.rescaleX(baseX);

    let y1Domain: [number, number];
    if (chartMode === "history") {
      const cls = [
        ...validSamples.map((s) => s.cl ?? 0),
        ...(bestBenchmark ? [bestBenchmark.cl] : []),
        0,
      ];
      const yMin = d3.min(cls) ?? 0;
      const yMax = d3.max(cls) ?? 1;
      const pad = Math.max(0.12, (yMax - yMin) * 0.14);
      y1Domain = [yMin - pad * 0.4, yMax + pad];
    } else if (chartMode === "polar") {
      const cls = [
        ...polarPts.map((p) => p.cl),
        ...(neutralRef?.rows?.map((r) => r.cl) ?? []),
        0,
      ];
      const yMin = d3.min(cls) ?? -0.5;
      const yMax = d3.max(cls) ?? 1.5;
      const pad = Math.max(0.15, (yMax - yMin) * 0.12);
      y1Domain = [yMin - pad * 0.5, yMax + pad];
    } else {
      const lds = [
        ...polarPts.map((p) => p.ld),
        ...(neutralRef?.rows?.map((r) => r.ld) ?? []),
        ...(bestBenchmark ? [bestBenchmark.ld] : []),
        0,
      ];
      const yMin = d3.min(lds) ?? 0;
      const yMax = d3.max(lds) ?? 20;
      const pad = Math.max(2, (yMax - yMin) * 0.14);
      y1Domain = [Math.min(0, yMin - pad * 0.3), yMax + pad];
    }

    const y1 = d3.scaleLinear().domain(y1Domain).nice(5).range([innerH, 0]);

    let y2: d3.ScaleLinear<number, number> | null = null;
    if (isDualAxis) {
      const cds =
        chartMode === "history"
          ? validSamples.map((s) => s.cd ?? 0)
          : polarPts.map((p) => p.cd);
      const cdMax = Math.max(0.05, d3.max(cds) ?? 0.1);
      y2 = d3.scaleLinear().domain([0, cdMax * 1.18]).nice(4).range([innerH, 0]);
    }

    // Legend strip in top margin
    const legendItems: Array<{ color: string; label: string; dashed?: boolean }> = [];
    if (chartMode === "history") {
      legendItems.push({ color: "#1769AA", label: "CL" });
      legendItems.push({ color: "#D97706", label: "CD", dashed: true });
      if (bestBenchmark && validSamples.length >= 2) {
        legendItems.push({ color: "#047857", label: "Best CL", dashed: true });
      }
    } else if (chartMode === "polar") {
      legendItems.push({ color: "#1769AA", label: "CL" });
      legendItems.push({ color: "#D97706", label: "CD", dashed: true });
      if (neutralRef?.rows?.length) {
        legendItems.push({ color: "#64748B", label: `${refPrefix} CL`, dashed: true });
      }
    } else {
      legendItems.push({ color: "#047857", label: "L/D" });
      if (neutralRef?.rows?.length) {
        legendItems.push({ color: "#64748B", label: `${refPrefix} L/D`, dashed: true });
      }
      if (bestBenchmark) {
        legendItems.push({ color: "#D97706", label: "Best" });
      }
    }

    let lx = margin.left;
    for (const item of legendItems) {
      const itemG = svg.append("g").attr("transform", `translate(${lx}, 8)`);
      itemG
        .append("line")
        .attr("x1", 0)
        .attr("x2", 12)
        .attr("y1", 5)
        .attr("y2", 5)
        .attr("stroke", item.color)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", item.dashed ? "3 2" : "none");
      itemG
        .append("text")
        .attr("x", 16)
        .attr("y", 8)
        .style("font-family", PLOT_FONT_MONO)
        .style("font-size", "9.5px")
        .style("font-weight", "600")
        .attr("fill", "#161A1D")
        .text(item.label);
      lx += item.label.length * 6.2 + 26;
    }

    // Hairline Gridlines
    g.append("g")
      .call(d3.axisLeft(y1).ticks(5).tickSize(-innerW).tickFormat(() => ""))
      .call((sel) => sel.select(".domain").remove())
      .call((sel) =>
        sel
          .selectAll("line")
          .attr("stroke", "#E5E9EC")
          .attr("stroke-width", 1)
      );

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(-innerH).tickFormat(() => ""))
      .call((sel) => sel.select(".domain").remove())
      .call((sel) =>
        sel
          .selectAll("line")
          .attr("stroke", "#E5E9EC")
          .attr("stroke-width", 1)
      );

    // Zero lines
    if (y1.domain()[0] <= 0 && y1.domain()[1] >= 0) {
      g.append("line")
        .attr("x1", 0)
        .attr("x2", innerW)
        .attr("y1", y1(0))
        .attr("y2", y1(0))
        .attr("stroke", "#CBD5E1")
        .attr("stroke-width", 1);
    }
    if (chartMode !== "history" && x.domain()[0] <= 0 && x.domain()[1] >= 0) {
      g.append("line")
        .attr("x1", x(0))
        .attr("x2", x(0))
        .attr("y1", 0)
        .attr("y2", innerH)
        .attr("stroke", "#CBD5E1")
        .attr("stroke-width", 1);
    }

    // Plot Box Frame
    g.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", innerW)
      .attr("height", innerH)
      .attr("fill", "none")
      .attr("stroke", "#D9DEE2");

    const plotArea = g.append("g").attr("clip-path", `url(#${clipId})`);
    const diamondGen = d3.symbol().type(d3.symbolDiamond).size(24);
    const starGen = d3.symbol().type(d3.symbolStar).size(72);

    if (chartMode === "history") {
      const zeroY = Math.min(innerH, Math.max(0, y1(0)));
      const clArea = d3
        .area<TelemetrySample>()
        .x((d) => x(d.id))
        .y0(zeroY)
        .y1((d) => y1(d.cl ?? 0));

      plotArea
        .append("path")
        .datum(validSamples)
        .attr("d", clArea)
        .attr("fill", "rgba(23, 105, 170, 0.08)");

      const clLine = d3
        .line<TelemetrySample>()
        .x((d) => x(d.id))
        .y((d) => y1(d.cl ?? 0));

      plotArea
        .append("path")
        .datum(validSamples)
        .attr("d", clLine)
        .attr("fill", "none")
        .attr("stroke", "#1769AA")
        .attr("stroke-width", 2);

      if (y2) {
        const cdLine = d3
          .line<TelemetrySample>()
          .x((d) => x(d.id))
          .y((d) => y2!(d.cd ?? 0));

        plotArea
          .append("path")
          .datum(validSamples)
          .attr("d", cdLine)
          .attr("fill", "none")
          .attr("stroke", "#D97706")
          .attr("stroke-width", 1.8)
          .attr("stroke-dasharray", "2 3");
      }

      if (validSamples.length <= 24) {
        plotArea
          .selectAll("circle.cl-pt")
          .data(validSamples)
          .join("circle")
          .attr("class", "cl-pt")
          .attr("cx", (d) => x(d.id))
          .attr("cy", (d) => y1(d.cl ?? 0))
          .attr("r", 2.8)
          .attr("fill", "#1769AA");

        if (y2) {
          plotArea
            .selectAll("path.cd-pt")
            .data(validSamples)
            .join("path")
            .attr("class", "cd-pt")
            .attr("d", diamondGen)
            .attr("transform", (d) => `translate(${x(d.id)},${y2!(d.cd ?? 0)})`)
            .attr("fill", "#D97706");
        }
      }

      if (bestBenchmark && validSamples.length >= 2) {
        plotArea
          .append("line")
          .attr("x1", 0)
          .attr("x2", innerW)
          .attr("y1", y1(bestBenchmark.cl))
          .attr("y2", y1(bestBenchmark.cl))
          .attr("stroke", "#047857")
          .attr("stroke-width", 1.4)
          .attr("stroke-dasharray", "6 3 2 3");
      }
    } else if (chartMode === "polar") {
      if (neutralRef?.rows?.length) {
        const refLine = d3
          .line<{ alpha: number; cl: number }>()
          .x((d) => x(d.alpha))
          .y((d) => y1(d.cl))
          .curve(d3.curveMonotoneX);

        plotArea
          .append("path")
          .datum(neutralRef.rows)
          .attr("d", refLine)
          .attr("fill", "none")
          .attr("stroke", "#64748B")
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "2 3");
      }

      const clLine = d3
        .line<PolarPoint>()
        .x((d) => x(d.alpha))
        .y((d) => y1(d.cl))
        .curve(d3.curveMonotoneX);

      plotArea
        .append("path")
        .datum(polarPts)
        .attr("d", clLine)
        .attr("fill", "none")
        .attr("stroke", "#1769AA")
        .attr("stroke-width", 2);

      plotArea
        .selectAll("circle.cl-pt")
        .data(polarPts)
        .join("circle")
        .attr("class", "cl-pt")
        .attr("cx", (d) => x(d.alpha))
        .attr("cy", (d) => y1(d.cl))
        .attr("r", 3.2)
        .attr("fill", "#1769AA")
        .attr("stroke", "#FFFFFF")
        .attr("stroke-width", 1);

      if (y2) {
        const cdLine = d3
          .line<PolarPoint>()
          .x((d) => x(d.alpha))
          .y((d) => y2!(d.cd))
          .curve(d3.curveMonotoneX);

        plotArea
          .append("path")
          .datum(polarPts)
          .attr("d", cdLine)
          .attr("fill", "none")
          .attr("stroke", "#D97706")
          .attr("stroke-width", 1.8)
          .attr("stroke-dasharray", "5 3");

        plotArea
          .selectAll("path.cd-pt")
          .data(polarPts)
          .join("path")
          .attr("class", "cd-pt")
          .attr("d", diamondGen)
          .attr("transform", (d) => `translate(${x(d.alpha)},${y2!(d.cd)})`)
          .attr("fill", "#D97706");
      }
    } else {
      const zeroY = Math.min(innerH, Math.max(0, y1(0)));
      const ldArea = d3
        .area<PolarPoint>()
        .x((d) => x(d.alpha))
        .y0(zeroY)
        .y1((d) => y1(d.ld))
        .curve(d3.curveMonotoneX);

      plotArea
        .append("path")
        .datum(polarPts)
        .attr("d", ldArea)
        .attr("fill", "rgba(4, 120, 87, 0.08)");

      if (neutralRef?.rows?.length) {
        const refLine = d3
          .line<{ alpha: number; ld: number }>()
          .x((d) => x(d.alpha))
          .y((d) => y1(d.ld))
          .curve(d3.curveMonotoneX);

        plotArea
          .append("path")
          .datum(neutralRef.rows)
          .attr("d", refLine)
          .attr("fill", "none")
          .attr("stroke", "#64748B")
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "2 3");
      }

      const ldLine = d3
        .line<PolarPoint>()
        .x((d) => x(d.alpha))
        .y((d) => y1(d.ld))
        .curve(d3.curveMonotoneX);

      plotArea
        .append("path")
        .datum(polarPts)
        .attr("d", ldLine)
        .attr("fill", "none")
        .attr("stroke", "#047857")
        .attr("stroke-width", 2.1);

      plotArea
        .selectAll("circle.ld-pt")
        .data(polarPts)
        .join("circle")
        .attr("class", "ld-pt")
        .attr("cx", (d) => x(d.alpha))
        .attr("cy", (d) => y1(d.ld))
        .attr("r", 3.2)
        .attr("fill", "#047857")
        .attr("stroke", "#FFFFFF")
        .attr("stroke-width", 1);

      if (bestBenchmark) {
        plotArea
          .append("path")
          .attr("d", starGen)
          .attr("transform", `translate(${x(bestBenchmark.alpha)},${y1(bestBenchmark.ld)})`)
          .attr("fill", "#D97706")
          .attr("stroke", "#FFFFFF")
          .attr("stroke-width", 1);
      }
    }

    // Axes
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(5)
          .tickFormat((v) =>
            chartMode === "history" ? `#${Math.round(Number(v))}` : `${Number(v).toFixed(0)}°`
          )
      )
      .call((sel) => sel.select(".domain").attr("stroke", "#D9DEE2"))
      .call((sel) => sel.selectAll("line").attr("stroke", "#D9DEE2"))
      .call((sel) =>
        sel
          .selectAll("text")
          .style("font-family", PLOT_FONT_MONO)
          .style("font-size", "9.5px")
          .attr("fill", "#5C6670")
      );

    g.append("g")
      .call(d3.axisLeft(y1).ticks(5))
      .call((sel) => sel.select(".domain").attr("stroke", "#D9DEE2"))
      .call((sel) => sel.selectAll("line").attr("stroke", "#D9DEE2"))
      .call((sel) =>
        sel
          .selectAll("text")
          .style("font-family", PLOT_FONT_MONO)
          .style("font-size", "9.5px")
          .attr("fill", chartMode === "ld" ? "#047857" : "#1769AA")
      );

    if (y2) {
      g.append("g")
        .attr("transform", `translate(${innerW},0)`)
        .call(d3.axisRight(y2).ticks(4))
        .call((sel) => sel.select(".domain").attr("stroke", "#D9DEE2"))
        .call((sel) => sel.selectAll("line").attr("stroke", "#D9DEE2"))
        .call((sel) =>
          sel
            .selectAll("text")
            .style("font-family", PLOT_FONT_MONO)
            .style("font-size", "9.5px")
            .attr("fill", "#D97706")
        );
    }

    // Crosshair + Bisector Hover Probe
    const focusG = g.append("g").style("display", "none").attr("pointer-events", "none");
    const focusLine = focusG
      .append("line")
      .attr("y1", 0)
      .attr("y2", innerH)
      .attr("stroke", "#161A1D")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "3 2")
      .attr("opacity", 0.45);
    const focusDot1 = focusG
      .append("circle")
      .attr("r", 4.5)
      .attr("fill", chartMode === "ld" ? "#047857" : "#1769AA")
      .attr("stroke", "#FFFFFF")
      .attr("stroke-width", 1.5);
    const focusDot2 = focusG
      .append("circle")
      .attr("r", 4)
      .attr("fill", "#D97706")
      .attr("stroke", "#FFFFFF")
      .attr("stroke-width", 1.5)
      .style("display", isDualAxis ? "inline" : "none");

    const zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 10])
      .translateExtent([
        [0, 0],
        [width, height],
      ])
      .on("zoom", (event) => {
        setZoomTransform(event.transform);
      });

    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", () => {
      handleResetZoom();
    });

    const overlay = g
      .append("rect")
      .attr("width", innerW)
      .attr("height", innerH)
      .attr("fill", "transparent")
      .style("cursor", "crosshair")
      .on("mouseleave", () => {
        focusG.style("display", "none");
        setProbeReadout(null);
      })
      .on("mousemove", (event) => {
        const [mx] = d3.pointer(event, overlay.node()!);
        const xVal = x.invert(mx);

        if (chartMode === "history") {
          const bisect = d3.bisector<TelemetrySample, number>((d) => d.id).center;
          const idx = Math.max(0, Math.min(validSamples.length - 1, bisect(validSamples, xVal)));
          const pt = validSamples[idx];
          if (!pt) return;
          const px = x(pt.id);
          const py1 = y1(pt.cl ?? 0);
          const py2 = y2 ? y2(pt.cd ?? 0) : py1;
          focusG.style("display", null);
          focusLine.attr("x1", px).attr("x2", px);
          focusDot1.attr("cx", px).attr("cy", py1);
          if (isDualAxis) focusDot2.attr("cx", px).attr("cy", py2);
          setProbeReadout(
            `#${pt.id} · α=${pt.alpha.toFixed(1)}° · CL ${(pt.cl ?? 0).toFixed(3)} · CD ${(pt.cd ?? 0).toFixed(4)} · Sep ${pt.separationPct}%`
          );
        } else {
          const bisect = d3.bisector<PolarPoint, number>((d) => d.alpha).center;
          const idx = Math.max(0, Math.min(polarPts.length - 1, bisect(polarPts, xVal)));
          const pt = polarPts[idx];
          if (!pt) return;
          const px = x(pt.alpha);
          const py1 = chartMode === "ld" ? y1(pt.ld) : y1(pt.cl);
          const py2 = y2 ? y2(pt.cd) : py1;
          focusG.style("display", null);
          focusLine.attr("x1", px).attr("x2", px);
          focusDot1.attr("cx", px).attr("cy", py1);
          if (isDualAxis) focusDot2.attr("cx", px).attr("cy", py2);
          setProbeReadout(
            chartMode === "ld"
              ? `α=${pt.alpha.toFixed(1)}° · L/D ${pt.ld.toFixed(2)} · CL ${pt.cl.toFixed(3)} · Sep ${pt.sep}%`
              : `α=${pt.alpha.toFixed(1)}° · CL ${pt.cl.toFixed(3)} · CD ${pt.cd.toFixed(4)} · L/D ${pt.ld.toFixed(1)}`
          );
        }
      });
  }, [dims, chartMode, validSamples, polarPts, neutralRef, bestBenchmark, zoomTransform, handleResetZoom]);

  const handleExportImage = useCallback(
    async (format: "png" | "svg") => {
      if (!samples.length || !svgRef.current) return;
      const base = stem(airfoilName).replace(/[^\w.-]+/g, "_");
      const fileBase = `${base}_${chartMode}_graph`;
      if (format === "svg") {
        downloadSvgElement(svgRef.current, fileBase);
      } else {
        await downloadSvgAsPng(svgRef.current, fileBase, 2);
      }
    },
    [samples.length, chartMode, airfoilName]
  );

  const sheetRows = useMemo(
    () =>
      samples.map((s) => ({
        sample: s.id,
        airfoil: s.airfoil,
        alpha_deg: Number(s.alpha.toFixed(1)),
        reynolds: s.reynolds,
        cl: s.cl !== null ? Number(s.cl.toFixed(4)) : "",
        cd: s.cd !== null ? Number(s.cd.toFixed(4)) : "",
        ld_ratio: s.ld !== null ? Number(s.ld.toFixed(3)) : "",
        separation_pct: s.separationPct,
        flow_state: s.stateLabel,
        field_view: s.fieldLabel,
        timestamp: s.timestamp,
      })),
    [samples]
  );

  const handleExportCsv = () => {
    if (!sheetRows.length) return;
    const base = stem(airfoilName).replace(/[^\w.-]+/g, "_");
    downloadText(`${base}_datasheet.csv`, toCsv(sheetRows), "text/csv;charset=utf-8");
  };

  const handleExportJson = () => {
    if (!sheetRows.length) return;
    const base = stem(airfoilName).replace(/[^\w.-]+/g, "_");
    const payload = {
      tool: "AeroLab 2D Wind Tunnel",
      solver: "D2Q9 Lattice-Boltzmann (Smagorinsky LES)",
      exportedAt: new Date().toISOString(),
      rowCount: sheetRows.length,
      data: sheetRows,
    };
    downloadText(`${base}_datasheet.json`, JSON.stringify(payload, null, 2), "application/json");
  };

  const recentRows = useMemo(() => [...samples].reverse().slice(0, 60), [samples]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#161A1D]">
            <TrendingUp size={14} className="text-[#1769AA]" aria-hidden="true" />
            <span>Telemetry Graph</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset zoom"
              aria-label="Reset graph zoom"
              className="p-1.5 rounded-md text-[#5C6670] hover:text-[#1769AA] bg-[var(--bg)] border border-[var(--border)] transition-colors cursor-pointer"
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => handleExportImage("png")}
              disabled={!samples.length}
              title="Download Graph PNG"
              className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] hover:text-[#1769AA] disabled:opacity-45 disabled:cursor-not-allowed transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              <Download size={11} aria-hidden="true" />
              <span>PNG</span>
            </button>
            <button
              type="button"
              onClick={() => handleExportImage("svg")}
              disabled={!samples.length}
              title="Download Graph SVG"
              className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] hover:text-[#1769AA] disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
            >
              SVG
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[11.5px] gap-0.5">
          {(
            [
              ["history", "History"],
              ["polar", "α Polar"],
              ["ld", "L/D"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setChartMode(key)}
              className={`py-1 rounded-md font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                chartMode === key
                  ? "bg-[#1769AA] text-white"
                  : "text-[#5C6670] hover:text-[#161A1D]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          ref={containerRef}
          className="w-full h-52 sm:h-56 rounded-lg border border-[var(--border)] bg-white overflow-hidden"
        >
          <svg
            ref={svgRef}
            className="w-full h-full block select-none"
            role="img"
            aria-label={`D3.js 2D Wind Tunnel ${chartMode} telemetry chart`}
          />
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-[#5C6670]">
          <span className="truncate text-[#161A1D]">
            {probeReadout
              ? probeReadout
              : chartMode === "history"
                ? "Scroll/drag to zoom · Double-click resets"
                : chartMode === "polar"
                  ? "Mean CL & CD vs α° (D3 SVG)"
                  : "Aerodynamic efficiency L/D vs α° (D3 SVG)"}
          </span>
          <span className="shrink-0">{samples.length} pts</span>
        </div>
      </div>

      <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2.5 min-w-0">
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#161A1D]">
            <FileSpreadsheet size={14} className="text-[#1769AA]" aria-hidden="true" />
            <span>Data Sheet</span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onRecordSnapshot}
              title="Log current operating point"
              className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--accent-light)] text-[#1769AA] hover:bg-[#1769AA] hover:text-white transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
            >
              <Plus size={12} aria-hidden="true" />
              <span>Log</span>
            </button>
            <button
              type="button"
              onClick={onClearSamples}
              disabled={!samples.length}
              title="Clear recorded data"
              className="p-1.5 rounded-md text-[#5C6670] hover:text-red-600 border border-[var(--border)] bg-[var(--bg)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors cursor-pointer"
              aria-label="Clear data sheet"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="max-h-52 overflow-auto custom-scrollbar rounded-lg border border-[var(--border)] bg-white">
          <table className="w-full border-collapse text-[11px] font-mono tabular-nums">
            <thead className="sticky top-0 bg-[var(--bg)] border-b border-[var(--border)] text-[#5C6670]">
              <tr>
                <th className="text-left font-semibold px-2 py-1.5">#</th>
                <th className="text-right font-semibold px-2 py-1.5">α°</th>
                <th className="text-right font-semibold px-2 py-1.5">CL</th>
                <th className="text-right font-semibold px-2 py-1.5">CD</th>
                <th className="text-right font-semibold px-2 py-1.5">L/D</th>
                <th className="text-right font-semibold px-2 py-1.5">Sep</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {recentRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-[#5C6670] font-sans py-4 px-2">
                    Collecting solver telemetry…
                  </td>
                </tr>
              ) : (
                recentRows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-[var(--bg)]"
                  >
                    <td className="px-2 py-1 text-[#5C6670]">{row.id}</td>
                    <td className="px-2 py-1 text-right text-[#161A1D]">{row.alpha.toFixed(1)}</td>
                    <td className="px-2 py-1 text-right font-semibold text-[#1769AA]">
                      {row.cl !== null ? row.cl.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right text-[#D97706]">
                      {row.cd !== null ? row.cd.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right text-[#161A1D]">
                      {row.ld !== null ? row.ld.toFixed(1) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right text-[#5C6670]">{row.separationPct}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!samples.length}
            className="btn btn-primary-accent btn-sm whitespace-nowrap"
          >
            <Download size={13} aria-hidden="true" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            disabled={!samples.length}
            className="btn btn-secondary btn-sm whitespace-nowrap"
          >
            <FileJson size={13} aria-hidden="true" />
            <span>Export JSON</span>
          </button>
        </div>
      </div>
    </div>
  );
}
