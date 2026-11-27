import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { AircraftModelType, AeroTelemetry } from '../types/aerodynamics';
import {
  AIRCRAFT_MODELS,
  calculateAeroTelemetry,
  computeSectionCpProfile,
  getEffectiveStallAngles,
} from '../utils/airfoilGenerators';
import { computeISA, ISA_CONSTANTS } from '../lib/aeroPhysics';
import { downloadSvgAsPng, downloadSvgElement } from '../utils/telemetryExport';
import {
  Graph,
  DownloadSimple,
  CheckCircle,
} from '@phosphor-icons/react';

interface D3AdvancedGraphsProps {
  modelType: AircraftModelType;
  currentAoa: number;
  airspeedKts: number;
  altitudeFt: number;
  flapsDeg: number;
  telemetry: AeroTelemetry;
  customGlbVersion?: number;
}

type D3GraphTab = 'envelope' | 'dragStack' | 'boundaryLayer' | 'radar';
type EnvelopeMetric = 'ldRatio' | 'cl' | 'qKpa';

interface EnvelopeCell {
  speedKts: number;
  altFt: number;
  mach: number;
  cl: number;
  cd: number;
  ldRatio: number;
  qKpa: number;
  isStalled: boolean;
}

interface DragStackRow {
  aoa: number;
  cd0: number;
  cdi: number;
  cdSep: number;
  cdWave: number;
  cdTotal: number;
  ldRatio: number;
  cl: number;
}

interface RadarAxisDatum {
  axis: string;
  current: number; // [0..1]
  ideal: number; // [0..1]
  rawLabel: string;
}

const MONO_FONT = '"JetBrains Mono", ui-monospace, monospace';

export const D3AdvancedGraphs: React.FC<D3AdvancedGraphsProps> = ({
  modelType,
  currentAoa,
  airspeedKts,
  altitudeFt,
  flapsDeg,
  telemetry,
  customGlbVersion = 0,
}) => {
  const [activeTab, setActiveTab] = useState<D3GraphTab>('envelope');
  const [envelopeMetric, setEnvelopeMetric] = useState<EnvelopeMetric>('ldRatio');
  const [hoverReadout, setHoverReadout] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number }>({
    width: 372,
    height: 240,
  });

  // Track responsive SVG container width cleanly via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const w = Math.max(280, Math.floor(el.clientWidth));
      const h = activeTab === 'radar' ? 248 : 240;
      setDims((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    updateSize();

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => updateSize())
        : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [activeTab]);

  // 1. Flight Envelope 2D Matrix (Airspeed x Altitude)
  const envelopeData = useMemo(() => {
    const speeds = [80, 140, 220, 320, 440, 560, 680, 820, 960, 1120, 1280];
    const altitudes = [0, 5000, 10000, 15000, 20000, 28000, 36000, 44000, 50000];
    const cells: EnvelopeCell[] = [];

    for (const altFt of altitudes) {
      for (const speedKts of speeds) {
        const pt = calculateAeroTelemetry(modelType, currentAoa, speedKts, altFt, flapsDeg);
        cells.push({
          speedKts,
          altFt,
          mach: pt.mach,
          cl: pt.cl,
          cd: pt.cd,
          ldRatio: pt.ldRatio,
          qKpa: pt.dynamic_pressure_pa / 1000,
          isStalled: pt.isStalled,
        });
      }
    }

    // Iso-Mach curves (M = 0.30, 0.70, 1.00) mapped over [0..50000 ft] -> kts
    const isoMachTargets = [0.3, 0.7, 1.0];
    const isoMachCurves = isoMachTargets.map((targetM) => {
      const pts: Array<{ speedKts: number; altFt: number }> = [];
      for (let altFt = 0; altFt <= 50000; altFt += 5000) {
        const altM = Math.min(ISA_CONSTANTS.MAX_ALTITUDE_M, altFt * ISA_CONSTANTS.FT_TO_M);
        const isa = computeISA(altM);
        const speedKts = (targetM * isa.speedOfSound_ms) / ISA_CONSTANTS.KTS_TO_MS;
        pts.push({ speedKts, altFt });
      }
      return { mach: targetM, pts };
    });

    return { speeds, altitudes, cells, isoMachCurves };
  }, [modelType, currentAoa, flapsDeg, customGlbVersion]);

  // 2. Stacked Drag Decomposition across AoA (-20 .. +30 deg)
  const dragSweep = useMemo<DragStackRow[]>(() => {
    const rows: DragStackRow[] = [];
    for (let a = -20; a <= 30.001; a += 1) {
      const aoa = Math.round(a);
      const pt = calculateAeroTelemetry(modelType, aoa, airspeedKts, altitudeFt, flapsDeg);
      rows.push({
        aoa,
        cd0: pt.cd0,
        cdi: pt.cdi,
        cdSep: pt.cdSep,
        cdWave: pt.cdWave,
        cdTotal: pt.cd,
        ldRatio: pt.ldRatio,
        cl: pt.cl,
      });
    }
    return rows;
  }, [modelType, airspeedKts, altitudeFt, flapsDeg, customGlbVersion]);

  // 3. Chordwise Boundary-Layer & Delta Cp Profile
  const cpProfile = useMemo(
    () => computeSectionCpProfile(modelType, currentAoa, airspeedKts, altitudeFt, flapsDeg),
    [modelType, currentAoa, airspeedKts, altitudeFt, flapsDeg, customGlbVersion]
  );

  // 4. 6-Axis Normalized Aerodynamic Calibration Radar
  const radarData = useMemo<RadarAxisDatum[]>(() => {
    const cfg = AIRCRAFT_MODELS[modelType];
    const clNorm = Math.max(0, Math.min(1, Math.abs(telemetry.cl) / Math.max(0.2, cfg.clMax)));
    const ldPeakEst = Math.max(6, Math.max(...dragSweep.map((r) => r.ldRatio), 1));
    const ldNorm = Math.max(0, Math.min(1, telemetry.ldRatio / ldPeakEst));
    const { posStallAngle } = getEffectiveStallAngles(modelType, flapsDeg);
    const stallNorm =
      posStallAngle > 0
        ? Math.max(0, Math.min(1, telemetry.stallMargin / Math.max(4, posStallAngle)))
        : telemetry.isStalled
          ? 0.2
          : 0.85;
    const continuumNorm = Math.max(0, Math.min(1, 1 - telemetry.knudsen / 0.01));
    const kuttaNorm = Math.max(0, Math.min(1, 1 - telemetry.kuttaTeDeltaCp / 0.15));
    const subsonicNorm = Math.max(0, Math.min(1, 1 - Math.max(0, telemetry.mach - 0.3) / 0.9));

    return [
      { axis: 'LIFT CL', current: clNorm, ideal: 0.78, rawLabel: `CL ${telemetry.cl.toFixed(2)}` },
      { axis: 'GLIDE L/D', current: ldNorm, ideal: 0.92, rawLabel: `${telemetry.ldRatio.toFixed(1)}:1` },
      { axis: 'ATTACHED', current: stallNorm, ideal: 0.85, rawLabel: `${telemetry.stallMargin.toFixed(1)}°` },
      { axis: 'CONTINUUM', current: continuumNorm, ideal: 1.0, rawLabel: `Kn ${telemetry.knudsen.toExponential(1)}` },
      { axis: 'KUTTA TE', current: kuttaNorm, ideal: 0.98, rawLabel: `ΔCp ${telemetry.kuttaTeDeltaCp.toFixed(3)}` },
      { axis: 'SUBSONIC', current: subsonicNorm, ideal: 0.9, rawLabel: `M ${telemetry.mach.toFixed(2)}` },
    ];
  }, [modelType, telemetry, dragSweep, flapsDeg]);

  // Clear stale hover readout when switching tabs or models
  useEffect(() => {
    setHoverReadout(null);
  }, [activeTab, modelType]);

  // Render active D3 graph cleanly into SVG
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

    // Clean clinical background rect for exports & crisp rendering
    svg
      .append('rect')
      .attr('class', 'export-bg')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#FFFFFF');

    // =========================================================================
    // TAB 1: FLIGHT ENVELOPE 2D HEATMAP + ISO-MACH CONTOURS
    // =========================================================================
    if (activeTab === 'envelope') {
      const margin = { top: 24, right: 14, bottom: 32, left: 42 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const { speeds, altitudes, cells, isoMachCurves } = envelopeData;

      const xBand = d3
        .scaleBand<number>()
        .domain(speeds)
        .range([0, innerW])
        .paddingInner(0.06);

      const yBand = d3
        .scaleBand<number>()
        .domain(altitudes)
        .range([innerH, 0])
        .paddingInner(0.06);

      const xLinear = d3.scaleLinear().domain([80, 1280]).range([0, innerW]);
      const yLinear = d3.scaleLinear().domain([0, 50000]).range([innerH, 0]);

      const getVal = (c: EnvelopeCell) =>
        envelopeMetric === 'ldRatio'
          ? c.ldRatio
          : envelopeMetric === 'cl'
            ? c.cl
            : c.qKpa;

      const extent = d3.extent(cells, getVal);
      const minV = extent[0] ?? 0;
      const maxV = Math.max(minV + 0.01, extent[1] ?? 1);

      const colorScale =
        envelopeMetric === 'cl'
          ? d3.scaleSequential(d3.interpolateRdYlBu).domain([maxV, minV])
          : d3.scaleSequential(d3.interpolateViridis).domain([minV, maxV]);

      // Legend Bar across Top
      const legendW = Math.min(130, innerW * 0.48);
      const defs = svg.append('defs');
      const gradId = `env-grad-${envelopeMetric}`;
      const linGrad = defs
        .append('linearGradient')
        .attr('id', gradId)
        .attr('x1', '0%')
        .attr('x2', '100%');
      d3.range(0, 1.01, 0.1).forEach((t) => {
        const sampleVal = minV + t * (maxV - minV);
        linGrad
          .append('stop')
          .attr('offset', `${t * 100}%`)
          .attr('stop-color', colorScale(sampleVal));
      });

      const legendG = svg
        .append('g')
        .attr('transform', `translate(${margin.left + innerW - legendW}, 6)`);
      legendG
        .append('rect')
        .attr('width', legendW)
        .attr('height', 6)
        .attr('rx', 2)
        .attr('fill', `url(#${gradId})`)
        .attr('stroke', '#CBD5E1')
        .attr('stroke-width', 0.5);
      legendG
        .append('text')
        .attr('x', -4)
        .attr('y', 6)
        .attr('text-anchor', 'end')
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#475569')
        .text(
          envelopeMetric === 'ldRatio'
            ? `L/D ${minV.toFixed(1)}–${maxV.toFixed(1)}`
            : envelopeMetric === 'cl'
              ? `CL ${minV.toFixed(2)}–${maxV.toFixed(2)}`
              : `q ${minV.toFixed(0)}–${maxV.toFixed(0)}kPa`
        );

      // Heatmap Grid Cells
      g.selectAll('rect.env-cell')
        .data(cells)
        .join('rect')
        .attr('class', 'env-cell')
        .attr('x', (d) => xBand(d.speedKts) ?? 0)
        .attr('y', (d) => yBand(d.altFt) ?? 0)
        .attr('width', xBand.bandwidth())
        .attr('height', yBand.bandwidth())
        .attr('rx', 1.5)
        .attr('fill', (d) => colorScale(getVal(d)))
        .style('cursor', 'crosshair')
        .on('mouseenter', function (_event, d) {
          d3.select(this).attr('stroke', '#FFFFFF').attr('stroke-width', 1.6);
          setHoverReadout(
            `${d.speedKts} kts · ${(d.altFt / 1000).toFixed(0)}k ft · M ${d.mach.toFixed(2)} · CL ${d.cl.toFixed(2)} · L/D ${d.ldRatio.toFixed(1)} · q ${d.qKpa.toFixed(1)} kPa`
          );
        })
        .on('mouseleave', function () {
          d3.select(this).attr('stroke', null);
        });

      // Clip path for Iso-Mach contour lines
      const clipId = 'env-clip';
      defs
        .append('clipPath')
        .attr('id', clipId)
        .append('rect')
        .attr('width', innerW)
        .attr('height', innerH);

      const contourGroup = g.append('g').attr('clip-path', `url(#${clipId})`).attr('pointer-events', 'none');
      const machLine = d3
        .line<{ speedKts: number; altFt: number }>()
        .x((d) => xLinear(d.speedKts))
        .y((d) => yLinear(d.altFt));

      isoMachCurves.forEach(({ mach, pts }) => {
        contourGroup
          .append('path')
          .datum(pts)
          .attr('d', machLine)
          .attr('fill', 'none')
          .attr('stroke', mach >= 1 ? '#F87171' : mach >= 0.7 ? '#FBBF24' : '#E2E8F0')
          .attr('stroke-width', 1.2)
          .attr('stroke-dasharray', mach === 1 ? '4 2' : '3 3')
          .attr('opacity', 0.9);

        const labelPt = pts[Math.floor(pts.length * 0.72)];
        if (labelPt && labelPt.speedKts >= 100 && labelPt.speedKts <= 1220) {
          contourGroup
            .append('text')
            .attr('x', xLinear(labelPt.speedKts) + 3)
            .attr('y', yLinear(labelPt.altFt) - 2)
            .style('font-family', MONO_FONT)
            .style('font-size', '8px')
            .style('font-weight', 700)
            .attr('fill', '#FFFFFF')
            .attr('stroke', 'rgba(15,23,42,0.75)')
            .attr('stroke-width', 2.2)
            .attr('paint-order', 'stroke')
            .text(`M${mach.toFixed(1)}`);
        }
      });

      // Live Operating Point Crosshair Marker
      const opX = Math.max(0, Math.min(innerW, xLinear(airspeedKts)));
      const opY = Math.max(0, Math.min(innerH, yLinear(altitudeFt)));
      const opGroup = g.append('g').attr('pointer-events', 'none');
      opGroup
        .append('line')
        .attr('x1', opX)
        .attr('x2', opX)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 0.9)
        .attr('stroke-dasharray', '2 2')
        .attr('opacity', 0.75);
      opGroup
        .append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', opY)
        .attr('y2', opY)
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 0.9)
        .attr('stroke-dasharray', '2 2')
        .attr('opacity', 0.75);
      opGroup
        .append('circle')
        .attr('cx', opX)
        .attr('cy', opY)
        .attr('r', 4.5)
        .attr('fill', '#EF4444')
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 1.6);

      // Axes
      const xAxis = d3
        .axisBottom(xLinear)
        .tickValues([100, 350, 600, 850, 1100])
        .tickFormat((d) => `${Number(d)}`);
      const yAxis = d3
        .axisLeft(yLinear)
        .tickValues([0, 15000, 30000, 50000])
        .tickFormat((d) => `${Number(d) / 1000}k`);

      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(xAxis)
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('line').attr('stroke', '#CBD5E1'))
        .call((ax) =>
          ax
            .selectAll('text')
            .style('font-family', MONO_FONT)
            .style('font-size', '9px')
            .attr('fill', '#5C6670')
        );

      g.append('g')
        .call(yAxis)
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('line').attr('stroke', '#CBD5E1'))
        .call((ax) =>
          ax
            .selectAll('text')
            .style('font-family', MONO_FONT)
            .style('font-size', '9px')
            .attr('fill', '#5C6670')
        );

      svg
        .append('text')
        .attr('x', margin.left)
        .attr('y', 13)
        .style('font-family', MONO_FONT)
        .style('font-size', '9px')
        .style('font-weight', 700)
        .attr('fill', '#161A1D')
        .text(`α=${currentAoa.toFixed(1)}° Envelope`);

      svg
        .append('text')
        .attr('x', margin.left + innerW / 2)
        .attr('y', height - 4)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#5C6670')
        .text('Airspeed (knots) · Iso-Mach contours');
    }

    // =========================================================================
    // TAB 2: STACKED DRAG DECOMPOSITION + L/D EFFICIENCY OVERLAY
    // =========================================================================
    else if (activeTab === 'dragStack') {
      const margin = { top: 24, right: 38, bottom: 32, left: 42 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const keys = ['cd0', 'cdi', 'cdSep', 'cdWave'] as const;
      const keyColors: Record<(typeof keys)[number], { fill: string; label: string }> = {
        cd0: { fill: 'rgba(100, 116, 139, 0.55)', label: 'CD0' },
        cdi: { fill: 'rgba(23, 105, 170, 0.62)', label: 'CDi' },
        cdSep: { fill: 'rgba(220, 38, 38, 0.62)', label: 'CDsep' },
        cdWave: { fill: 'rgba(245, 158, 11, 0.65)', label: 'CDwave' },
      };

      const stacked = d3.stack<DragStackRow>().keys([...keys])(dragSweep);

      const xScale = d3.scaleLinear().domain([-20, 30]).range([0, innerW]);
      const maxCd = Math.max(0.15, d3.max(dragSweep, (d) => d.cdTotal) ?? 0.4);
      const yCd = d3.scaleLinear().domain([0, maxCd * 1.1]).nice().range([innerH, 0]);

      const maxLd = Math.max(4, d3.max(dragSweep, (d) => d.ldRatio) ?? 10);
      const minLd = Math.min(0, d3.min(dragSweep, (d) => d.ldRatio) ?? 0);
      const yLd = d3.scaleLinear().domain([minLd, maxLd * 1.1]).nice().range([innerH, 0]);

      // Horizontal Gridlines
      g.append('g')
        .selectAll('line.grid-y')
        .data(yCd.ticks(4))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yCd(d))
        .attr('y2', (d) => yCd(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      // Stacked Areas
      const areaGen = d3
        .area<d3.SeriesPoint<DragStackRow>>()
        .x((d) => xScale(d.data.aoa))
        .y0((d) => yCd(d[0]))
        .y1((d) => yCd(d[1]))
        .curve(d3.curveMonotoneX);

      g.selectAll('path.drag-layer')
        .data(stacked)
        .join('path')
        .attr('class', 'drag-layer')
        .attr('d', areaGen)
        .attr('fill', (s) => keyColors[s.key as (typeof keys)[number]].fill)
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 0.4);

      // L/D Efficiency Curve Overlay
      const ldLine = d3
        .line<DragStackRow>()
        .x((d) => xScale(d.aoa))
        .y((d) => yLd(d.ldRatio))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(dragSweep)
        .attr('d', ldLine)
        .attr('fill', 'none')
        .attr('stroke', '#059669')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '5 2.5');

      // Operating AoA Hairline
      const opX = xScale(Math.max(-20, Math.min(30, currentAoa)));
      g.append('line')
        .attr('x1', opX)
        .attr('x2', opX)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#161A1D')
        .attr('stroke-width', 1.3)
        .attr('stroke-dasharray', '2 2');

      g.append('circle')
        .attr('cx', opX)
        .attr('cy', yCd(telemetry.cd))
        .attr('r', 4)
        .attr('fill', '#1769AA')
        .attr('stroke', '#FFFFFF')
        .attr('stroke-width', 1.5);

      // Legend across Top
      const legendItems: Array<{ color: string; label: string }> = [
        { color: '#64748B', label: 'CD0' },
        { color: '#1769AA', label: 'CDi' },
        { color: '#DC2626', label: 'CDsep' },
        { color: '#F59E0B', label: 'CDwave' },
        { color: '#059669', label: 'L/D' },
      ];
      let lx = margin.left;
      legendItems.forEach((item) => {
        svg
          .append('rect')
          .attr('x', lx)
          .attr('y', 7)
          .attr('width', 8)
          .attr('height', 6)
          .attr('rx', 1.5)
          .attr('fill', item.color);
        svg
          .append('text')
          .attr('x', lx + 11)
          .attr('y', 13)
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .attr('fill', '#475569')
          .text(item.label);
        lx += item.label.length * 6 + 22;
      });

      // Axes
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).ticks(5).tickFormat((d) => `${d}°`))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yCd).ticks(4).tickFormat((d) => Number(d).toFixed(2)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      g.append('g')
        .attr('transform', `translate(${innerW},0)`)
        .call(d3.axisRight(yLd).ticks(4).tickFormat((d) => Number(d).toFixed(0)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#059669'));

      svg
        .append('text')
        .attr('x', margin.left + innerW / 2)
        .attr('y', height - 4)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#5C6670')
        .text('Angle of Attack α (°) · Stacked CD components & L/D');

      // Interactive Hover Bisector Crosshair
      const hoverLine = g
        .append('line')
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 1)
        .attr('opacity', 0);

      const bisect = d3.bisector<DragStackRow, number>((d) => d.aoa).center;
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', function (event) {
          const [mx] = d3.pointer(event);
          const xVal = xScale.invert(mx);
          const idx = bisect(dragSweep, xVal);
          const pt = dragSweep[Math.max(0, Math.min(dragSweep.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.aoa)).attr('x2', xScale(pt.aoa)).attr('opacity', 0.85);
          setHoverReadout(
            `α ${pt.aoa >= 0 ? '+' : ''}${pt.aoa}° · CD ${pt.cdTotal.toFixed(4)} (0:${pt.cd0.toFixed(3)} i:${pt.cdi.toFixed(3)} s:${pt.cdSep.toFixed(3)} w:${pt.cdWave.toFixed(3)}) · L/D ${pt.ldRatio.toFixed(1)}`
          );
        })
        .on('mouseleave', () => {
          hoverLine.attr('opacity', 0);
        });
    }

    // =========================================================================
    // TAB 3: BOUNDARY-LAYER Cf(x/c) & DELTA Cp CHORDWISE MULTI-LAYER
    // =========================================================================
    else if (activeTab === 'boundaryLayer') {
      const margin = { top: 24, right: 38, bottom: 32, left: 46 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;

      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const rows = cpProfile.map((p) => ({
        xc: p.xc,
        cfUpper: p.cfUpper * 1000, // scale x10^3 for clean axis legibility
        cfLower: p.cfLower * 1000,
        deltaCp: p.cpLower - p.cpUpper,
      }));

      const xScale = d3.scaleLinear().domain([0, 1]).range([0, innerW]);
      const maxCf = Math.max(1.5, d3.max(rows, (r) => Math.max(r.cfUpper, r.cfLower)) ?? 6);
      const yCf = d3.scaleLinear().domain([0, maxCf * 1.15]).nice().range([innerH, 0]);

      const minDcp = Math.min(-0.5, d3.min(rows, (r) => r.deltaCp) ?? -0.5);
      const maxDcp = Math.max(1.0, d3.max(rows, (r) => r.deltaCp) ?? 2.5);
      const yDcp = d3.scaleLinear().domain([minDcp, maxDcp * 1.1]).nice().range([innerH, 0]);

      // Horizontal gridlines
      g.append('g')
        .selectAll('line')
        .data(yCf.ticks(4))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yCf(d))
        .attr('y2', (d) => yCf(d))
        .attr('stroke', '#E2E8F0')
        .attr('stroke-dasharray', '3 3');

      // ΔCp Loading Area Ribbon (Right Axis)
      const dcpArea = d3
        .area<(typeof rows)[number]>()
        .x((d) => xScale(d.xc))
        .y0(yDcp(0))
        .y1((d) => yDcp(d.deltaCp))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(rows)
        .attr('d', dcpArea)
        .attr('fill', 'rgba(14, 165, 233, 0.14)')
        .attr('stroke', 'rgba(14, 165, 233, 0.65)')
        .attr('stroke-width', 1.2)
        .attr('stroke-dasharray', '4 2');

      // Upper & Lower Skin-Friction Lines (Left Axis)
      const lineCfUpper = d3
        .line<(typeof rows)[number]>()
        .x((d) => xScale(d.xc))
        .y((d) => yCf(d.cfUpper))
        .curve(d3.curveMonotoneX);

      const lineCfLower = d3
        .line<(typeof rows)[number]>()
        .x((d) => xScale(d.xc))
        .y((d) => yCf(d.cfLower))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(rows)
        .attr('d', lineCfUpper)
        .attr('fill', 'none')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2.2);

      g.append('path')
        .datum(rows)
        .attr('d', lineCfLower)
        .attr('fill', 'none')
        .attr('stroke', '#D97706')
        .attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '3 2');

      // Empirical Transition & Separation Hairline Markers
      const markers: Array<{ xc: number; label: string; color: string }> = [
        { xc: telemetry.xTransitionUpper, label: `Tr ${(telemetry.xTransitionUpper * 100).toFixed(0)}%`, color: '#059669' },
      ];
      if (telemetry.xSeparationUpper < 0.97) {
        markers.push({
          xc: telemetry.xSeparationUpper,
          label: `Sep ${(telemetry.xSeparationUpper * 100).toFixed(0)}%`,
          color: '#DC2626',
        });
      }

      markers.forEach((m, idx) => {
        const mx = xScale(Math.max(0, Math.min(1, m.xc)));
        g.append('line')
          .attr('x1', mx)
          .attr('x2', mx)
          .attr('y1', 0)
          .attr('y2', innerH)
          .attr('stroke', m.color)
          .attr('stroke-width', 1.2)
          .attr('stroke-dasharray', '3 2');
        g.append('text')
          .attr('x', mx + (m.xc > 0.78 ? -3 : 3))
          .attr('y', 11 + idx * 11)
          .attr('text-anchor', m.xc > 0.78 ? 'end' : 'start')
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .style('font-weight', 700)
          .attr('fill', m.color)
          .text(m.label);
      });

      // Top Legend
      const legendItems = [
        { color: '#1769AA', label: 'Cf,u (×10⁻³)' },
        { color: '#D97706', label: 'Cf,l (×10⁻³)' },
        { color: '#0EA5E9', label: 'ΔCp Loading' },
      ];
      let lx = margin.left;
      legendItems.forEach((it) => {
        svg.append('rect').attr('x', lx).attr('y', 7).attr('width', 8).attr('height', 6).attr('rx', 1.5).attr('fill', it.color);
        svg
          .append('text')
          .attr('x', lx + 11)
          .attr('y', 13)
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .attr('fill', '#475569')
          .text(it.label);
        lx += it.label.length * 5.6 + 22;
      });

      // Axes
      g.append('g')
        .attr('transform', `translate(0,${innerH})`)
        .call(d3.axisBottom(xScale).ticks(5).tickFormat((d) => `${(Number(d) * 100).toFixed(0)}%`))
        .call((ax) => ax.select('.domain').attr('stroke', '#CBD5E1'))
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#5C6670'));

      g.append('g')
        .call(d3.axisLeft(yCf).ticks(4).tickFormat((d) => Number(d).toFixed(1)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#1769AA'));

      g.append('g')
        .attr('transform', `translate(${innerW},0)`)
        .call(d3.axisRight(yDcp).ticks(4).tickFormat((d) => Number(d).toFixed(1)))
        .call((ax) => ax.select('.domain').remove())
        .call((ax) => ax.selectAll('text').style('font-family', MONO_FONT).style('font-size', '9px').attr('fill', '#0284C7'));

      svg
        .append('text')
        .attr('x', margin.left + innerW / 2)
        .attr('y', height - 4)
        .attr('text-anchor', 'middle')
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#5C6670')
        .text('Chord Station (x/c) · Empirical Cf & ΔCp Loading');

      // Interactive Hover Bisector
      const hoverLine = g
        .append('line')
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 1)
        .attr('opacity', 0);

      const bisect = d3.bisector<(typeof rows)[number], number>((d) => d.xc).center;
      g.append('rect')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event) => {
          const [mx] = d3.pointer(event);
          const idx = bisect(rows, xScale.invert(mx));
          const pt = rows[Math.max(0, Math.min(rows.length - 1, idx))];
          if (!pt) return;
          hoverLine.attr('x1', xScale(pt.xc)).attr('x2', xScale(pt.xc)).attr('opacity', 0.85);
          setHoverReadout(
            `x/c ${(pt.xc * 100).toFixed(0)}% · Cf,u ${(pt.cfUpper * 1e-3).toExponential(2)} · Cf,l ${(pt.cfLower * 1e-3).toExponential(2)} · ΔCp ${pt.deltaCp.toFixed(2)}`
          );
        })
        .on('mouseleave', () => hoverLine.attr('opacity', 0));
    }

    // =========================================================================
    // TAB 4: 6-AXIS AERODYNAMIC PERFORMANCE CALIBRATION RADAR (D3 lineRadial)
    // =========================================================================
    else {
      const cx = width / 2;
      const cy = height / 2 + 4;
      const maxR = Math.min(width, height) * 0.34;
      const nAxes = radarData.length;
      const angleSlice = (Math.PI * 2) / nAxes;

      const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

      // Legend at Top-Left
      svg
        .append('rect')
        .attr('x', 12)
        .attr('y', 8)
        .attr('width', 8)
        .attr('height', 6)
        .attr('rx', 1.5)
        .attr('fill', '#1769AA');
      svg
        .append('text')
        .attr('x', 23)
        .attr('y', 14)
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#161A1D')
        .text('Current State');

      svg
        .append('rect')
        .attr('x', 102)
        .attr('y', 8)
        .attr('width', 8)
        .attr('height', 6)
        .attr('rx', 1.5)
        .attr('fill', '#059669');
      svg
        .append('text')
        .attr('x', 113)
        .attr('y', 14)
        .style('font-family', MONO_FONT)
        .style('font-size', '8.5px')
        .attr('fill', '#475569')
        .text('Ideal Envelope');

      const rScale = d3.scaleLinear().domain([0, 1]).range([0, maxR]);

      // Concentric Polygonal Grid Rings (25%, 50%, 75%, 100%)
      const radialPoly = d3
        .lineRadial<number>()
        .angle((_d, i) => i * angleSlice)
        .radius((d) => rScale(d))
        .curve(d3.curveLinearClosed);

      [0.25, 0.5, 0.75, 1.0].forEach((level) => {
        const ringPts = d3.range(nAxes).map(() => level);
        g.append('path')
          .datum(ringPts)
          .attr('d', radialPoly)
          .attr('fill', level === 1 ? 'rgba(241, 245, 249, 0.55)' : 'none')
          .attr('stroke', '#CBD5E1')
          .attr('stroke-width', level === 1 ? 1.1 : 0.75)
          .attr('stroke-dasharray', level < 1 ? '2 2' : 'none');

        g.append('text')
          .attr('x', 3)
          .attr('y', -rScale(level) + 3)
          .style('font-family', MONO_FONT)
          .style('font-size', '7.5px')
          .attr('fill', '#94A3B8')
          .text(`${Math.round(level * 100)}%`);
      });

      // Axis Spokes & Labels
      radarData.forEach((d, i) => {
        const ang = i * angleSlice - Math.PI / 2;
        const xEnd = Math.cos(ang) * maxR;
        const yEnd = Math.sin(ang) * maxR;

        g.append('line')
          .attr('x1', 0)
          .attr('y1', 0)
          .attr('x2', xEnd)
          .attr('y2', yEnd)
          .attr('stroke', '#CBD5E1')
          .attr('stroke-width', 0.9);

        const lx = Math.cos(ang) * (maxR + 15);
        const ly = Math.sin(ang) * (maxR + 13);
        const anchor =
          Math.abs(Math.cos(ang)) < 0.25
            ? 'middle'
            : Math.cos(ang) > 0
              ? 'start'
              : 'end';

        g.append('text')
          .attr('x', lx)
          .attr('y', ly + 3)
          .attr('text-anchor', anchor)
          .style('font-family', MONO_FONT)
          .style('font-size', '8.5px')
          .style('font-weight', 700)
          .attr('fill', '#334155')
          .text(d.axis);
      });

      // Reference Polygon (Ideal Envelope)
      g.append('path')
        .datum(radarData.map((d) => d.ideal))
        .attr('d', radialPoly)
        .attr('fill', 'rgba(5, 150, 105, 0.08)')
        .attr('stroke', '#059669')
        .attr('stroke-width', 1.4)
        .attr('stroke-dasharray', '4 2.5');

      // Current Operating State Polygon
      g.append('path')
        .datum(radarData.map((d) => d.current))
        .attr('d', radialPoly)
        .attr('fill', 'rgba(23, 105, 170, 0.22)')
        .attr('stroke', '#1769AA')
        .attr('stroke-width', 2);

      // Interactive Vertex Nodes
      radarData.forEach((d, i) => {
        const ang = i * angleSlice - Math.PI / 2;
        const vx = Math.cos(ang) * rScale(d.current);
        const vy = Math.sin(ang) * rScale(d.current);

        g.append('circle')
          .attr('cx', vx)
          .attr('cy', vy)
          .attr('r', 4)
          .attr('fill', '#1769AA')
          .attr('stroke', '#FFFFFF')
          .attr('stroke-width', 1.5)
          .style('cursor', 'pointer')
          .on('mouseenter', function () {
            d3.select(this).attr('r', 5.8).attr('fill', '#0284C7');
            setHoverReadout(
              `${d.axis}: ${(d.current * 100).toFixed(0)}% score (${d.rawLabel}) · Ref ${(d.ideal * 100).toFixed(0)}%`
            );
          })
          .on('mouseleave', function () {
            d3.select(this).attr('r', 4).attr('fill', '#1769AA');
          });
      });
    }
  }, [
    activeTab,
    envelopeMetric,
    dims,
    envelopeData,
    dragSweep,
    cpProfile,
    radarData,
    currentAoa,
    airspeedKts,
    altitudeFt,
    telemetry,
  ]);

  const exportBase = `aeromatrix_d3_${modelType}_${activeTab}_aoa${currentAoa.toFixed(1)}deg`;

  return (
    <div className="w-full p-3 sm:p-3.5 rounded-xl antigravity-glass flex flex-col gap-2.5">
      {/* Header Row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-[#1769AA]/12 border border-[#1769AA]/25 flex items-center justify-center text-[#1769AA] shrink-0">
            <Graph weight="duotone" className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <span className="text-xs font-bold text-[#161A1D] tracking-wide uppercase font-sans block truncate">
              Telemetry
            </span>
          </div>
          {exportMsg && (
            <span className="text-[10px] font-mono text-emerald-700 flex items-center gap-1 shrink-0">
              <CheckCircle weight="duotone" className="w-3 h-3" />
              <span>{exportMsg}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={async () => {
              if (!svgRef.current) return;
              await downloadSvgAsPng(svgRef.current, exportBase, 2);
              setExportMsg('PNG Saved');
              setTimeout(() => setExportMsg(null), 2500);
            }}
            className="px-2 py-0.5 rounded-md bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[10px] font-semibold text-[#161A1D] flex items-center gap-1 transition-colors cursor-pointer"
            title="Download D3 Graph PNG"
          >
            <DownloadSimple weight="bold" className="w-3 h-3 text-[#1769AA]" />
            <span>PNG</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (!svgRef.current) return;
              downloadSvgElement(svgRef.current, exportBase);
              setExportMsg('SVG Saved');
              setTimeout(() => setExportMsg(null), 2500);
            }}
            className="px-2 py-0.5 rounded-md bg-[var(--bg)] border border-[var(--border)] hover:border-[#1769AA] text-[10px] font-semibold text-[#161A1D] transition-colors cursor-pointer"
            title="Download D3 Vector SVG"
          >
            SVG
          </button>
        </div>
      </div>

      {/* 4 Advanced Graph Tabs */}
      <div className="grid grid-cols-4 gap-1 p-1 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
        {(
          [
            { id: 'envelope', label: 'Envelope' },
            { id: 'dragStack', label: 'Drag Stack' },
            { id: 'boundaryLayer', label: 'BL & Cf(x)' },
            { id: 'radar', label: 'Perf Radar' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`py-1.5 sm:py-1 px-1 text-[10px] font-semibold rounded-md text-center whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === t.id
                ? 'bg-[#1769AA] text-white'
                : 'text-[#5C6670] hover:text-[#161A1D]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Sub-selector for Envelope Scalar Field */}
      {activeTab === 'envelope' && (
        <div className="flex items-center justify-between gap-2 text-[10px]">
          <span className="font-mono text-[#5C6670]">Color Field:</span>
          <div className="flex items-center gap-1 p-0.5 rounded-md bg-[var(--bg)] border border-[var(--border)]">
            {(
              [
                { id: 'ldRatio', label: 'L/D' },
                { id: 'cl', label: 'CL' },
                { id: 'qKpa', label: 'q∞ kPa' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setEnvelopeMetric(m.id)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold transition-colors cursor-pointer ${
                  envelopeMetric === m.id
                    ? 'bg-[#1769AA] text-white'
                    : 'text-[#5C6670] hover:text-[#161A1D]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Responsive D3 SVG Canvas */}
      <div
        ref={containerRef}
        className="w-full rounded-xl border border-[var(--border)] bg-white overflow-hidden"
      >
        <svg ref={svgRef} className="block w-full h-auto select-none" />
      </div>

      {/* Live D3 Crosshair Probe HUD */}
      <div className="px-2.5 py-1.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[10px] font-mono tabular-nums text-[#5C6670] min-h-[26px] flex items-center justify-between gap-2">
        <span className="truncate">
          {hoverReadout ??
            (activeTab === 'envelope'
              ? `Crosshair: ${airspeedKts} kts · ${(altitudeFt / 1000).toFixed(1)}k ft · M ${telemetry.mach.toFixed(2)}`
              : activeTab === 'dragStack'
                ? `Hover chart to inspect α-by-α CD breakdown & L/D`
                : activeTab === 'boundaryLayer'
                  ? `Hover chord x/c to probe Cf(x) & ΔCp(x)`
                  : `Hover radar nodes to inspect normalized telemetry`)}
        </span>
        <span className="text-[#1769AA] font-semibold shrink-0">D3 · SVG</span>
      </div>
    </div>
  );
};
