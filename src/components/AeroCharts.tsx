import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { AircraftModelType, AeroTelemetry } from '../types/aerodynamics';
import {
  calculateAeroTelemetry,
  computeSectionCpProfile,
  getEffectiveStallAngles,
} from '../utils/airfoilGenerators';
import {
  computeBenchmarkDeviation,
  convert2DBenchmarkToFiniteWing,
  getBenchmarkCpStations,
  getNacaBenchmark,
} from '../data/nacaBenchmarks';
import {
  downloadCurveDataCSV,
  downloadSvgAsPng,
  downloadSvgElement,
} from '../utils/telemetryExport';
import {
  ChartLineUp,
  DownloadSimple,
  CaretDown,
  FilePng,
  FileSvg,
  FileCsv,
  CheckCircle,
} from '@phosphor-icons/react';

interface AeroChartsProps {
  modelType: AircraftModelType;
  currentAoa: number;
  airspeedKts: number;
  altitudeFt: number;
  flapsDeg: number;
  telemetry: AeroTelemetry;
  customGlbVersion?: number;
}

interface PolarPoint {
  aoa: number;
  cl: number;
  cd: number;
  ldRatio: number;
  isStalled: boolean;
  flowState: string;
}

type ChartTab = 'lift' | 'dragAlpha' | 'dragPolar' | 'pressure';

const MONO_FONT = '"JetBrains Mono", ui-monospace, monospace';

export const AeroCharts: React.FC<AeroChartsProps> = ({
  modelType,
  currentAoa,
  airspeedKts,
  altitudeFt,
  flapsDeg,
  telemetry,
  customGlbVersion = 0,
}) => {
  const [activeTab, setActiveTab] = useState<ChartTab>('lift');
  const [showBenchmarkOverlay, setShowBenchmarkOverlay] = useState(true);
  const [showChartExportMenu, setShowChartExportMenu] = useState(false);
  const [chartSuccessMsg, setChartSuccessMsg] = useState<string | null>(null);
  const [probeReadout, setProbeReadout] = useState<string | null>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const chartMenuRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number }>({
    width: 372,
    height: 222,
  });

  const benchmarkDataset = useMemo(() => getNacaBenchmark(modelType), [modelType]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (chartMenuRef.current && !chartMenuRef.current.contains(event.target as Node)) {
        setShowChartExportMenu(false);
      }
    };
    if (showChartExportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showChartExportMenu]);

  // Responsive SVG dimensions via ResizeObserver
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const sync = () => {
      const w = Math.max(260, Math.floor(el.clientWidth));
      const h = Math.max(204, Math.floor(el.clientHeight) || 222);
      setDims((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  // High-resolution AoA sweep (-20 deg to +30 deg in 0.5 deg increments)
  const aoaSweep = useMemo<PolarPoint[]>(() => {
    const pts: PolarPoint[] = [];
    for (let a = -20; a <= 30.001; a += 0.5) {
      const aoa = Math.round(a * 10) / 10;
      const pt = calculateAeroTelemetry(modelType, aoa, airspeedKts, altitudeFt, flapsDeg);
      pts.push({
        aoa,
        cl: pt.cl,
        cd: pt.cd,
        ldRatio: pt.ldRatio,
        isStalled: pt.isStalled,
        flowState: pt.flowState,
      });
    }
    return pts;
  }, [modelType, airspeedKts, altitudeFt, flapsDeg, customGlbVersion]);

  // First-principles chordwise pressure distribution along x/c in [0, 1]
  const cpSweep = useMemo(() => {
    return computeSectionCpProfile(
      modelType,
      currentAoa,
      airspeedKts,
      altitudeFt,
      flapsDeg
    );
  }, [modelType, currentAoa, airspeedKts, altitudeFt, flapsDeg, customGlbVersion]);

  const benchmarkCp = useMemo(() => {
    if (!benchmarkDataset || !showBenchmarkOverlay) return null;
    return getBenchmarkCpStations(benchmarkDataset, currentAoa);
  }, [benchmarkDataset, showBenchmarkOverlay, currentAoa]);

  const benchmarkDeviation = useMemo(() => {
    if (!benchmarkDataset || !showBenchmarkOverlay) return null;
    return computeBenchmarkDeviation(modelType, telemetry, currentAoa, aoaSweep);
  }, [benchmarkDataset, showBenchmarkOverlay, modelType, telemetry, currentAoa, aoaSweep]);

  useEffect(() => {
    setProbeReadout(null);
  }, [activeTab, modelType]);

  // Render D3.js SVG Graph
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const { width, height } = dims;
    svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('width', width)
      .attr('height', height);

    svg
      .append('rect')
      .attr('class', 'export-bg')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#F7F9FA');

    const { posStallAngle: effectiveStall, negStallAngle } = getEffectiveStallAngles(
      modelType,
      flapsDeg
    );
    const negStall = negStallAngle > 0 ? -negStallAngle : 0;

    const defs = svg.append('defs');
    const margin = {
      top: benchmarkDataset && showBenchmarkOverlay ? 28 : 22,
      right: 16,
      bottom: 30,
      left: 44,
    };
    const innerW = Math.max(120, width - margin.left - margin.right);
    const innerH = Math.max(90, height - margin.top - margin.bottom);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const clipId = `polar-clip-${activeTab}`;
    defs
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('width', innerW)
      .attr('height', innerH);
    const plotArea = g.append('g').attr('clip-path', `url(#${clipId})`);

    const drawLegend = (items: Array<{ color: string; label: string; dashed?: boolean }>) => {
      let lx = width - margin.right;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        const textW = it.label.length * 5.2 + 18;
        lx -= textW;
        const itemG = svg.append('g').attr('transform', `translate(${lx}, 9)`);
        itemG
          .append('line')
          .attr('x1', 0)
          .attr('x2', 11)
          .attr('y1', 4)
          .attr('y2', 4)
          .attr('stroke', it.color)
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', it.dashed ? '3 2' : 'none');
        itemG
          .append('text')
          .attr('x', 14)
          .attr('y', 7)
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .attr('fill', '#5C6670')
          .text(it.label);
      }
    };

    const drawOperatingBadge = (cx: number, cy: number, color: string, labelText: string) => {
      const clampedX = Math.max(4, Math.min(innerW - 4, cx));
      const clampedY = Math.max(4, Math.min(innerH - 4, cy));
      const opG = g.append('g').attr('pointer-events', 'none');

      opG
        .append('circle')
        .attr('cx', clampedX)
        .attr('cy', clampedY)
        .attr('r', 8)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 1.1)
        .attr('opacity', 0.45);
      opG
        .append('circle')
        .attr('cx', clampedX)
        .attr('cy', clampedY)
        .attr('r', 4.5)
        .attr('fill', color)
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 1.8);

      const badgeW = labelText.length * 5.8 + 10;
      const placeLeft = clampedX > innerW * 0.56;
      const placeBelow = clampedY < 26;
      const bx = placeLeft ? Math.max(2, clampedX - badgeW - 8) : Math.min(innerW - badgeW - 2, clampedX + 8);
      const by = placeBelow ? Math.min(innerH - 18, clampedY + 8) : Math.max(2, clampedY - 22);

      opG
        .append('rect')
        .attr('x', bx)
        .attr('y', by)
        .attr('width', badgeW)
        .attr('height', 16)
        .attr('rx', 3.5)
        .attr('fill', 'rgba(255,255,255,0.94)')
        .attr('stroke', color)
        .attr('stroke-width', 1);
      opG
        .append('text')
        .attr('x', bx + 5)
        .attr('y', by + 11)
        .style('font-family', MONO_FONT)
        .style('font-size', '9px')
        .style('font-weight', 700)
        .attr('fill', color)
        .text(labelText);
    };

    // =========================================================================
    // TAB 1: LIFT CURVE (CL - alpha)
    // =========================================================================
    if (activeTab === 'lift') {
      const xScale = d3.scaleLinear().domain([-20, 30]).range([0, innerW]);
      const minCl = Math.min(-1.4, (d3.min(aoaSweep, (d) => d.cl) ?? -1.2) - 0.2);
      const maxCl = Math.max(2.2, (d3.max(aoaSweep, (d) => d.cl) ?? 2.0) + 0.25);
      const yScale = d3.scaleLinear().domain([minCl, maxCl]).nice().range([innerH, 0]);

      // Horizontal & Vertical Gridlines
      plotArea
        .selectAll('line.gy')
        .data(yScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      plotArea
        .selectAll('line.gx')
        .data([-10, 0, 10, 20])
        .join('line')
        .attr('x1', (d) => xScale(d))
        .attr('x2', (d) => xScale(d))
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', (d) => (d === 0 ? '#94A3B8' : '#E2E8F0'))
        .attr('stroke-dasharray', '3 3');

      // Zero Lift Axis
      plotArea
        .append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', yScale(0))
        .attr('y2', yScale(0))
        .attr('stroke', '#94A3B8')
        .attr('stroke-dasharray', '3 3');

      // Stall Zone Shading
      if (effectiveStall > 0) {
        if (effectiveStall < 30) {
          const sx = xScale(effectiveStall);
          plotArea
            .append('rect')
            .attr('x', sx)
            .attr('y', 0)
            .attr('width', innerW - sx)
            .attr('height', innerH)
            .attr('fill', 'rgba(220, 38, 38, 0.08)');
          plotArea
            .append('line')
            .attr('x1', sx)
            .attr('x2', sx)
            .attr('y1', 0)
            .attr('y2', innerH)
            .attr('stroke', 'rgba(220, 38, 38, 0.55)')
            .attr('stroke-dasharray', '4 3');
          plotArea
            .append('text')
            .attr('x', sx + 4)
            .attr('y', 11)
            .style('font-family', MONO_FONT)
            .style('font-size', '8.5px')
            .style('font-weight', 700)
            .attr('fill', '#DC2626')
            .text(`STALL αcrit +${effectiveStall.toFixed(0)}°`);
        }
        if (negStall > -20) {
          plotArea
            .append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', xScale(negStall))
            .attr('height', innerH)
            .attr('fill', 'rgba(220, 38, 38, 0.08)');
        }
      }

      // Area Gradient Fill
      const gradId = 'd3-lift-grad';
      const grad = defs
        .append('linearGradient')
        .attr('id', gradId)
        .attr('x1', '0')
        .attr('y1', '0')
        .attr('x2', '0')
        .attr('y2', '1');
      grad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(23, 105, 170, 0.22)');
      grad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(23, 105, 170, 0.01)');

      const area = d3
        .area<PolarPoint>()
        .x((d) => xScale(d.aoa))
        .y0(yScale(0))
        .y1((d) => yScale(d.cl))
        .curve(d3.curveMonotoneX);

      plotArea.append('path').datum(aoaSweep).attr('d', area).attr('fill', `url(#${gradId})`);

      // Sim CL Curve
      const line = d3
        .line<PolarPoint>()
        .x((d) => xScale(d.aoa))
        .y((d) => yScale(d.cl))
        .curve(d3.curveMonotoneX);

      plotArea
        .append('path')
        .datum(aoaSweep)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2.4);

      // Benchmark Overlays
      if (benchmarkDataset && showBenchmarkOverlay) {
        const ref3d = benchmarkDataset.polar.map((p) => {
          const fw = convert2DBenchmarkToFiniteWing(p, telemetry.aspectRatio, telemetry.oswaldEfficiency);
          return { aoa: fw.aoa, cl: fw.cl3d };
        });
        const ref2d = benchmarkDataset.polar.map((p) => ({ aoa: p.aoa, cl: p.cl2d }));

        const refLine = d3
          .line<{ aoa: number; cl: number }>()
          .x((d) => xScale(d.aoa))
          .y((d) => yScale(d.cl))
          .curve(d3.curveMonotoneX);

        plotArea
          .append('path')
          .datum(ref2d)
          .attr('d', refLine)
          .attr('fill', 'none')
          .attr('stroke', '#64748B')
          .attr('stroke-width', 1.3)
          .attr('stroke-dasharray', '2 2');

        plotArea
          .append('path')
          .datum(ref3d)
          .attr('d', refLine)
          .attr('fill', 'none')
          .attr('stroke', '#059669')
          .attr('stroke-width', 1.8)
          .attr('stroke-dasharray', '5 3');

        plotArea
          .selectAll('circle.naca-pt')
          .data(ref3d)
          .join('circle')
          .attr('cx', (d) => xScale(d.aoa))
          .attr('cy', (d) => yScale(d.cl))
          .attr('r', 2.2)
          .attr('fill', '#059669');

        drawLegend([
          { color: '#1769AA', label: 'Sim CL' },
          { color: '#059669', label: 'NACA 3D', dashed: true },
          { color: '#64748B', label: 'NACA 2D', dashed: true },
        ]);
      }

      const opColor = telemetry.isStalled ? '#DC2626' : '#1769AA';
      drawOperatingBadge(
        xScale(currentAoa),
        yScale(telemetry.cl),
        opColor,
        `α ${currentAoa >= 0 ? '+' : ''}${currentAoa.toFixed(1)}° · CL ${telemetry.cl.toFixed(2)}`
      );

      // Axes
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).tickValues([-20, -10, 0, 10, 20, 30]).tickFormat((d) => `${d}°`))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yScale).ticks(5).tickFormat((d) => Number(d).toFixed(1)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      svg
        .append('text')
        .attr('x', 8)
        .attr('y', 14)
        .style('font-family', MONO_FONT)
        .style('font-size', '9px')
        .style('font-weight', 700)
        .attr('fill', '#5C6670')
        .text('CL');

      svg
        .append('text')
        .attr('x', margin.left + innerW / 2)
        .attr('y', height - 4)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '9px')
        .attr('fill', '#5C6670')
        .text('Angle of Attack α (°)');

      // Hover Crosshair
      const hoverLine = plotArea.append('line').attr('y1', 0).attr('y2', innerH).attr('stroke', '#64748B').attr('stroke-dasharray', '2 2').attr('opacity', 0);
      const bisect = d3.bisector<PolarPoint, number>((d) => d.aoa).center;
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = bisect(aoaSweep, xScale.invert(mx));
          const pt = aoaSweep[Math.max(0, Math.min(aoaSweep.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.aoa)).attr('x2', xScale(pt.aoa)).attr('opacity', 0.85);
          setProbeReadout(
            `α ${pt.aoa >= 0 ? '+' : ''}${pt.aoa.toFixed(1)}° · CL ${pt.cl.toFixed(3)} · CD ${pt.cd.toFixed(4)} · L/D ${pt.ldRatio.toFixed(1)}:1 · ${pt.isStalled ? 'STALL' : 'Attached'}`
          );
        })
        .on('mouseleave', () => hoverLine.attr('opacity', 0));
    }

    // =========================================================================
    // TAB 2: DRAG CURVE (CD - alpha)
    // =========================================================================
    else if (activeTab === 'dragAlpha') {
      const xScale = d3.scaleLinear().domain([-20, 30]).range([0, innerW]);
      const maxCdVal = Math.max(
        0.25,
        Math.min(1.6, Math.ceil(Math.max(...aoaSweep.map((p) => p.cd), telemetry.cd) * 10) / 10 + 0.05)
      );
      const yScale = d3.scaleLinear().domain([0, maxCdVal]).nice().range([innerH, 0]);

      plotArea
        .selectAll('line.gy')
        .data(yScale.ticks(4))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      if (effectiveStall > 0) {
        if (effectiveStall < 30) {
          const sx = xScale(effectiveStall);
          plotArea.append('rect').attr('x', sx).attr('y', 0).attr('width', innerW - sx).attr('height', innerH).attr('fill', 'rgba(220, 38, 38, 0.08)');
          plotArea.append('text').attr('x', sx + 4).attr('y', 11).style('font-family', MONO_FONT).style('font-size', '8.5px').style('font-weight', 700).attr('fill', '#DC2626').text('SEP DRAG');
        }
        if (negStall > -20) {
          plotArea.append('rect').attr('x', 0).attr('y', 0).attr('width', xScale(negStall)).attr('height', innerH).attr('fill', 'rgba(220, 38, 38, 0.08)');
        }
      }

      const gradId = 'd3-cd-grad';
      const grad = defs.append('linearGradient').attr('id', gradId).attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
      grad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(217, 119, 6, 0.22)');
      grad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(217, 119, 6, 0.01)');

      plotArea
        .append('path')
        .datum(aoaSweep)
        .attr(
          'd',
          d3.area<PolarPoint>().x((d) => xScale(d.aoa)).y0(innerH).y1((d) => yScale(Math.min(maxCdVal, d.cd))).curve(d3.curveMonotoneX)
        )
        .attr('fill', `url(#${gradId})`);

      plotArea
        .append('path')
        .datum(aoaSweep)
        .attr(
          'd',
          d3.line<PolarPoint>().x((d) => xScale(d.aoa)).y((d) => yScale(Math.min(maxCdVal, d.cd))).curve(d3.curveMonotoneX)
        )
        .attr('fill', 'none')
        .attr('stroke', '#D97706')
        .attr('stroke-width', 2.4);

      if (benchmarkDataset && showBenchmarkOverlay) {
        const ref3d = benchmarkDataset.polar.map((p) => {
          const fw = convert2DBenchmarkToFiniteWing(p, telemetry.aspectRatio, telemetry.oswaldEfficiency);
          return { aoa: fw.aoa, cd: fw.cd3d };
        });
        const refLine = d3
          .line<{ aoa: number; cd: number }>()
          .x((d) => xScale(d.aoa))
          .y((d) => yScale(Math.min(maxCdVal, d.cd)))
          .curve(d3.curveMonotoneX);
        plotArea
          .append('path')
          .datum(ref3d)
          .attr('d', refLine)
          .attr('fill', 'none')
          .attr('stroke', '#059669')
          .attr('stroke-width', 1.8)
          .attr('stroke-dasharray', '5 3');
        drawLegend([
          { color: '#D97706', label: 'Sim CD' },
          { color: '#059669', label: 'NACA 3D', dashed: true },
        ]);
      }

      const opColor = telemetry.isStalled ? '#DC2626' : '#D97706';
      drawOperatingBadge(
        xScale(currentAoa),
        yScale(Math.min(maxCdVal, telemetry.cd)),
        opColor,
        `α ${currentAoa >= 0 ? '+' : ''}${currentAoa.toFixed(1)}° · CD ${telemetry.cd.toFixed(3)}`
      );

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).tickValues([-20, -10, 0, 10, 20, 30]).tickFormat((d) => `${d}°`))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yScale).ticks(4).tickFormat((d) => Number(d).toFixed(2)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      svg.append('text').attr('x', 8).attr('y', 14).style('font-family', MONO_FONT).style('font-size', '9px').style('font-weight', 700).attr('fill', '#5C6670').text('CD');
      svg.append('text').attr('x', margin.left + innerW / 2).attr('y', height - 4).attr('text-anchor', 'middle').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670').text('Angle of Attack α (°)');

      const hoverLine = plotArea.append('line').attr('y1', 0).attr('y2', innerH).attr('stroke', '#D97706').attr('stroke-dasharray', '2 2').attr('opacity', 0);
      const bisect = d3.bisector<PolarPoint, number>((d) => d.aoa).center;
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = bisect(aoaSweep, xScale.invert(mx));
          const pt = aoaSweep[Math.max(0, Math.min(aoaSweep.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.aoa)).attr('x2', xScale(pt.aoa)).attr('opacity', 0.85);
          setProbeReadout(`α ${pt.aoa >= 0 ? '+' : ''}${pt.aoa.toFixed(1)}° · CD ${pt.cd.toFixed(4)} · CL ${pt.cl.toFixed(3)} · L/D ${pt.ldRatio.toFixed(1)}:1`);
        })
        .on('mouseleave', () => hoverLine.attr('opacity', 0));
    }

    // =========================================================================
    // TAB 3: DRAG POLAR (CL vs CD) + (L/D)max TANGENT RAY
    // =========================================================================
    else if (activeTab === 'dragPolar') {
      const maxCdVal = Math.max(
        0.5,
        Math.min(1.8, Math.ceil(Math.max(...aoaSweep.map((p) => p.cd), telemetry.cd) * 10) / 10 + 0.05)
      );
      const minCl = Math.min(-1.2, (d3.min(aoaSweep, (d) => d.cl) ?? -1.2) - 0.15);
      const maxCl = Math.max(2.2, (d3.max(aoaSweep, (d) => d.cl) ?? 2.2) + 0.2);

      const xScale = d3.scaleLinear().domain([0, maxCdVal]).range([0, innerW]);
      const yScale = d3.scaleLinear().domain([minCl, maxCl]).nice().range([innerH, 0]);

      plotArea
        .selectAll('line.gy')
        .data(yScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      plotArea.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', yScale(0)).attr('y2', yScale(0)).attr('stroke', '#94A3B8').attr('stroke-dasharray', '3 3');

      // Best L/D Tangent Ray
      let bestPt = aoaSweep[0];
      for (const p of aoaSweep) {
        if (p.ldRatio > bestPt.ldRatio) bestPt = p;
      }
      if (bestPt.ldRatio > 1.5 && bestPt.cd > 0.005) {
        const rayScale = Math.min(2.1 / Math.max(0.1, bestPt.cl), maxCdVal / bestPt.cd);
        const endCd = bestPt.cd * rayScale;
        const endCl = bestPt.cl * rayScale;
        plotArea
          .append('line')
          .attr('x1', xScale(0))
          .attr('y1', yScale(0))
          .attr('x2', xScale(endCd))
          .attr('y2', yScale(endCl))
          .attr('stroke', '#10B981')
          .attr('stroke-width', 1.4)
          .attr('stroke-dasharray', '4 3');
        plotArea
          .append('text')
          .attr('x', Math.min(innerW - 76, xScale(endCd) - 24))
          .attr('y', Math.max(12, yScale(endCl) - 4))
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .style('font-weight', 700)
          .attr('fill', '#059669')
          .text(`(L/D)max ${bestPt.ldRatio.toFixed(1)}`);
      }

      // Drag Polar Curve
      plotArea
        .append('path')
        .datum(aoaSweep)
        .attr(
          'd',
          d3.line<PolarPoint>().x((d) => xScale(Math.min(maxCdVal, d.cd))).y((d) => yScale(d.cl)).curve(d3.curveCatmullRom.alpha(0.5))
        )
        .attr('fill', 'none')
        .attr('stroke', '#D97706')
        .attr('stroke-width', 2.4);

      if (benchmarkDataset && showBenchmarkOverlay) {
        const refPolar = benchmarkDataset.polar.map((p) => {
          const fw = convert2DBenchmarkToFiniteWing(p, telemetry.aspectRatio, telemetry.oswaldEfficiency);
          return { cd: fw.cd3d, cl: fw.cl3d };
        });
        plotArea
          .append('path')
          .datum(refPolar)
          .attr(
            'd',
            d3.line<{ cd: number; cl: number }>().x((d) => xScale(Math.min(maxCdVal, d.cd))).y((d) => yScale(d.cl)).curve(d3.curveMonotoneY)
          )
          .attr('fill', 'none')
          .attr('stroke', '#059669')
          .attr('stroke-width', 1.8)
          .attr('stroke-dasharray', '5 3');
        drawLegend([
          { color: '#D97706', label: 'Polar' },
          { color: '#059669', label: 'NACA 3D', dashed: true },
        ]);
      }

      const opColor = telemetry.isStalled ? '#DC2626' : '#D97706';
      drawOperatingBadge(
        xScale(Math.min(maxCdVal, telemetry.cd)),
        yScale(telemetry.cl),
        opColor,
        `CD ${telemetry.cd.toFixed(3)} · CL ${telemetry.cl.toFixed(2)}`
      );

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).ticks(5).tickFormat((d) => Number(d).toFixed(2)))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yScale).ticks(5).tickFormat((d) => Number(d).toFixed(1)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      svg.append('text').attr('x', 8).attr('y', 14).style('font-family', MONO_FONT).style('font-size', '9px').style('font-weight', 700).attr('fill', '#5C6670').text('CL');
      svg.append('text').attr('x', margin.left + innerW / 2).attr('y', height - 4).attr('text-anchor', 'middle').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670').text('Drag Coefficient CD');

      // Delaunay nearest-point probe along polar
      const delaunay = d3.Delaunay.from(
        aoaSweep,
        (d) => xScale(Math.min(maxCdVal, d.cd)),
        (d) => yScale(d.cl)
      );
      const focus = plotArea.append('circle').attr('r', 5.5).attr('fill', 'none').attr('stroke', '#1769AA').attr('stroke-width', 1.6).attr('opacity', 0);
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx, my] = d3.pointer(event);
          const idx = delaunay.find(mx, my);
          const pt = aoaSweep[idx];
          if (!pt) return;
          focus.attr('cx', xScale(Math.min(maxCdVal, pt.cd))).attr('cy', yScale(pt.cl)).attr('opacity', 1);
          setProbeReadout(`α ${pt.aoa >= 0 ? '+' : ''}${pt.aoa.toFixed(1)}° · CD ${pt.cd.toFixed(4)} · CL ${pt.cl.toFixed(3)} · L/D ${pt.ldRatio.toFixed(1)}:1`);
        })
        .on('mouseleave', () => focus.attr('opacity', 0));
    }

    // =========================================================================
    // TAB 4: CHORDWISE PRESSURE COEFFICIENT Cp(x/c) (INVERTED Y)
    // =========================================================================
    else {
      const xScale = d3.scaleLinear().domain([0, 1]).range([0, innerW]);
      const minCpRaw = d3.min(cpSweep, (d) => Math.min(d.cpUpper, d.cpLower)) ?? -2.5;
      const minCp = Math.min(-3.5, Number((minCpRaw - 0.3).toFixed(1)));
      // Inverted Y-axis: suction (-Cp) at top, compression (+Cp) at bottom
      const yScale = d3.scaleLinear().domain([minCp, 1.2]).range([0, innerH]);

      plotArea
        .selectAll('line.gy')
        .data(yScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      plotArea.append('line').attr('x1', 0).attr('x2', innerW).attr('y1', yScale(0)).attr('y2', yScale(0)).attr('stroke', '#94A3B8').attr('stroke-dasharray', '3 3');

      // Upper & Lower Area Fills
      plotArea
        .append('path')
        .datum(cpSweep)
        .attr(
          'd',
          d3.area<(typeof cpSweep)[number]>().x((d) => xScale(d.xc)).y0(yScale(0)).y1((d) => yScale(d.cpUpper)).curve(d3.curveMonotoneX)
        )
        .attr('fill', 'rgba(23, 105, 170, 0.14)');

      plotArea
        .append('path')
        .datum(cpSweep)
        .attr(
          'd',
          d3.area<(typeof cpSweep)[number]>().x((d) => xScale(d.xc)).y0(yScale(0)).y1((d) => yScale(d.cpLower)).curve(d3.curveMonotoneX)
        )
        .attr('fill', 'rgba(217, 119, 6, 0.12)');

      // Upper & Lower Curves
      plotArea
        .append('path')
        .datum(cpSweep)
        .attr(
          'd',
          d3.line<(typeof cpSweep)[number]>().x((d) => xScale(d.xc)).y((d) => yScale(d.cpUpper)).curve(d3.curveMonotoneX)
        )
        .attr('fill', 'none')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2.4);

      plotArea
        .append('path')
        .datum(cpSweep)
        .attr(
          'd',
          d3.line<(typeof cpSweep)[number]>().x((d) => xScale(d.xc)).y((d) => yScale(d.cpLower)).curve(d3.curveMonotoneX)
        )
        .attr('fill', 'none')
        .attr('stroke', '#D97706')
        .attr('stroke-width', 2.2);

      if (benchmarkCp) {
        plotArea
          .append('path')
          .datum(benchmarkCp)
          .attr(
            'd',
            d3.line<(typeof benchmarkCp)[number]>().x((d) => xScale(d.xc)).y((d) => yScale(d.cpUpper)).curve(d3.curveMonotoneX)
          )
          .attr('fill', 'none')
          .attr('stroke', '#059669')
          .attr('stroke-width', 1.6)
          .attr('stroke-dasharray', '4 3');

        plotArea
          .append('path')
          .datum(benchmarkCp)
          .attr(
            'd',
            d3.line<(typeof benchmarkCp)[number]>().x((d) => xScale(d.xc)).y((d) => yScale(d.cpLower)).curve(d3.curveMonotoneX)
          )
          .attr('fill', 'none')
          .attr('stroke', '#64748B')
          .attr('stroke-width', 1.4)
          .attr('stroke-dasharray', '2 2');

        drawLegend([
          { color: '#1769AA', label: 'Upper' },
          { color: '#D97706', label: 'Lower' },
          { color: '#059669', label: 'XFOIL U', dashed: true },
        ]);
      } else {
        drawLegend([
          { color: '#1769AA', label: 'Upper (-Cp)' },
          { color: '#D97706', label: 'Lower (+Cp)' },
        ]);
      }

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).tickValues([0, 0.25, 0.5, 0.75, 1]).tickFormat((d) => Number(d).toFixed(2)))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yScale).ticks(5).tickFormat((d) => (Number(d) > 0 ? `+${Number(d).toFixed(1)}` : Number(d).toFixed(1))))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9.5px').attr('fill', '#5C6670'));

      svg.append('text').attr('x', 8).attr('y', 14).style('font-family', MONO_FONT).style('font-size', '9px').style('font-weight', 700).attr('fill', '#5C6670').text('Cp');
      svg.append('text').attr('x', margin.left + innerW / 2).attr('y', height - 4).attr('text-anchor', 'middle').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670').text('Chord Position (x/c)');

      const hoverLine = plotArea.append('line').attr('y1', 0).attr('y2', innerH).attr('stroke', '#1769AA').attr('stroke-dasharray', '2 2').attr('opacity', 0);
      const bisect = d3.bisector<(typeof cpSweep)[number], number>((d) => d.xc).center;
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = bisect(cpSweep, xScale.invert(mx));
          const pt = cpSweep[Math.max(0, Math.min(cpSweep.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.xc)).attr('x2', xScale(pt.xc)).attr('opacity', 0.85);
          const dCp = pt.cpLower - pt.cpUpper;
          setProbeReadout(`x/c ${(pt.xc * 100).toFixed(0)}% · Upper Cp ${pt.cpUpper.toFixed(2)} · Lower Cp ${pt.cpLower >= 0 ? '+' : ''}${pt.cpLower.toFixed(2)} · ΔCp ${dCp.toFixed(2)}`);
        })
        .on('mouseleave', () => hoverLine.attr('opacity', 0));
    }
  }, [
    activeTab,
    dims,
    aoaSweep,
    cpSweep,
    benchmarkDataset,
    benchmarkCp,
    showBenchmarkOverlay,
    modelType,
    flapsDeg,
    currentAoa,
    telemetry,
  ]);

  const getBaseName = () => {
    const tabSuffix =
      activeTab === 'lift'
        ? 'lift_curve_cl_alpha'
        : activeTab === 'dragAlpha'
          ? 'drag_curve_cd_alpha'
          : activeTab === 'dragPolar'
            ? 'drag_polar_cl_cd'
            : 'pressure_dist_cp';
    return `aerolab_${modelType}_${tabSuffix}_aoa${currentAoa >= 0 ? '+' : ''}${currentAoa.toFixed(1)}deg`;
  };

  const handleExportSvg = () => {
    if (!svgRef.current) return;
    downloadSvgElement(svgRef.current, getBaseName());
    setChartSuccessMsg('SVG Saved');
    setShowChartExportMenu(false);
    setTimeout(() => setChartSuccessMsg(null), 3000);
  };

  const handleExportPng = async () => {
    if (!svgRef.current) return;
    try {
      await downloadSvgAsPng(svgRef.current, getBaseName(), 2);
      setChartSuccessMsg('PNG Saved');
    } catch (e) {
      console.error(e);
      setChartSuccessMsg('Export Error');
    }
    setShowChartExportMenu(false);
    setTimeout(() => setChartSuccessMsg(null), 3000);
  };

  const handleExportCurveCsv = () => {
    const baseName = getBaseName();
    if (activeTab === 'lift') {
      const points = aoaSweep.map((pt) => ({
        x: pt.aoa,
        y: pt.cl,
        label: pt.isStalled ? 'Stalled' : 'Attached',
      }));
      downloadCurveDataCSV(points, 'Angle of Attack (deg)', 'Lift Coefficient (CL)', baseName);
    } else if (activeTab === 'dragAlpha') {
      const points = aoaSweep.map((pt) => ({
        x: pt.aoa,
        y: pt.cd,
        label: pt.isStalled ? 'Stalled' : 'Attached',
      }));
      downloadCurveDataCSV(points, 'Angle of Attack (deg)', 'Drag Coefficient (CD)', baseName);
    } else if (activeTab === 'dragPolar') {
      const points = aoaSweep.map((pt) => ({
        x: pt.cd,
        y: pt.cl,
        label: `AoA=${pt.aoa.toFixed(1)}deg`,
      }));
      downloadCurveDataCSV(points, 'Drag Coefficient (CD)', 'Lift Coefficient (CL)', baseName);
    } else {
      const points: Array<{ x: number; y: number; label: string }> = [];
      for (const p of cpSweep) {
        points.push({ x: p.xc, y: p.cpUpper, label: 'Upper Suction (-Cp)' });
        points.push({ x: p.xc, y: p.cpLower, label: 'Lower Compression (+Cp)' });
      }
      downloadCurveDataCSV(points, 'Chord Position (x/c)', 'Pressure Coefficient (Cp)', baseName);
    }
    setChartSuccessMsg('Data Saved');
    setShowChartExportMenu(false);
    setTimeout(() => setChartSuccessMsg(null), 3000);
  };

  return (
    <div className="w-full p-3 sm:p-3.5 rounded-xl antigravity-glass flex flex-col gap-2.5">
      {/* Chart Header & Tabs */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#1769AA]/16 to-[#0EA5E9]/14 ring-1 ring-[#1769AA]/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] flex items-center justify-center text-[#1769AA] shrink-0">
              <ChartLineUp weight="duotone" className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-bold text-[#161A1D] tracking-wide uppercase font-sans truncate">
              Aerodynamic Polars
            </span>
            {chartSuccessMsg && (
              <span className="ml-1 text-[10px] font-mono text-emerald-700 flex items-center gap-1 shrink-0">
                <CheckCircle weight="duotone" className="w-3 h-3 text-emerald-600" />
                <span>{chartSuccessMsg}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {benchmarkDataset && (
              <button
                type="button"
                onClick={() => setShowBenchmarkOverlay((v) => !v)}
                className={`px-2 py-0.5 rounded-md border text-[10px] font-mono font-semibold transition-colors cursor-pointer ${
                  showBenchmarkOverlay
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-[var(--bg)] border-[var(--border)] text-[#5C6670] hover:text-[#161A1D]'
                }`}
                title="Toggle Abbott & von Doenhoff / XFOIL wind-tunnel benchmark overlay"
              >
                {showBenchmarkOverlay ? '● NACA Ref' : '○ NACA Ref'}
              </button>
            )}

            {/* Export Chart Dropdown Menu */}
            <div className="relative" ref={chartMenuRef}>
              <button
                type="button"
                onClick={() => setShowChartExportMenu((prev) => !prev)}
                className="px-2 py-0.5 rounded-md bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[10px] font-semibold text-[#161A1D] flex items-center gap-1 transition-colors cursor-pointer"
                title="Export graph as high-res PNG, vector SVG, or raw CSV points"
                aria-expanded={showChartExportMenu}
                aria-haspopup="true"
              >
                <DownloadSimple weight="bold" className="w-3 h-3 text-[#1769AA]" />
                <span>Export</span>
                <CaretDown
                  weight="bold"
                  className={`w-2.5 h-2.5 text-[#5C6670] transition-transform duration-200 ${
                    showChartExportMenu ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {showChartExportMenu && (
                <div className="absolute right-0 top-full mt-1 w-52 max-w-[calc(100vw-2rem)] rounded-xl bg-[var(--surface)] border border-[var(--border)] shadow-xl p-1.5 z-50 flex flex-col gap-1">
                  <div className="px-2 py-1 border-b border-[var(--border)]">
                    <span className="text-[9px] font-mono uppercase tracking-wider text-[#5C6670]">
                      Export Active Graph
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleExportPng}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg)] flex items-center gap-2 text-[#161A1D] transition-colors cursor-pointer"
                  >
                    <FilePng weight="duotone" className="w-4 h-4 text-[#1769AA] shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold text-[#161A1D] flex items-center gap-1">
                        High-Res Image <span className="text-[9px] font-mono text-[#1769AA]">.png</span>
                      </span>
                      <span className="text-[9px] text-[#5C6670]">Crisp 2× raster render</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleExportSvg}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg)] flex items-center gap-2 text-[#161A1D] transition-colors cursor-pointer"
                  >
                    <FileSvg weight="duotone" className="w-4 h-4 text-amber-600 shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold text-[#161A1D] flex items-center gap-1">
                        Vector Graphic <span className="text-[9px] font-mono text-amber-700">.svg</span>
                      </span>
                      <span className="text-[9px] text-[#5C6670]">Lossless scalable vector</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleExportCurveCsv}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg)] flex items-center gap-2 text-[#161A1D] transition-colors cursor-pointer"
                  >
                    <FileCsv weight="duotone" className="w-4 h-4 text-emerald-600 shrink-0" />
                    <div className="flex flex-col">
                      <span className="text-[11px] font-semibold text-[#161A1D] flex items-center gap-1">
                        Curve Points <span className="text-[9px] font-mono text-emerald-700">.csv</span>
                      </span>
                      <span className="text-[9px] text-[#5C6670]">Raw (x, y) plot coordinates</span>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Functional Tabs: Lift (CL-α), Drag (CD-α), Polar (CL-CD), Cp (x/c) */}
        <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
          {(
            [
              { id: 'lift', label: 'CL–α' },
              { id: 'dragAlpha', label: 'CD–α' },
              { id: 'dragPolar', label: 'CL–CD' },
              { id: 'pressure', label: 'Cp (x/c)' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`py-1.5 sm:py-1 text-[10.5px] font-semibold rounded-md text-center transition-colors cursor-pointer ${
                activeTab === t.id
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Interactive D3.js SVG Canvas */}
      <div
        ref={chartContainerRef}
        className="w-full h-[215px] sm:h-[230px] bg-[#F7F9FA] rounded-xl border border-[var(--border)] overflow-hidden"
      >
        <svg ref={svgRef} className="block w-full h-full select-none" />
      </div>

      {/* Live D3 Crosshair Probe */}
      <div className="px-2.5 py-1 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono tabular-nums text-[#5C6670] flex items-center justify-between gap-2">
        <span className="truncate">
          {probeReadout ?? `Hover plot to probe exact ${activeTab === 'pressure' ? 'chord Cp(x/c)' : 'polar curve'} values`}
        </span>
        <span className="text-[#1769AA] font-semibold shrink-0">D3 · SVG</span>
      </div>

      {/* Wind-Tunnel Benchmark Validation Readout */}
      {benchmarkDeviation && (
        <div className="p-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-1 text-[10px] font-mono tabular-nums">
          <div className="flex items-center justify-between gap-2 text-emerald-800 font-semibold">
            <span className="truncate">{benchmarkDeviation.reference}</span>
            <span className="shrink-0">α = {benchmarkDeviation.aoaClampedDeg.toFixed(1)}°</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[#5C6670]">
            <div className="flex justify-between">
              <span>ΔCL (vs 3D Ref):</span>
              <span className="text-[#161A1D] font-semibold">
                {benchmarkDeviation.deltaClVs3dFinite >= 0 ? '+' : ''}
                {benchmarkDeviation.deltaClVs3dFinite.toFixed(3)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>ΔCD (vs 3D Ref):</span>
              <span className="text-[#161A1D] font-semibold">
                {benchmarkDeviation.deltaCdVs3dFinite >= 0 ? '+' : ''}
                {benchmarkDeviation.deltaCdVs3dFinite.toFixed(4)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Attached RMSE(CL):</span>
              <span className="text-[#1769AA] font-semibold">
                {benchmarkDeviation.rmseClAttached.toFixed(3)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Attached RMSE(CD):</span>
              <span className="text-[#1769AA] font-semibold">
                {benchmarkDeviation.rmseCdAttached.toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
