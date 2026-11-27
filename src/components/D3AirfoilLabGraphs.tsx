import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Download, TrendingUp } from 'lucide-react';
import type { NeutralReferenceData } from '../lib/airfoilRepository';
import type { TelemetrySample, TunnelStats } from '../types/airfoil';
import { downloadSvgAsPng, downloadSvgElement } from '../utils/telemetryExport';

interface D3AirfoilLabGraphsProps {
  samples: TelemetrySample[];
  stats: TunnelStats;
  alpha: number;
  airfoilName: string;
  neutralRef?: NeutralReferenceData | null;
}

type D3Mode2D = 'phase' | 'drift' | 'radar';

interface ValidSample2D {
  id: number;
  alpha: number;
  cl: number;
  cd: number;
  ld: number;
  sep: number;
}

const MONO_FONT = '"JetBrains Mono", ui-monospace, monospace';

export default function D3AirfoilLabGraphs({
  samples,
  stats,
  alpha,
  airfoilName,
  neutralRef = null,
}: D3AirfoilLabGraphsProps) {
  const [mode, setMode] = useState<D3Mode2D>('phase');
  const [probeText, setProbeText] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(356);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => setWidth(Math.max(260, Math.floor(el.clientWidth)));
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const validSamples = useMemo<ValidSample2D[]>(() => {
    return samples
      .filter((s): s is TelemetrySample & { cl: number; cd: number } => s.cl !== null && s.cd !== null)
      .map((s) => ({
        id: s.id,
        alpha: s.alpha,
        cl: s.cl,
        cd: Math.max(0.0005, s.cd),
        ld: s.ld ?? (s.cd > 0.001 ? s.cl / s.cd : 0),
        sep: s.separationPct,
      }));
  }, [samples]);

  useEffect(() => {
    setProbeText(null);
  }, [mode, airfoilName]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const height = mode === 'radar' ? 236 : 226;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    svg
      .append('rect')
      .attr('class', 'export-bg')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#FFFFFF');

    if (mode !== 'radar' && validSamples.length === 0) {
      svg
        .append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '11px')
        .attr('fill', '#5C6670')
        .text('Collecting D2Q9 LBM samples...');
      return;
    }

    // -------------------------------------------------------------------------
    // MODE 1: LBM PHASE PORTRAIT (CD vs CL colored by Separation % + Delaunay)
    // -------------------------------------------------------------------------
    if (mode === 'phase') {
      const margin = { top: 22, right: 16, bottom: 32, left: 42 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const cdMax = Math.max(0.12, (d3.max(validSamples, (d) => d.cd) ?? 0.2) * 1.15);
      const clMin = Math.min(-0.3, (d3.min(validSamples, (d) => d.cl) ?? 0) - 0.15);
      const clMax = Math.max(1.2, (d3.max(validSamples, (d) => d.cl) ?? 1) + 0.15);

      const xScale = d3.scaleLinear().domain([0, cdMax]).nice().range([0, innerW]);
      const yScale = d3.scaleLinear().domain([clMin, clMax]).nice().range([innerH, 0]);
      const sepColor = d3.scaleSequential(d3.interpolateRdYlBu).domain([100, 0]);

      // Grid
      g.append('g')
        .selectAll('line')
        .data(yScale.ticks(4))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      // Chronological Trajectory Line
      const traj = d3
        .line<ValidSample2D>()
        .x((d) => xScale(d.cd))
        .y((d) => yScale(d.cl))
        .curve(d3.curveCatmullRom.alpha(0.5));

      g.append('path')
        .datum(validSamples)
        .attr('d', traj)
        .attr('fill', 'none')
        .attr('stroke', '#94A3B8')
        .attr('stroke-width', 1.2)
        .attr('opacity', 0.7);

      // Individual sample nodes colored by flow separation %
      const circles = g
        .selectAll('circle.phase-pt')
        .data(validSamples)
        .join('circle')
        .attr('class', 'phase-pt')
        .attr('cx', (d) => xScale(d.cd))
        .attr('cy', (d) => yScale(d.cl))
        .attr('r', (_d, i) => (i === validSamples.length - 1 ? 5.5 : 3.6))
        .attr('fill', (d) => sepColor(d.sep))
        .attr('stroke', (_d, i) => (i === validSamples.length - 1 ? '#161A1D' : '#FFFFFF'))
        .attr('stroke-width', (_d, i) => (i === validSamples.length - 1 ? 1.8 : 0.8));

      // Delaunay nearest-point Voronoi snapping for smooth hover
      const delaunay = d3.Delaunay.from(
        validSamples,
        (d) => xScale(d.cd),
        (d) => yScale(d.cl)
      );

      const focusRing = g
        .append('circle')
        .attr('r', 7)
        .attr('fill', 'none')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 1.8)
        .attr('opacity', 0);

      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx, my] = d3.pointer(event);
          const idx = delaunay.find(mx, my);
          const pt = validSamples[idx];
          if (!pt) return;
          focusRing.attr('cx', xScale(pt.cd)).attr('cy', yScale(pt.cl)).attr('opacity', 1);
          circles.attr('opacity', (_d, i) => (i === idx ? 1 : 0.72));
          setProbeText(
            `#${pt.id} · α ${pt.alpha.toFixed(1)}° · CD ${pt.cd.toFixed(4)} · CL ${pt.cl.toFixed(3)} · Sep ${pt.sep}%`
          );
        })
        .on('mouseleave', () => {
          focusRing.attr('opacity', 0);
          circles.attr('opacity', 1);
        });

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).ticks(4).tickFormat((d) => Number(d).toFixed(2)))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yScale).ticks(4).tickFormat((d) => Number(d).toFixed(1)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      svg
        .append('text')
        .attr('x', margin.left)
        .attr('y', 13)
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .style('font-weight', 700)
        .attr('fill', '#161A1D')
        .text('LBM Phase Trajectory (CD vs CL · Color = Sep%)');

      svg
        .append('text')
        .attr('x', margin.left + innerW / 2)
        .attr('y', height - 4)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#5C6670')
        .text('Drag Coefficient CD');
    }

    // -------------------------------------------------------------------------
    // MODE 2: LBM STABILITY DRIFT & SEPARATION RIBBON
    // -------------------------------------------------------------------------
    else if (mode === 'drift') {
      const margin = { top: 22, right: 34, bottom: 32, left: 40 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const firstId = validSamples[0].id;
      const lastId = Math.max(firstId + 1, validSamples[validSamples.length - 1].id);
      const xScale = d3.scaleLinear().domain([firstId, lastId]).range([0, innerW]);

      const yLd = d3
        .scaleLinear()
        .domain([
          Math.min(0, d3.min(validSamples, (d) => d.ld) ?? 0),
          Math.max(8, (d3.max(validSamples, (d) => d.ld) ?? 10) * 1.15),
        ])
        .nice()
        .range([innerH, 0]);
      const ySep = d3.scaleLinear().domain([0, 100]).range([innerH, 0]);

      const sepArea = d3
        .area<ValidSample2D>()
        .x((d) => xScale(d.id))
        .y0(innerH)
        .y1((d) => ySep(d.sep))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(validSamples)
        .attr('d', sepArea)
        .attr('fill', 'rgba(220, 38, 38, 0.14)')
        .attr('stroke', 'rgba(220, 38, 38, 0.55)')
        .attr('stroke-width', 1.2);

      const ldLine = d3
        .line<ValidSample2D>()
        .x((d) => xScale(d.id))
        .y((d) => yLd(d.ld))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(validSamples)
        .attr('d', ldLine)
        .attr('fill', 'none')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2);

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).ticks(4).tickFormat((d) => `#${Math.round(Number(d))}`))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yLd).ticks(4))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#1769AA'));

      g.append('g')
        .attr('transform', `translate(${innerW},0)`)
        .call(d3.axisRight(ySep).ticks(4).tickFormat((d) => `${d}%`))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#DC2626'));

      const hoverLine = g
        .append('line')
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#161A1D')
        .attr('stroke-width', 1)
        .attr('opacity', 0);
      const bisect = d3.bisector<ValidSample2D, number>((d) => d.id).center;

      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = bisect(validSamples, xScale.invert(mx));
          const pt = validSamples[Math.max(0, Math.min(validSamples.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.id)).attr('x2', xScale(pt.id)).attr('opacity', 0.8);
          setProbeText(
            `Sample #${pt.id} · L/D ${pt.ld.toFixed(1)} · Sep ${pt.sep}% · CL ${pt.cl.toFixed(3)}`
          );
        })
        .on('mouseleave', () => hoverLine.attr('opacity', 0));

      svg
        .append('text')
        .attr('x', margin.left)
        .attr('y', 13)
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .style('font-weight', 700)
        .attr('fill', '#161A1D')
        .text('L/D (Blue) vs Separation % (Red Area)');
    }

    // -------------------------------------------------------------------------
    // MODE 3: 2D LBM vs NEUROFOIL CALIBRATION RADAR
    // -------------------------------------------------------------------------
    else {
      const cx = width / 2;
      const cy = height / 2 + 6;
      const maxR = Math.min(width, height) * 0.34;

      const liveCl = stats.cl ?? 0;
      const liveCd = stats.cd ?? 0.05;
      const liveLd = liveCd > 0.001 ? Math.max(0, liveCl / liveCd) : 0;

      // Interpolate NeuroFoil prediction near current alpha if available
      const nfRows = neutralRef?.rows ?? [];
      let nfCl = 0.6;
      let nfLd = 15;
      if (nfRows.length > 0) {
        const nearest = nfRows.reduce((best, r) =>
          Math.abs(r.alpha - alpha) < Math.abs(best.alpha - alpha) ? r : best
        );
        nfCl = nearest.cl;
        nfLd = nearest.ld;
      }

      const axes = [
        {
          axis: 'LIFT CL',
          val: Math.max(0, Math.min(1, Math.abs(liveCl) / 1.6)),
          ref: Math.max(0, Math.min(1, Math.abs(nfCl) / 1.6)),
          raw: `CL ${liveCl.toFixed(2)}`,
        },
        {
          axis: 'GLIDE L/D',
          val: Math.max(0, Math.min(1, liveLd / 35)),
          ref: Math.max(0, Math.min(1, nfLd / 35)),
          raw: `${liveLd.toFixed(1)}:1`,
        },
        {
          axis: 'ATTACHED',
          val: Math.max(0, Math.min(1, (100 - stats.separationPct) / 100)),
          ref: 0.9,
          raw: `${100 - stats.separationPct}%`,
        },
        {
          axis: 'LOW DRAG',
          val: Math.max(0, Math.min(1, 1 - liveCd / 0.25)),
          ref: 0.85,
          raw: `CD ${liveCd.toFixed(3)}`,
        },
        {
          axis: 'REYNOLDS',
          val: Math.max(0, Math.min(1, stats.reynolds / 120000)),
          ref: 0.75,
          raw: `${stats.reynolds.toLocaleString()}`,
        },
      ];

      const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);
      const angleSlice = (Math.PI * 2) / axes.length;
      const rScale = d3.scaleLinear().domain([0, 1]).range([0, maxR]);

      const radial = d3
        .lineRadial<number>()
        .angle((_d, i) => i * angleSlice)
        .radius((d) => rScale(d))
        .curve(d3.curveLinearClosed);

      [0.25, 0.5, 0.75, 1.0].forEach((lvl) => {
        g.append('path')
          .datum(d3.range(axes.length).map(() => lvl))
          .attr('d', radial)
          .attr('fill', lvl === 1 ? 'rgba(241, 245, 249, 0.55)' : 'none')
          .attr('stroke', '#CBD5E1')
          .attr('stroke-width', 0.8);
      });

      axes.forEach((a, i) => {
        const ang = i * angleSlice - Math.PI / 2;
        g.append('line')
          .attr('x1', 0)
          .attr('y1', 0)
          .attr('x2', Math.cos(ang) * maxR)
          .attr('y2', Math.sin(ang) * maxR)
          .attr('stroke', '#CBD5E1');
        g.append('text')
          .attr('x', Math.cos(ang) * (maxR + 13))
          .attr('y', Math.sin(ang) * (maxR + 11) + 3)
          .attr('text-anchor', Math.abs(Math.cos(ang)) < 0.2 ? 'middle' : Math.cos(ang) > 0 ? 'start' : 'end')
          .style('font-family', MONO_FONT)
          .style('font-size', '8px')
          .style('font-weight', 700)
          .attr('fill', '#334155')
          .text(a.axis);
      });

      g.append('path')
        .datum(axes.map((a) => a.ref))
        .attr('d', radial)
        .attr('fill', 'rgba(5, 150, 105, 0.08)')
        .attr('stroke', '#059669')
        .attr('stroke-width', 1.4)
        .attr('stroke-dasharray', '4 2.5');

      g.append('path')
        .datum(axes.map((a) => a.val))
        .attr('d', radial)
        .attr('fill', 'rgba(23, 105, 170, 0.22)')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2);

      axes.forEach((a, i) => {
        const ang = i * angleSlice - Math.PI / 2;
        g.append('circle')
          .attr('cx', Math.cos(ang) * rScale(a.val))
          .attr('cy', Math.sin(ang) * rScale(a.val))
          .attr('r', 4)
          .attr('fill', '#1769AA')
          .attr('stroke', '#FFFFFF')
          .attr('stroke-width', 1.4)
          .style('cursor', 'pointer')
          .on('mouseenter', () => {
            setProbeText(`${a.axis}: ${(a.val * 100).toFixed(0)}% (${a.raw})`);
          });
      });
    }
  }, [mode, width, validSamples, stats, alpha, neutralRef]);

  const exportBase = `aeromatrix_2d_d3_${mode}_aoa${alpha.toFixed(1)}deg`;

  return (
    <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2.5 min-w-0">
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-xs font-bold text-[#161A1D]">
          <TrendingUp size={14} className="text-[#1769AA]" aria-hidden="true" />
          <span>Phase &amp; Drift Telemetry</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => svgRef.current && void downloadSvgAsPng(svgRef.current, exportBase, 2)}
            className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] hover:text-[#1769AA] transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
          >
            <Download size={11} aria-hidden="true" />
            <span>PNG</span>
          </button>
          <button
            type="button"
            onClick={() => svgRef.current && downloadSvgElement(svgRef.current, exportBase)}
            className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] hover:text-[#1769AA] transition-colors whitespace-nowrap cursor-pointer"
          >
            SVG
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[11px] gap-0.5">
        {(
          [
            ['phase', 'Phase Map'],
            ['drift', 'Drift'],
            ['radar', '2D Radar'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={`py-1 rounded-md font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              mode === id
                ? 'bg-[#1769AA] text-white'
                : 'text-[#5C6670] hover:text-[#161A1D]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        className="w-full rounded-lg border border-[var(--border)] bg-white overflow-hidden"
      >
        <svg ref={svgRef} className="block w-full h-auto select-none" />
      </div>

      <div className="px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono tabular-nums text-[#5C6670] flex items-center justify-between gap-2">
        <span className="truncate">
          {probeText ??
            (mode === 'phase'
              ? 'Hover points (Voronoi snap) to probe CD/CL/Sep%'
              : mode === 'drift'
                ? 'Hover timeline to inspect L/D & separation drift'
                : 'Blue = Live D2Q9 LBM · Green = NeuroFoil Ref')}
        </span>
        <span className="text-[#1769AA] font-semibold shrink-0">D3 v7</span>
      </div>
    </div>
  );
}
