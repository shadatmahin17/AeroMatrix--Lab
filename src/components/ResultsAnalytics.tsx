import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Plotly from "plotly.js-basic-dist-min";
import { Download, FileJson, FileSpreadsheet, Plus, RotateCcw, Trash2, TrendingUp } from "lucide-react";
import { downloadBlob, downloadText, stem, toCsv } from "../lib/files.js";
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

function buildPlotSpec({
  samples,
  mode,
  airfoilName,
  neutralRef = null,
  bestBenchmark = null,
  forExport = false,
}: {
  samples: TelemetrySample[];
  mode: ChartMode;
  airfoilName: string;
  neutralRef?: NeutralReferenceData | null;
  bestBenchmark?: BenchmarkRunDoc | null;
  forExport?: boolean;
}) {
  const valid = samples.filter((s) => s.cl !== null && s.cd !== null);
  const polarPts = mode === "history" ? [] : buildPolarPoints(valid);

  let data: Array<Record<string, unknown>> = [];
  const isDualAxis = mode !== "ld";

  if (mode === "history") {
    const xs = valid.map((s) => s.id);
    const custom = valid.map((s) => [
      s.alpha.toFixed(1),
      s.ld !== null ? s.ld.toFixed(2) : "—",
      s.separationPct,
      s.reynolds.toLocaleString(),
    ]);
    data = [
      {
        type: "scatter",
        mode: valid.length <= 24 ? "lines+markers" : "lines",
        name: "CL",
        x: xs,
        y: valid.map((s) => s.cl),
        customdata: custom,
        line: { color: "#1769AA", width: forExport ? 2.4 : 2 },
        marker: { color: "#1769AA", size: forExport ? 5 : 4 },
        fill: "tozeroy",
        fillcolor: "rgba(23, 105, 170, 0.07)",
        hovertemplate: "CL: <b>%{y:.3f}</b>  (α=%{customdata[0]}°, Sep=%{customdata[2]}%)<extra></extra>",
      },
      {
        type: "scatter",
        mode: valid.length <= 24 ? "lines+markers" : "lines",
        name: "CD",
        yaxis: "y2",
        x: xs,
        y: valid.map((s) => s.cd),
        customdata: custom,
        line: { color: "#D97706", width: forExport ? 2.2 : 1.8, dash: "dot" },
        marker: { color: "#D97706", size: forExport ? 5 : 4, symbol: "diamond" },
        hovertemplate: "CD: <b>%{y:.4f}</b>  (L/D=%{customdata[1]}, Re=%{customdata[3]})<extra></extra>",
      },
    ];
    if (bestBenchmark && xs.length >= 2) {
      data.push({
        type: "scatter",
        mode: "lines",
        name: `Best CL (${bestBenchmark.airfoilName})`,
        x: [xs[0], xs[xs.length - 1]],
        y: [bestBenchmark.cl, bestBenchmark.cl],
        line: { color: "#047857", width: 1.4, dash: "dashdot" },
        hovertemplate: `Best CL: <b>%{y:.3f}</b> (${bestBenchmark.airfoilName})<extra></extra>`,
      });
    }
  } else if (mode === "polar") {
    const xs = polarPts.map((p) => p.alpha);
    const custom = polarPts.map((p) => [p.ld.toFixed(2), p.sep, p.count]);
    data = [
      {
        type: "scatter",
        mode: "lines+markers",
        name: "CL",
        x: xs,
        y: polarPts.map((p) => p.cl),
        customdata: custom,
        line: { color: "#1769AA", width: forExport ? 2.5 : 2, shape: "spline", smoothing: 0.45 },
        marker: { color: "#1769AA", size: forExport ? 7 : 5.5 },
        hovertemplate: "CL: <b>%{y:.3f}</b>  (L/D=%{customdata[0]}, n=%{customdata[2]})<extra></extra>",
      },
      {
        type: "scatter",
        mode: "lines+markers",
        name: "CD",
        yaxis: "y2",
        x: xs,
        y: polarPts.map((p) => p.cd),
        customdata: custom,
        line: { color: "#D97706", width: forExport ? 2.2 : 1.8, dash: "dash", shape: "spline", smoothing: 0.45 },
        marker: { color: "#D97706", size: forExport ? 6.5 : 5, symbol: "diamond" },
        hovertemplate: "CD: <b>%{y:.4f}</b>  (Sep=%{customdata[1]}%)<extra></extra>",
      },
    ];
    if (neutralRef?.rows?.length) {
      const refPrefix = neutralRef.label?.startsWith("NeuroFoil") ? "NeuroFoil" : "Ref";
      data.push({
        type: "scatter",
        mode: "lines",
        name: `${refPrefix} CL`,
        x: neutralRef.rows.map((r) => r.alpha),
        y: neutralRef.rows.map((r) => r.cl),
        line: { color: "#64748B", width: 1.5, dash: "dot" },
        hovertemplate: `${refPrefix} CL: <b>%{y:.3f}</b> (${neutralRef.airfoilName})<extra></extra>`,
      });
    }
  } else {
    const xs = polarPts.map((p) => p.alpha);
    const custom = polarPts.map((p) => [p.cl.toFixed(3), p.cd.toFixed(4), p.sep]);
    data = [
      {
        type: "scatter",
        mode: "lines+markers",
        name: "L/D",
        x: xs,
        y: polarPts.map((p) => p.ld),
        customdata: custom,
        line: { color: "#047857", width: forExport ? 2.5 : 2.1, shape: "spline", smoothing: 0.45 },
        marker: { color: "#047857", size: forExport ? 7 : 5.5 },
        fill: "tozeroy",
        fillcolor: "rgba(4, 120, 87, 0.08)",
        hovertemplate: "L/D: <b>%{y:.2f}</b>  (CL=%{customdata[0]}, CD=%{customdata[1]}, Sep=%{customdata[2]}%)<extra></extra>",
      },
    ];
    if (neutralRef?.rows?.length) {
      const refPrefix = neutralRef.label?.startsWith("NeuroFoil") ? "NeuroFoil" : "Ref";
      data.push({
        type: "scatter",
        mode: "lines",
        name: `${refPrefix} L/D`,
        x: neutralRef.rows.map((r) => r.alpha),
        y: neutralRef.rows.map((r) => r.ld),
        line: { color: "#64748B", width: 1.5, dash: "dot" },
        hovertemplate: `${refPrefix} L/D: <b>%{y:.2f}</b> (${neutralRef.airfoilName})<extra></extra>`,
      });
    }
    if (bestBenchmark) {
      data.push({
        type: "scatter",
        mode: "markers",
        name: `Best (${bestBenchmark.airfoilName})`,
        x: [bestBenchmark.alpha],
        y: [bestBenchmark.ld],
        marker: { color: "#D97706", size: forExport ? 11 : 9, symbol: "star" },
        hovertemplate: `Best L/D: <b>%{y:.2f}</b> @ ${bestBenchmark.alpha.toFixed(1)}° (${bestBenchmark.airfoilName})<extra></extra>`,
      });
    }
  }

  const modeTitle = mode === "history" ? "Telemetry History" : mode === "polar" ? "AoA Polar (CL / CD)" : "Efficiency Polar (L/D)";
  const hasData = mode === "history" ? valid.length > 0 : polarPts.length > 0;

  const layout: Record<string, unknown> = {
    paper_bgcolor: "#FFFFFF",
    plot_bgcolor: "#FFFFFF",
    font: { family: PLOT_FONT_MONO, size: forExport ? 12 : 9.5, color: "#5C6670" },
    margin: forExport
      ? { l: 64, r: isDualAxis ? 64 : 28, t: 68, b: 52 }
      : { l: 38, r: isDualAxis ? 40 : 14, t: 26, b: 30 },
    title: forExport
      ? {
          text: `<b>AeroLab 2D Wind Tunnel — ${airfoilName}</b><br><span style="font-size:12px;color:#5C6670">${modeTitle} · ${valid.length} samples · D2Q9 Smagorinsky LES</span>`,
          font: { family: PLOT_FONT_SANS, size: 16, color: "#161A1D" },
          x: 0.04,
          y: 0.96,
        }
      : undefined,
    showlegend: true,
    legend: {
      orientation: "h",
      x: 0,
      y: forExport ? 1.07 : 1.15,
      xanchor: "left",
      yanchor: "bottom",
      bgcolor: "rgba(255,255,255,0)",
      font: { family: PLOT_FONT_MONO, size: forExport ? 12 : 10, color: "#161A1D" },
    },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: "#FFFFFF",
      bordercolor: "#D9DEE2",
      font: { family: PLOT_FONT_MONO, size: 10.5, color: "#161A1D" },
    },
    uirevision: mode,
    xaxis: {
      title: forExport
        ? { text: mode === "history" ? "Sample #" : "Angle of Attack α (°)", standoff: 10, font: { size: 12, color: "#161A1D" } }
        : undefined,
      tickprefix: mode === "history" ? "#" : "",
      ticksuffix: mode === "history" ? "" : "°",
      gridcolor: "#E5E9EC",
      linecolor: "#D9DEE2",
      mirror: true,
      zeroline: mode !== "history",
      zerolinecolor: "#CBD5E1",
      zerolinewidth: 1,
      tickfont: { size: forExport ? 11 : 9.5, color: "#5C6670" },
    },
    yaxis: {
      title: forExport
        ? { text: mode === "ld" ? "Lift / Drag (L/D)" : "Lift Coefficient (CL)", standoff: 8, font: { size: 12, color: mode === "ld" ? "#047857" : "#1769AA" } }
        : undefined,
      gridcolor: "#E5E9EC",
      linecolor: "#D9DEE2",
      mirror: !isDualAxis,
      zeroline: true,
      zerolinecolor: "#CBD5E1",
      zerolinewidth: 1,
      tickfont: { size: forExport ? 11 : 9.5, color: mode === "ld" ? "#047857" : "#1769AA" },
    },
    ...(isDualAxis
      ? {
          yaxis2: {
            title: forExport
              ? { text: "Drag Coefficient (CD)", standoff: 8, font: { size: 12, color: "#D97706" } }
              : undefined,
            overlaying: "y",
            side: "right",
            showgrid: false,
            zeroline: false,
            linecolor: "#D9DEE2",
            tickfont: { size: forExport ? 11 : 9.5, color: "#D97706" },
          },
        }
      : {}),
    annotations: !hasData
      ? [
          {
            text: "Waiting for solver telemetry…",
            xref: "paper",
            yref: "paper",
            x: 0.5,
            y: 0.5,
            showarrow: false,
            font: { family: PLOT_FONT_SANS, size: 12, color: "#5C6670" },
          },
        ]
      : [],
  };

  return { data, layout };
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
  const plotRef = useRef<HTMLDivElement>(null);
  const isReadyRef = useRef(false);
  const [chartMode, setChartMode] = useState<ChartMode>("history");
  const [revisionBump, setRevisionBump] = useState(0);
  const [visibleTick, setVisibleTick] = useState(0);

  const spec = useMemo(
    () =>
      buildPlotSpec({
        samples,
        mode: chartMode,
        airfoilName,
        neutralRef,
        bestBenchmark,
        forExport: false,
      }),
    [samples, chartMode, airfoilName, neutralRef, bestBenchmark]
  );

  useEffect(() => {
    const el = plotRef.current as (HTMLDivElement & { _fullLayout?: unknown }) | null;
    if (!el || !el.isConnected || el.offsetWidth === 0 || el.offsetHeight === 0) return;

    let cancelled = false;
    const layout = {
      ...spec.layout,
      uirevision: `${chartMode}-${revisionBump}`,
    };

    void Plotly.react(el, spec.data, layout, {
      responsive: false,
      displayModeBar: false,
      scrollZoom: true,
    })
      .then(() => {
        if (!cancelled) {
          isReadyRef.current = true;
        }
      })
      .catch(() => {
        // Ignore transient errors if element unmounted mid-render
      });

    return () => {
      cancelled = true;
    };
  }, [spec, chartMode, revisionBump, visibleTick]);

  useEffect(() => {
    const el = plotRef.current as (HTMLDivElement & { _fullLayout?: unknown }) | null;
    if (!el) return undefined;

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (!el.isConnected || el.offsetWidth === 0 || el.offsetHeight === 0) return;
            if (isReadyRef.current && el._fullLayout) {
              try {
                Plotly.Plots.resize(el);
              } catch {
                // Ignore if Plotly layout is mid-transition
              }
            } else {
              setVisibleTick((t) => t + 1);
            }
          })
        : null;

    ro?.observe(el);
    return () => {
      ro?.disconnect();
      isReadyRef.current = false;
      try {
        Plotly.purge(el);
      } catch {
        // Ignore purge errors on detached nodes
      }
    };
  }, []);

  const handleExportImage = useCallback(
    async (format: "png" | "svg") => {
      if (!samples.length) return;
      const exportSpec = buildPlotSpec({
        samples,
        mode: chartMode,
        airfoilName,
        neutralRef,
        bestBenchmark,
        forExport: true,
      });
      const dataUrl = await Plotly.toImage(
        { data: exportSpec.data, layout: exportSpec.layout },
        { format, width: 1100, height: 620, scale: format === "png" ? 2 : 1 }
      );
      const base = stem(airfoilName).replace(/[^\w.-]+/g, "_");
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      downloadBlob(`${base}_${chartMode}_graph.${format}`, blob);
    },
    [samples, chartMode, airfoilName, neutralRef, bestBenchmark]
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
              onClick={() => setRevisionBump((n) => n + 1)}
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
          ref={plotRef}
          className="w-full h-52 sm:h-56 rounded-lg border border-[var(--border)] bg-white overflow-hidden"
        />

        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-[#5C6670]">
          <span>
            {chartMode === "history"
              ? "Drag to zoom · Double-click resets"
              : chartMode === "polar"
                ? "Mean CL & CD vs α°"
                : "Aerodynamic efficiency L/D vs α°"}
          </span>
          <span>{samples.length} pts</span>
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
