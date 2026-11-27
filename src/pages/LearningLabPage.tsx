import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as d3 from 'd3';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenText,
  CheckCircle,
  CompassRose,
  Gauge,
  GraduationCap,
  Play,
  WarningCircle,
  Wind,
  XCircle,
} from '@phosphor-icons/react';
import {
  computeChordwiseCpAndLift,
  computeDimensionlessAndGuardrails,
  computeFiniteWingAerodynamics,
  computeFlatPlateSkinFriction,
  computeISA,
  computeSeparationOnset,
  ISA_CONSTANTS,
  SOLVER_LABEL_3D,
} from '../lib/aeroPhysics';
import {
  AIRCRAFT_MODELS,
  computeBenchmarkMatchConditions,
} from '../utils/airfoilGenerators';
import {
  convert2DBenchmarkToFiniteWing,
  getBenchmarkCpStations,
  NACA_BENCHMARKS,
} from '../data/nacaBenchmarks';
import { AircraftModelType } from '../types/aerodynamics';

type LearningModuleId = 'atmosphere' | 'cp-stall' | 'lifting-line' | 'boundary-quiz';

interface LearningLabPageProps {
  onApplyToWorkstation?: (preset: {
    modelType: AircraftModelType;
    aoaDeg: number;
    airspeedKts: number;
    altitudeFt: number;
    flapsDeg: number;
  }) => void;
}

interface QuizQuestion {
  id: string;
  topic: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1-isa',
    topic: 'ISA & Viscosity',
    prompt:
      'Climbing from Sea Level (0 m) to the Tropopause (11,000 m) at constant true airspeed V∞ and chord c, what happens to Reynolds number Re = ρ·V∞·c / μ?',
    options: [
      'Re decreases sharply because density ρ drops ~70% while viscosity μ drops only ~20%',
      'Re stays constant because temperature and pressure cancel out in Sutherland’s Law',
      'Re increases because the speed of sound decreases in colder air',
      'Re doubles because the stratosphere becomes isothermal above 11 km',
    ],
    correctIndex: 0,
    explanation:
      'At 11,000 m, ISA density drops from 1.225 to 0.364 kg/m³ (0.297×), whereas Sutherland dynamic viscosity only drops from 1.789×10⁻⁵ to 1.422×10⁻⁵ Pa·s (0.795×). Thus Re drops to ~37% of its sea-level value at constant V∞.',
  },
  {
    id: 'q2-pg',
    topic: 'Prandtl–Glauert Correction',
    prompt:
      'For an airfoil at M∞ = 0.60 with an incompressible suction peak Cp,0 = −1.60, what does the Prandtl–Glauert subsonic correction Cp,corr = Cp,0 / √(1 − M∞²) predict?',
    options: [
      'Cp,corr = −1.28 (suction softens due to compressibility)',
      'Cp,corr = −2.00 (suction intensifies by factor 1 / 0.80 = 1.25)',
      'Cp,corr = −1.60 (no compressibility effect below M = 0.70)',
      'Cp,corr = −4.44 (supersonic Ackeret scaling applies)',
    ],
    correctIndex: 1,
    explanation:
      'At M∞ = 0.60, β = √(1 − 0.60²) = √0.64 = 0.80, so β⁻¹ = 1.25. Multiplying −1.60 × 1.25 gives Cp,corr = −2.00. Above M = 0.30, incompressible Bernoulli underpredicts pressure magnitudes.',
  },
  {
    id: 'q3-lifting-line',
    topic: 'Prandtl Lifting-Line',
    prompt:
      'If a finite wing with Aspect Ratio AR = 8 and Oswald efficiency e = 0.80 generates CL = 0.80, what are its induced angle αi and far-wake Trefftz downwash ε = 2αi?',
    options: [
      'αi ≈ 0.0398 rad (2.28°), ε ≈ 4.56°, CDi ≈ 0.0318',
      'αi ≈ 0.0199 rad (1.14°), ε ≈ 1.14°, CDi ≈ 0.0159',
      'αi ≈ 0.0796 rad (4.56°), ε ≈ 2.28°, CDi ≈ 0.0637',
      'αi = 0° because downwash only occurs on cambered airfoils',
    ],
    correctIndex: 0,
    explanation:
      'αi = CL / (π·e·AR) = 0.80 / (π × 0.80 × 8) = 1 / (8π) ≈ 0.03979 rad = 2.28°. In the far Trefftz wake, downwash doubles to ε = 2αi ≈ 4.56°, and CDi = CL² / (π·e·AR) = 0.64 / (6.4π) ≈ 0.0318.',
  },
  {
    id: 'q4-cf',
    topic: 'Flat-Plate Skin Friction',
    prompt:
      'How does the plate-averaged laminar Blasius skin-friction coefficient Cf̄ relate to the trailing-edge local skin-friction coefficient Cf(x = c) at the same Reynolds number Re?',
    options: [
      'They are equal: Cf̄ = Cf(c) = 0.664 / √Re',
      'Plate-averaged Cf̄ is exactly twice the trailing-edge local value: Cf̄ = 1.328 / √Re',
      'Local Cf(c) is larger than Cf̄ because the boundary layer thickens downstream',
      'Both scale as Re⁻⁰·² just like turbulent Schlichting flow',
    ],
    correctIndex: 1,
    explanation:
      'Integrating Cf,x = 0.664 / √Re_x from x/c = 0 to 1 gives ∫₀¹ x⁻¹/² dx = 2, so the plate-averaged Blasius coefficient is Cf̄ = 2 × 0.664 / √Re = 1.328 / √Re.',
  },
  {
    id: 'q5-kutta',
    topic: 'Circulation & Solver Scope',
    prompt:
      'Why is plugging Γ_eq = ½·V∞·c·CL into L = ρ·V∞·Γ_eq·b NOT an independent verification of a CFD lift solver?',
    options: [
      'Because Kutta–Joukowski only holds for supersonic delta wings',
      'Because substituting Γ_eq = ½·V∞·c·CL into ρ·V∞·Γ_eq·b algebraically simplifies back to ½·ρ·V∞²·S·CL (a tautology)',
      'Because dynamic pressure uses viscosity μ instead of air density ρ',
      'Because Γ_eq already includes induced drag CDi',
    ],
    correctIndex: 1,
    explanation:
      'With S = b·c and q∞ = ½·ρ·V∞², L = ρ·V∞·(½·V∞·c·CL)·b = q∞·S·CL identically. An independent circulation check requires solving vortex panel strengths (e.g. Biot–Savart / vortex-lattice) from geometry and boundary conditions.',
  },
];

const D3_MONO_FONT = '"JetBrains Mono", ui-monospace, monospace';

interface D3LineSeries {
  name: string;
  color: string;
  data: Array<[number, number]>;
  yAxisIndex?: 0 | 1;
  width?: number;
  dashed?: 'dashed' | 'dotted';
  smooth?: boolean;
  showDots?: 'circle' | 'diamond';
}

interface D3ScatterMarker {
  name: string;
  color: string;
  x: number;
  y: number;
  yAxisIndex?: 0 | 1;
  radius?: number;
}

interface D3LearningChartSpec {
  heightPx: number;
  xDomain: [number, number];
  xLabel: string;
  xTicks?: number;
  xFormat?: (v: number) => string;
  yDomain: [number, number];
  yLabel: string;
  yLabelColor?: string;
  yInvert?: boolean;
  y2Domain?: [number, number];
  y2Label?: string;
  y2LabelColor?: string;
  verticalRefLine?: { x: number; label: string };
  series: D3LineSeries[];
  markers?: D3ScatterMarker[];
  formatProbe: (xVal: number) => string;
}

function D3LearningChart({ spec, ariaLabel }: { spec: D3LearningChartSpec; ariaLabel: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [probe, setProbe] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const sync = () => {
      const w = Math.max(280, Math.floor(el.clientWidth));
      setWidth((prev) => (prev === w ? prev : w));
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  useEffect(() => {
    setProbe(null);
  }, [ariaLabel]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const height = spec.heightPx;
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
      .attr('fill', '#FFFFFF');

    const hasY2 = Boolean(spec.y2Domain);
    const margin = {
      top: 28,
      right: hasY2 ? 54 : 18,
      bottom: 38,
      left: 52,
    };
    const innerW = Math.max(120, width - margin.left - margin.right);
    const innerH = Math.max(80, height - margin.top - margin.bottom);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain(spec.xDomain).range([0, innerW]);
    const y0 = d3
      .scaleLinear()
      .domain(spec.yDomain)
      .range(spec.yInvert ? [0, innerH] : [innerH, 0]);
    const y1 = spec.y2Domain
      ? d3.scaleLinear().domain(spec.y2Domain).range([innerH, 0])
      : null;

    // Legend strip in top-right header area
    let lx = width - margin.right;
    for (let i = spec.series.length - 1; i >= 0; i--) {
      const s = spec.series[i];
      const itemW = s.name.length * 5.7 + 22;
      lx -= itemW;
      if (lx < margin.left) break;
      const lg = svg.append('g').attr('transform', `translate(${lx}, 9)`);
      lg.append('line')
        .attr('x1', 0)
        .attr('x2', 12)
        .attr('y1', 5)
        .attr('y2', 5)
        .attr('stroke', s.color)
        .attr('stroke-width', s.width ?? 2)
        .attr('stroke-dasharray', s.dashed === 'dashed' ? '5 3' : s.dashed === 'dotted' ? '2 3' : 'none');
      lg.append('text')
        .attr('x', 16)
        .attr('y', 8)
        .style('font-family', D3_MONO_FONT)
        .style('font-size', '9.5px')
        .attr('fill', '#5C6670')
        .text(s.name);
    }

    // Dashed hairline gridlines
    g.append('g')
      .call(d3.axisLeft(y0).ticks(5).tickSize(-innerW).tickFormat(() => ''))
      .call((sel) => sel.select('.domain').remove())
      .call((sel) =>
        sel
          .selectAll('line')
          .attr('stroke', '#E2E8F0')
          .attr('stroke-dasharray', '3 3')
      );

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(spec.xTicks ?? 5).tickSize(-innerH).tickFormat(() => ''))
      .call((sel) => sel.select('.domain').remove())
      .call((sel) =>
        sel
          .selectAll('line')
          .attr('stroke', '#E2E8F0')
          .attr('stroke-dasharray', '3 3')
      );

    // Zero reference hairlines
    if (spec.yDomain[0] <= 0 && spec.yDomain[1] >= 0) {
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', y0(0))
        .attr('y2', y0(0))
        .attr('stroke', '#CBD5E1')
        .attr('stroke-width', 1);
    }
    if (spec.xDomain[0] <= 0 && spec.xDomain[1] >= 0) {
      g.append('line')
        .attr('x1', x(0))
        .attr('x2', x(0))
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#CBD5E1')
        .attr('stroke-width', 1);
    }

    // Vertical reference line (e.g., Tropopause 11 km)
    if (spec.verticalRefLine) {
      const rx = x(spec.verticalRefLine.x);
      g.append('line')
        .attr('x1', rx)
        .attr('x2', rx)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#64748B')
        .attr('stroke-width', 1.2)
        .attr('stroke-dasharray', '4 3');
      g.append('text')
        .attr('x', rx + 5)
        .attr('y', 12)
        .style('font-family', D3_MONO_FONT)
        .style('font-size', '9.5px')
        .attr('fill', '#475569')
        .text(spec.verticalRefLine.label);
    }

    const defs = svg.append('defs');
    const clipId = `learn-clip-${ariaLabel.replace(/\W+/g, '-').toLowerCase()}`;
    defs
      .append('clipPath')
      .attr('id', clipId)
      .append('rect')
      .attr('width', innerW)
      .attr('height', innerH);
    const plotArea = g.append('g').attr('clip-path', `url(#${clipId})`);

    const diamondGen = d3.symbol().type(d3.symbolDiamond).size(26);

    for (const s of spec.series) {
      const yScale = s.yAxisIndex === 1 && y1 ? y1 : y0;
      const lineGen = d3
        .line<[number, number]>()
        .x((d) => x(d[0]))
        .y((d) => yScale(d[1]));
      if (s.smooth) {
        lineGen.curve(d3.curveMonotoneX);
      }
      plotArea
        .append('path')
        .datum(s.data)
        .attr('d', lineGen)
        .attr('fill', 'none')
        .attr('stroke', s.color)
        .attr('stroke-width', s.width ?? 2.2)
        .attr(
          'stroke-dasharray',
          s.dashed === 'dashed' ? '5 3' : s.dashed === 'dotted' ? '2 3' : 'none'
        );

      if (s.showDots === 'circle') {
        plotArea
          .selectAll(null)
          .data(s.data)
          .join('circle')
          .attr('cx', (d) => x(d[0]))
          .attr('cy', (d) => yScale(d[1]))
          .attr('r', 2.8)
          .attr('fill', s.color);
      } else if (s.showDots === 'diamond') {
        plotArea
          .selectAll(null)
          .data(s.data)
          .join('path')
          .attr('d', diamondGen)
          .attr('transform', (d) => `translate(${x(d[0])},${yScale(d[1])})`)
          .attr('fill', s.color);
      }
    }

    if (spec.markers) {
      for (const m of spec.markers) {
        const yScale = m.yAxisIndex === 1 && y1 ? y1 : y0;
        plotArea
          .append('circle')
          .attr('cx', x(m.x))
          .attr('cy', yScale(m.y))
          .attr('r', m.radius ?? 5)
          .attr('fill', m.color)
          .attr('stroke', '#FFFFFF')
          .attr('stroke-width', 2);
      }
    }

    // X Axis + Label
    const xAxis = d3.axisBottom(x).ticks(spec.xTicks ?? 5);
    if (spec.xFormat) {
      xAxis.tickFormat((v) => spec.xFormat!(Number(v)));
    }
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .call((sel) => sel.select('.domain').attr('stroke', '#CBD5E1'))
      .call((sel) => sel.selectAll('line').attr('stroke', '#CBD5E1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .style('font-family', D3_MONO_FONT)
          .style('font-size', '10px')
          .attr('fill', '#5C6670')
      );

    g.append('text')
      .attr('x', innerW / 2)
      .attr('y', innerH + 30)
      .attr('text-anchor', 'middle')
      .style('font-family', D3_MONO_FONT)
      .style('font-size', '10.5px')
      .attr('fill', '#5C6670')
      .text(spec.xLabel);

    // Left Y Axis + Label
    g.append('g')
      .call(d3.axisLeft(y0).ticks(5))
      .call((sel) => sel.select('.domain').attr('stroke', '#CBD5E1'))
      .call((sel) => sel.selectAll('line').attr('stroke', '#CBD5E1'))
      .call((sel) =>
        sel
          .selectAll('text')
          .style('font-family', D3_MONO_FONT)
          .style('font-size', '10px')
          .attr('fill', '#5C6670')
      );

    g.append('text')
      .attr('x', -margin.left + 8)
      .attr('y', -10)
      .style('font-family', D3_MONO_FONT)
      .style('font-size', '10px')
      .attr('fill', spec.yLabelColor ?? '#5C6670')
      .text(spec.yLabel);

    // Optional Right Y Axis
    if (y1 && spec.y2Label) {
      g.append('g')
        .attr('transform', `translate(${innerW},0)`)
        .call(d3.axisRight(y1).ticks(5))
        .call((sel) => sel.select('.domain').attr('stroke', '#CBD5E1'))
        .call((sel) => sel.selectAll('line').attr('stroke', '#CBD5E1'))
        .call((sel) =>
          sel
            .selectAll('text')
            .style('font-family', D3_MONO_FONT)
            .style('font-size', '10px')
            .attr('fill', spec.y2LabelColor ?? '#D97706')
        );

      g.append('text')
        .attr('x', innerW + 6)
        .attr('y', -10)
        .style('font-family', D3_MONO_FONT)
        .style('font-size', '10px')
        .attr('fill', spec.y2LabelColor ?? '#D97706')
        .text(spec.y2Label);
    }

    // Bisector hover crosshair
    const focusLine = g
      .append('line')
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#161A1D')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3 2')
      .attr('opacity', 0.45)
      .style('display', 'none')
      .attr('pointer-events', 'none');

    const overlay = g
      .append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseleave', () => {
        focusLine.style('display', 'none');
        setProbe(null);
      })
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event, overlay.node()!);
        const clampedX = Math.max(0, Math.min(innerW, mx));
        const xVal = x.invert(clampedX);
        focusLine.style('display', null).attr('x1', clampedX).attr('x2', clampedX);
        setProbe(spec.formatProbe(xVal));
      });
  }, [width, spec, ariaLabel]);

  return (
    <div className="flex flex-col gap-1.5">
      <div ref={containerRef} className="w-full" style={{ height: spec.heightPx }}>
        <svg ref={svgRef} className="w-full h-full block select-none" role="img" aria-label={ariaLabel} />
      </div>
      <div className="min-h-[18px] text-[11px] font-mono tabular-nums text-[#5C6670] flex items-center justify-between">
        <span className={probe ? 'text-[#161A1D] font-medium' : ''}>
          {probe ?? 'Hover plot to inspect values across x-axis (D3.js SVG)'}
        </span>
      </div>
    </div>
  );
}

export default function LearningLabPage({ onApplyToWorkstation }: LearningLabPageProps) {
  const navigate = useNavigate();
  const [activeModule, setActiveModule] = useState<LearningModuleId>('atmosphere');

  // Module 1: ISA & Compressibility State
  const [altitudeM, setAltitudeM] = useState<number>(5000);
  const [velocityMs, setVelocityMs] = useState<number>(180);
  const [chordM, setChordM] = useState<number>(1.5);

  const isaState = useMemo(() => computeISA(altitudeM), [altitudeM]);
  const dimState = useMemo(
    () =>
      computeDimensionlessAndGuardrails({
        density_kg_m3: isaState.density_kg_m3,
        dynamicViscosity_Pa_s: isaState.dynamicViscosity_Pa_s,
        speedOfSound_ms: isaState.speedOfSound_ms,
        velocity_ms: velocityMs,
        chord_m: chordM,
      }),
    [isaState, velocityMs, chordM]
  );

  const isaProfileData = useMemo(() => {
    const sea = computeISA(0);
    const pts: Array<{ hKm: number; tempK: number; densityRatio: number; pressureRatio: number }> = [];
    for (let h = 0; h <= 20000; h += 500) {
      const s = computeISA(h);
      pts.push({
        hKm: h / 1000,
        tempK: Number(s.temperature_K.toFixed(2)),
        densityRatio: Number((s.density_kg_m3 / sea.density_kg_m3).toFixed(4)),
        pressureRatio: Number((s.pressure_Pa / sea.pressure_Pa).toFixed(4)),
      });
    }
    return pts;
  }, []);

  const isaChartSpec = useMemo<D3LearningChartSpec>(() => {
    const altKm = altitudeM / 1000;
    const sea = computeISA(0);
    const curRhoRatio = Number((isaState.density_kg_m3 / sea.density_kg_m3).toFixed(4));
    const bisect = d3.bisector<(typeof isaProfileData)[number], number>((d) => d.hKm).center;

    return {
      heightPx: 300,
      xDomain: [0, 20],
      xLabel: 'Altitude (km)',
      yDomain: [0, 1.05],
      yLabel: 'ρ/ρ₀, P/P₀',
      yLabelColor: '#1769AA',
      y2Domain: [200, 300],
      y2Label: 'T (K)',
      y2LabelColor: '#D97706',
      verticalRefLine: { x: 11, label: 'Tropopause 11 km' },
      series: [
        {
          name: 'Density ρ/ρ₀',
          color: '#1769AA',
          width: 2.5,
          smooth: true,
          data: isaProfileData.map((p) => [p.hKm, p.densityRatio]),
        },
        {
          name: 'Pressure P/P₀',
          color: '#059669',
          width: 2,
          dashed: 'dashed',
          smooth: true,
          data: isaProfileData.map((p) => [p.hKm, p.pressureRatio]),
        },
        {
          name: 'Temp T (K)',
          color: '#D97706',
          width: 2.2,
          yAxisIndex: 1,
          data: isaProfileData.map((p) => [p.hKm, p.tempK]),
        },
      ],
      markers: [
        {
          name: 'Operating Altitude',
          color: '#1769AA',
          x: altKm,
          y: curRhoRatio,
          radius: 5.5,
        },
      ],
      formatProbe: (hKmVal) => {
        const idx = Math.max(0, Math.min(isaProfileData.length - 1, bisect(isaProfileData, hKmVal)));
        const pt = isaProfileData[idx];
        return `h = ${pt.hKm.toFixed(1)} km · ρ/ρ₀ = ${pt.densityRatio.toFixed(4)} · P/P₀ = ${pt.pressureRatio.toFixed(4)} · T = ${pt.tempK.toFixed(1)} K`;
      },
    };
  }, [altitudeM, isaState.density_kg_m3, isaProfileData]);

  // Module 2: Airfoil Cp(x/c), Kutta Closure & Stall Progression
  const [foilId, setFoilId] = useState<'naca0012' | 'naca2412'>('naca2412');
  const [foilAoaDeg, setFoilAoaDeg] = useState<number>(6.0);
  const [foilMach, setFoilMach] = useState<number>(0.15);
  const [foilReynolds, setFoilReynolds] = useState<number>(3_000_000);

  const foilEval = useMemo(() => {
    const cfg = AIRCRAFT_MODELS[foilId];
    const dataset = NACA_BENCHMARKS[foilId];
    const reynoldsShift = Math.max(-1.8, Math.min(1.8, Math.log10(Math.max(1e4, foilReynolds) / 3e6) * 0.85));
    const effStall = Math.max(4, cfg.stallAngle + reynoldsShift);
    const sep = computeSeparationOnset({
      aoaDeg: foilAoaDeg,
      posStallAngle: cfg.stallAngle,
      negStallAngle: foilId === 'naca0012' ? cfg.stallAngle : cfg.stallAngle * 0.8,
      reynolds: foilReynolds,
    });

    const isStalled = Math.abs(foilAoaDeg) >= effStall;
    const degPastStall = isStalled ? Math.abs(foilAoaDeg) - effStall : 0;

    // 2D thin-airfoil + compressibility slope (before finite-wing reduction)
    const beta = Math.sqrt(Math.max(0.2, 1 - Math.min(0.7, foilMach) ** 2));
    const slope2dPerDeg = ((2 * Math.PI) / beta) * (Math.PI / 180);
    const alphaZero = cfg.alphaZeroLift ?? 0;
    const linear2dCl = slope2dPerDeg * (foilAoaDeg - alphaZero);
    const cl2d =
      sep.xSeparationUpper >= 0.999
        ? Math.max(-cfg.clMax, Math.min(cfg.clMax, linear2dCl))
        : linear2dCl * sep.kirchhoffLiftFactor;

    const cp = computeChordwiseCpAndLift({
      targetCl: cl2d,
      aoaDeg: foilAoaDeg,
      mach: foilMach,
      reynolds: foilReynolds,
      thicknessRatio: cfg.thicknessRatio ?? 0.12,
      camberRatio: cfg.camberRatio ?? 0,
      flapsDeg: 0,
      xSeparationUpper: sep.xSeparationUpper,
      isStalled,
      degPastStall,
    });

    const xfoilStations = getBenchmarkCpStations(dataset, foilAoaDeg);
    return { cfg, dataset, sep, isStalled, cl2d, cp, xfoilStations };
  }, [foilId, foilAoaDeg, foilMach, foilReynolds]);

  const cpChartSpec = useMemo<D3LearningChartSpec>(() => {
    const allCp = [
      ...foilEval.cp.stations.map((s) => s.cpUpper),
      ...foilEval.cp.stations.map((s) => s.cpLower),
      ...foilEval.xfoilStations.map((s) => s.cpUpper),
      ...foilEval.xfoilStations.map((s) => s.cpLower),
    ];
    const minObserved = d3.min(allCp) ?? -2.5;
    const minCp = Math.min(-3.5, Number((minObserved - 0.3).toFixed(1)));
    const bisect = d3.bisector<(typeof foilEval.cp.stations)[number], number>((d) => d.xc).center;

    return {
      heightPx: 270,
      xDomain: [0, 1],
      xLabel: 'Chord Station x/c',
      yDomain: [minCp, 1.2],
      yLabel: 'Cp',
      yInvert: true,
      series: [
        {
          name: 'Surrogate Upper (-Cp)',
          color: '#1769AA',
          width: 2.5,
          smooth: true,
          data: foilEval.cp.stations.map((s) => [s.xc, s.cpUpper]),
        },
        {
          name: 'Surrogate Lower (+Cp)',
          color: '#D97706',
          width: 2.2,
          smooth: true,
          data: foilEval.cp.stations.map((s) => [s.xc, s.cpLower]),
        },
        {
          name: 'XFOIL Upper',
          color: '#059669',
          width: 1.6,
          dashed: 'dashed',
          smooth: true,
          showDots: 'circle',
          data: foilEval.xfoilStations.map((s) => [s.xc, s.cpUpper]),
        },
        {
          name: 'XFOIL Lower',
          color: '#64748B',
          width: 1.4,
          dashed: 'dotted',
          smooth: true,
          showDots: 'diamond',
          data: foilEval.xfoilStations.map((s) => [s.xc, s.cpLower]),
        },
      ],
      formatProbe: (xcVal) => {
        const idx = Math.max(0, Math.min(foilEval.cp.stations.length - 1, bisect(foilEval.cp.stations, xcVal)));
        const st = foilEval.cp.stations[idx];
        return `x/c = ${st.xc.toFixed(3)} · Surrogate Cp_u = ${st.cpUpper.toFixed(3)} · Cp_l = ${st.cpLower.toFixed(3)} · ΔCp = ${(st.cpLower - st.cpUpper).toFixed(3)}`;
      },
    };
  }, [foilEval]);

  // SVG path for live airfoil cross-section in Module 2
  const foilSvgGeometry = useMemo(() => {
    const m = foilId === 'naca2412' ? 0.02 : 0.0;
    const p = foilId === 'naca2412' ? 0.4 : 0.0;
    const t = 0.12;
    const upperPts: Array<[number, number]> = [];
    const lowerPts: Array<[number, number]> = [];
    const n = 40;

    for (let i = 0; i <= n; i++) {
      const beta = (Math.PI * i) / n;
      const x = 0.5 * (1 - Math.cos(beta));
      const yt =
        5 *
        t *
        (0.2969 * Math.sqrt(Math.max(1e-5, x)) -
          0.126 * x -
          0.3516 * x * x +
          0.2843 * x * x * x -
          0.1015 * x * x * x * x);
      let yc = 0;
      let dyc = 0;
      if (m > 0 && p > 0) {
        if (x < p) {
          yc = (m / (p * p)) * (2 * p * x - x * x);
          dyc = ((2 * m) / (p * p)) * (p - x);
        } else {
          yc = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
          dyc = ((2 * m) / ((1 - p) * (1 - p))) * (p - x);
        }
      }
      const theta = Math.atan(dyc);
      upperPts.push([x - yt * Math.sin(theta), yc + yt * Math.cos(theta)]);
      lowerPts.push([x + yt * Math.sin(theta), yc - yt * Math.cos(theta)]);
    }

    const chordPx = 280;
    const cx = 210;
    const cy = 115;
    const rad = (foilAoaDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    const project = (xc: number, yc: number): [number, number] => {
      const rx = (xc - 0.25) * chordPx;
      const ry = yc * chordPx;
      const xRot = rx * cosA + ry * sinA;
      const yRot = -rx * sinA + ry * cosA;
      return [cx + xRot, cy - yRot];
    };

    const allPts = [...upperPts, ...lowerPts.slice().reverse()].map(([x, y]) => project(x, y));
    const pathD = `M ${allPts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L ')} Z`;

    const trIdx = Math.min(n, Math.round(foilEval.cp.xTransitionUpper * n));
    const sepIdx = Math.min(n, Math.round(foilEval.cp.separationXc * n));
    const stagIdx = Math.min(n, Math.round(foilEval.cp.stagnationXc * n));

    const trPt = project(upperPts[trIdx][0], upperPts[trIdx][1]);
    const sepPt = project(upperPts[sepIdx][0], upperPts[sepIdx][1]);
    const stagPt = project(lowerPts[stagIdx][0], lowerPts[stagIdx][1]);

    return { pathD, trPt, sepPt, stagPt, project };
  }, [foilId, foilAoaDeg, foilEval.cp.xTransitionUpper, foilEval.cp.separationXc, foilEval.cp.stagnationXc]);

  // Module 3: Prandtl Finite-Wing Lifting-Line & Drag Polar
  const [llModel, setLlModel] = useState<'naca0012' | 'naca2412'>('naca2412');
  const [llAspectRatio, setLlAspectRatio] = useState<number>(6.88);
  const [llOswaldE, setLlOswaldE] = useState<number>(0.82);
  const [llCd0, setLlCd0] = useState<number>(0.008);
  const [llAoaDeg, setLlAoaDeg] = useState<number>(6.0);

  const liftingLineEval = useMemo(() => {
    const dataset = NACA_BENCHMARKS[llModel];
    const attachedPoints = dataset.polar.filter((pt) => pt.aoa >= -10 && pt.aoa <= 15);
    const sweep3d = attachedPoints.map((pt) => {
      const conv = convert2DBenchmarkToFiniteWing(pt, llAspectRatio, llOswaldE);
      const cd3d = llCd0 + (conv.cl3d * conv.cl3d) / (Math.PI * llOswaldE * llAspectRatio);
      return {
        aoa: pt.aoa,
        cl2d: pt.cl2d,
        cd2d: pt.cd2d,
        cl3d: conv.cl3d,
        cd3d: Number(cd3d.toFixed(4)),
      };
    });

    // Interpolate current operating point on 2D & 3D curves
    let cl2dOp = 0;
    for (let i = 0; i < sweep3d.length - 1; i++) {
      const a = sweep3d[i];
      const b = sweep3d[i + 1];
      if (llAoaDeg >= a.aoa && llAoaDeg <= b.aoa) {
        const t = (llAoaDeg - a.aoa) / Math.max(1e-6, b.aoa - a.aoa);
        cl2dOp = a.cl2d + (b.cl2d - a.cl2d) * t;
        break;
      }
    }
    const finiteFactor = llAspectRatio / (llAspectRatio + (2 * Math.PI) / (Math.PI * llOswaldE));
    const cl3dOp = cl2dOp * finiteFactor;

    const spanM = 11.0;
    const chordM = spanM / llAspectRatio;
    const fw = computeFiniteWingAerodynamics({
      wingspan_m: spanM,
      chord_m: chordM,
      oswaldEfficiency: llOswaldE,
      cl: cl3dOp,
      velocity_ms: 60,
      density_kg_m3: 1.225,
    });
    const cdTotal = llCd0 + fw.cdi;
    const ldOp = cdTotal > 1e-4 ? cl3dOp / cdTotal : 0;
    const ldMaxTheory = Math.sqrt((Math.PI * llOswaldE * llAspectRatio) / (4 * llCd0));

    return {
      dataset,
      sweep3d,
      finiteFactor,
      cl2dOp,
      cl3dOp,
      fw,
      cdTotal,
      ldOp,
      ldMaxTheory,
    };
  }, [llModel, llAspectRatio, llOswaldE, llCd0, llAoaDeg]);

  const llChartSpec = useMemo<D3LearningChartSpec>(() => {
    const bisect = d3.bisector<(typeof liftingLineEval.sweep3d)[number], number>((d) => d.aoa).center;
    return {
      heightPx: 330,
      xDomain: [-10, 15],
      xLabel: 'Angle of Attack α (°)',
      xFormat: (v) => `${v.toFixed(0)}°`,
      yDomain: [-1.2, 1.8],
      yLabel: 'CL',
      series: [
        {
          name: '2D Section (AR = ∞)',
          color: '#64748B',
          width: 2,
          dashed: 'dashed',
          smooth: true,
          data: liftingLineEval.sweep3d.map((p) => [p.aoa, p.cl2d]),
        },
        {
          name: `3D Finite Wing (AR = ${llAspectRatio.toFixed(1)})`,
          color: '#1769AA',
          width: 2.6,
          smooth: true,
          data: liftingLineEval.sweep3d.map((p) => [p.aoa, p.cl3d]),
        },
      ],
      markers: [
        {
          name: '3D Operating Point',
          color: '#1769AA',
          x: llAoaDeg,
          y: Number(liftingLineEval.cl3dOp.toFixed(3)),
          radius: 5.5,
        },
      ],
      formatProbe: (aoaVal) => {
        const idx = Math.max(0, Math.min(liftingLineEval.sweep3d.length - 1, bisect(liftingLineEval.sweep3d, aoaVal)));
        const pt = liftingLineEval.sweep3d[idx];
        return `α = ${pt.aoa.toFixed(1)}° · 2D Cl = ${pt.cl2d.toFixed(3)} · 3D CL = ${pt.cl3d.toFixed(3)} · 3D CD = ${pt.cd3d.toFixed(4)}`;
      },
    };
  }, [llAspectRatio, llAoaDeg, liftingLineEval]);

  // Module 4: Flat-Plate Skin Friction & Concept Check Quiz
  const [cfLogRe, setCfLogRe] = useState<number>(6.48); // ~3.0e6
  const [cfXc, setCfXc] = useState<number>(0.5);
  const selectedRe = useMemo(() => Math.pow(10, cfLogRe), [cfLogRe]);
  const selectedLocalRe = useMemo(() => Math.max(100, selectedRe * cfXc), [selectedRe, cfXc]);
  const flatPlateEval = useMemo(
    () => computeFlatPlateSkinFriction(selectedRe, selectedLocalRe),
    [selectedRe, selectedLocalRe]
  );

  const cfChartSpec = useMemo<D3LearningChartSpec>(() => {
    const lamPts: Array<[number, number]> = [];
    const turbPts: Array<[number, number]> = [];
    for (let exp = 4.0; exp <= 8.001; exp += 0.2) {
      const r = Math.pow(10, exp);
      const cf = computeFlatPlateSkinFriction(r);
      lamPts.push([Number(exp.toFixed(2)), Number((cf.laminarMeanCf * 1000).toFixed(3))]);
      turbPts.push([Number(exp.toFixed(2)), Number((cf.turbulentMeanCf * 1000).toFixed(3))]);
    }
    const bisect = d3.bisector<[number, number], number>((d) => d[0]).center;

    return {
      heightPx: 270,
      xDomain: [4, 8],
      xTicks: 4,
      xLabel: 'log₁₀(Re)',
      xFormat: (v) => `10^${v}`,
      yDomain: [0, 14],
      yLabel: 'Cf̄ (×10⁻³)',
      series: [
        {
          name: 'Blasius Laminar Cf̄ (×10³)',
          color: '#059669',
          width: 2.5,
          smooth: true,
          data: lamPts,
        },
        {
          name: 'Schlichting Turbulent Cf̄ (×10³)',
          color: '#D97706',
          width: 2.5,
          smooth: true,
          data: turbPts,
        },
      ],
      markers: [
        {
          name: 'Selected Re (Lam)',
          color: '#059669',
          x: cfLogRe,
          y: Number((flatPlateEval.laminarMeanCf * 1000).toFixed(3)),
          radius: 5,
        },
        {
          name: 'Selected Re (Turb)',
          color: '#D97706',
          x: cfLogRe,
          y: Number((flatPlateEval.turbulentMeanCf * 1000).toFixed(3)),
          radius: 5,
        },
      ],
      formatProbe: (expVal) => {
        const idx = Math.max(0, Math.min(lamPts.length - 1, bisect(lamPts, expVal)));
        const exp = lamPts[idx][0];
        return `Re = 10^${exp.toFixed(1)} (${Math.pow(10, exp).toExponential(2)}) · Blasius Cf̄ = ${lamPts[idx][1].toFixed(3)}×10⁻³ · Schlichting Cf̄ = ${turbPts[idx][1].toFixed(3)}×10⁻³`;
      },
    };
  }, [cfLogRe, flatPlateEval]);

  // Quiz state
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const answeredCount = Object.keys(quizAnswers).length;
  const correctCount = QUIZ_QUESTIONS.filter((q) => quizAnswers[q.id] === q.correctIndex).length;

  const handleLaunchBenchmarkIn3D = (model: 'naca0012' | 'naca2412', aoa: number) => {
    const match = computeBenchmarkMatchConditions(model, 3_000_000, 0.15);
    if (onApplyToWorkstation) {
      onApplyToWorkstation({
        modelType: model,
        aoaDeg: aoa,
        airspeedKts: Math.round(match.airspeed_kts),
        altitudeFt: match.altitude_ft,
        flapsDeg: 0,
      });
    }
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex flex-col font-sans">
      {/* 1. Clean 3-Zone Top Bar */}
      <header className="h-14 px-4 sm:px-6 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-8 sticky top-0 z-30">
        <Link
          to="/"
          className="text-base sm:text-lg font-bold tracking-tight text-[#161A1D] whitespace-nowrap shrink-0 flex items-center gap-2.5"
        >
          <img src="/aerolab-logo.png" alt="AeroMatrix" className="h-6 w-auto object-contain shrink-0" />
          <span>AeroMatrix</span>
        </Link>

        <nav
          aria-label="Learning Lab Modules"
          className="hidden md:flex items-center gap-6 text-xs sm:text-sm font-semibold text-[#5C6670]"
        >
          {(
            [
              { id: 'atmosphere', label: 'ISA & Mach' },
              { id: 'cp-stall', label: 'Cp & Stall' },
              { id: 'lifting-line', label: 'Lifting-Line' },
              { id: 'boundary-quiz', label: 'Skin Friction & Quiz' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveModule(item.id)}
              className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
                activeModule === item.id
                  ? 'border-[#1769AA] text-[#1769AA]'
                  : 'border-transparent hover:text-[#161A1D]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <Link
            to="/"
            className="px-3.5 py-2 rounded-lg bg-[#1769AA] hover:bg-[#145a92] text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <ArrowLeft weight="bold" className="w-3.5 h-3.5" />
            <span>Wind Tunnel</span>
          </Link>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        {/* Hero Header + Solver Transparency Statement */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-5 border-b border-[var(--border)]">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-xs font-mono text-[#5C6670] mb-1.5">
              <span>Aerospace Simulation &amp; Learning Laboratory</span>
              <span aria-hidden="true">·</span>
              <span>SI Units (m, s, kg, Pa, K, rad)</span>
              <span aria-hidden="true">·</span>
              <span>NACA TR-824 &amp; XFOIL Benchmarks</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[#161A1D] [text-wrap:balance]">
              First-Principles Aerodynamics &amp; Regime Verification Lab
            </h1>
            <p className="text-sm text-[#5C6670] mt-2 leading-relaxed">
              Explore live International Standard Atmosphere physics, Prandtl–Glauert compressibility limits, surrogate chordwise pressure integration against NACA TR-824 data, and finite-wing lifting-line theory.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-xs text-[#5C6670] lg:max-w-sm shrink-0">
            <div className="font-semibold text-[#161A1D] flex items-center gap-1.5 mb-1">
              <BookOpenText weight="duotone" className="w-4 h-4 text-[#1769AA]" />
              <span>Solver Scope &amp; Transparency</span>
            </div>
            <p className="text-[11.5px] leading-snug">
              All equations evaluate directly from <span className="font-mono text-[#161A1D]">src/lib/aeroPhysics.ts</span>. 3D visualization uses a <strong className="text-[#161A1D]">{SOLVER_LABEL_3D}</strong> rather than a full 3D Navier–Stokes RANS/LES solver.
            </p>
          </div>
        </section>

        {/* Mobile / Compact Segmented Module Selector */}
        <div
          role="tablist"
          aria-label="Learning Modules"
          className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-xl bg-[var(--surface)] border border-[var(--border)]"
        >
          {(
            [
              { id: 'atmosphere', num: '01.', label: 'ISA & Compressibility' },
              { id: 'cp-stall', num: '02.', label: 'Surface Cp & Stall' },
              { id: 'lifting-line', num: '03.', label: 'Finite-Wing Polar' },
              { id: 'boundary-quiz', num: '04.', label: 'Skin Friction & Quiz' },
            ] as const
          ).map((tab) => {
            const active = activeModule === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveModule(tab.id)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold text-left flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#1769AA] text-white'
                    : 'text-[#5C6670] hover:text-[#161A1D] hover:bg-[var(--bg)]'
                }`}
              >
                <span className="font-mono opacity-80">{tab.num}</span>
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* MODULE 01: ISA ATMOSPHERE & COMPRESSIBILITY */}
        {activeModule === 'atmosphere' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Interactive Parameter Controls */}
            <div className="lg:col-span-4 p-4 sm:p-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4">
              <div>
                <h2 className="text-base font-bold text-[#161A1D] flex items-center gap-2">
                  <Gauge weight="duotone" className="w-4 h-4 text-[#1769AA]" />
                  <span>01. Flight Envelope Inputs</span>
                </h2>
                <p className="text-xs text-[#5C6670] mt-1">
                  Adjust geopotential altitude (0–20 km), true airspeed, and reference chord to inspect ISA state and regime guardrails.
                </p>
              </div>

              <div className="flex flex-col gap-3.5">
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Geopotential Altitude h</span>
                    <span className="font-mono tabular-nums text-[#1769AA]">
                      {altitudeM.toLocaleString()} m ({Math.round(altitudeM / ISA_CONSTANTS.FT_TO_M).toLocaleString()} ft)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={20000}
                    step={250}
                    value={altitudeM}
                    onChange={(e) => setAltitudeM(Number(e.target.value))}
                  />
                  <div className="grid grid-cols-4 gap-1 text-[10.5px] font-mono">
                    {[
                      { label: '0 km', val: 0 },
                      { label: '5 km', val: 5000 },
                      { label: '11 km', val: 11000 },
                      { label: '20 km', val: 20000 },
                    ].map((p) => (
                      <button
                        key={p.val}
                        type="button"
                        onClick={() => setAltitudeM(p.val)}
                        className={`py-1 rounded border cursor-pointer ${
                          altitudeM === p.val
                            ? 'bg-[var(--accent-light)] border-[#1769AA] text-[#1769AA] font-bold'
                            : 'bg-[var(--bg)] border-[var(--border)] text-[#5C6670]'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </label>

                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>True Airspeed V∞</span>
                    <span className="font-mono tabular-nums text-[#1769AA]">
                      {velocityMs} m/s ({Math.round(velocityMs / ISA_CONSTANTS.KTS_TO_MS)} kts)
                    </span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={450}
                    step={5}
                    value={velocityMs}
                    onChange={(e) => setVelocityMs(Number(e.target.value))}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Reference Chord c</span>
                    <span className="font-mono tabular-nums text-[#1769AA]">{chordM.toFixed(2)} m</span>
                  </div>
                  <input
                    type="range"
                    min={0.2}
                    max={8.0}
                    step={0.1}
                    value={chordM}
                    onChange={(e) => setChordM(Number(e.target.value))}
                  />
                </label>
              </div>

              {/* Regime Warnings / Guardrails */}
              <div className="pt-3 border-t border-[var(--border)] flex flex-col gap-2">
                <div className="text-xs font-semibold text-[#161A1D]">Active Physical Guardrails</div>
                {dimState.regimeWarnings.length === 0 ? (
                  <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2">
                    <CheckCircle weight="duotone" className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">● Incompressible Continuum (M ≤ 0.30, Kn ≤ 0.01)</div>
                      <div className="text-[11px] opacity-90 mt-0.5">
                        Standard incompressible Bernoulli relation Cp = 1 − (V/V∞)² holds accurately.
                      </div>
                    </div>
                  </div>
                ) : (
                  dimState.regimeWarnings.map((w) => (
                    <div
                      key={w.code}
                      className={`p-2.5 rounded-lg border text-xs flex items-start gap-2 ${
                        w.severity === 'critical'
                          ? 'bg-red-50 border-red-200 text-red-900'
                          : w.severity === 'warning'
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-sky-50 border-sky-200 text-sky-900'
                      }`}
                    >
                      <WarningCircle weight="duotone" className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold font-mono">{w.title}</div>
                        <div className="text-[11px] opacity-90 mt-0.5">{w.detail}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Stage: Live ISA Telemetry & Altitude Plot */}
            <div className="lg:col-span-8 flex flex-col gap-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  {
                    label: 'Temperature T',
                    val: `${isaState.temperature_K.toFixed(2)} K`,
                    sub: `${(isaState.temperature_K - 273.15).toFixed(1)} °C · ${altitudeM <= 11000 ? 'Troposphere' : 'Stratosphere'}`,
                  },
                  {
                    label: 'Density ρ & Pressure P',
                    val: `${isaState.density_kg_m3.toFixed(4)} kg/m³`,
                    sub: `${(isaState.pressure_Pa / 1000).toFixed(2)} kPa`,
                  },
                  {
                    label: 'Mach & Speed of Sound',
                    val: `M ${dimState.mach.toFixed(3)}`,
                    sub: `a = ${isaState.speedOfSound_ms.toFixed(1)} m/s · β⁻¹ = ×${dimState.prandtlGlauertFactor.toFixed(3)}`,
                  },
                  {
                    label: 'Reynolds & Knudsen',
                    val: dimState.reynolds.toExponential(2),
                    sub: `Kn = ${dimState.knudsen.toExponential(2)} · q∞ = ${(dimState.dynamicPressure_Pa / 1000).toFixed(2)} kPa`,
                  },
                ].map((m) => (
                  <div
                    key={m.label}
                    className="p-3.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col justify-between gap-1"
                  >
                    <span className="text-[11px] font-semibold text-[#5C6670]">{m.label}</span>
                    <span className="text-lg font-bold font-mono tabular-nums text-[#161A1D]">
                      {m.val}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-[#5C6670] truncate">
                      {m.sub}
                    </span>
                  </div>
                ))}
              </div>

              <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[#161A1D]">
                    ISA Atmospheric Profile (0–20 km) &amp; Sutherland Viscosity
                  </h3>
                  <span className="text-xs font-mono tabular-nums text-[#5C6670]">
                    μ = {isaState.dynamicViscosity_Pa_s.toExponential(3)} Pa·s
                  </span>
                </div>
                <D3LearningChart spec={isaChartSpec} ariaLabel="ISA Atmospheric Profile Chart" />
              </div>
            </div>
          </section>
        )}

        {/* MODULE 02: SURFACE Cp(x/c), KUTTA CLOSURE & STALL */}
        {activeModule === 'cp-stall' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 p-4 sm:p-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4">
              <div>
                <h2 className="text-base font-bold text-[#161A1D] flex items-center gap-2">
                  <Wind weight="duotone" className="w-4 h-4 text-[#1769AA]" />
                  <span>02. Airfoil Section &amp; Flow State</span>
                </h2>
                <p className="text-xs text-[#5C6670] mt-1">
                  Compare integrated surrogate Cp profiles against digitized XFOIL / NACA TR-824 wind-tunnel stations.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {(['naca0012', 'naca2412'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFoilId(id)}
                    className={`py-2 px-3 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                      foilId === id
                        ? 'bg-[#1769AA] border-[#1769AA] text-white'
                        : 'bg-[var(--bg)] border-[var(--border)] text-[#161A1D] hover:border-[#1769AA]'
                    }`}
                  >
                    {id === 'naca0012' ? 'NACA 0012 (Sym)' : 'NACA 2412 (2% Camber)'}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  setFoilMach(0.15);
                  setFoilReynolds(3_000_000);
                  setFoilAoaDeg(6.0);
                }}
                className="w-full py-2 px-3 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 text-xs font-semibold cursor-pointer transition-colors"
              >
                Reset to Wind-Tunnel Benchmark (Re = 3.0×10⁶, M = 0.15)
              </button>

              <label className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Angle of Attack α</span>
                  <span className="font-mono tabular-nums text-[#1769AA]">
                    {foilAoaDeg >= 0 ? '+' : ''}
                    {foilAoaDeg.toFixed(1)}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-12}
                  max={22}
                  step={0.5}
                  value={foilAoaDeg}
                  onChange={(e) => setFoilAoaDeg(Number(e.target.value))}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Freestream Mach M∞</span>
                  <span className="font-mono tabular-nums text-[#1769AA]">{foilMach.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={0.7}
                  step={0.01}
                  value={foilMach}
                  onChange={(e) => setFoilMach(Number(e.target.value))}
                />
              </label>

              <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-xs font-mono tabular-nums flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Integrated CL (upper + lower):</span>
                  <span className="font-bold text-[#161A1D]">
                    {foilEval.cp.clUpper.toFixed(3)} + {foilEval.cp.clLower.toFixed(3)} = {foilEval.cp.clIntegrated.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Upper Suction Share:</span>
                  <span className="font-semibold text-[#1769AA]">
                    {foilEval.cp.suctionPercentage.toFixed(1)}% / {foilEval.cp.compressionPercentage.toFixed(1)}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Kutta TE |ΔCp(1)|:</span>
                  <span className="font-semibold text-emerald-700">{foilEval.cp.kuttaTeDeltaCp.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Est. x_tr / x_sep (Upper):</span>
                  <span className={foilEval.cp.separationXc < 0.95 ? 'font-bold text-red-700' : 'font-semibold text-[#161A1D]'}>
                    {(foilEval.cp.xTransitionUpper * 100).toFixed(0)}% / {(foilEval.cp.separationXc * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleLaunchBenchmarkIn3D(foilId, foilAoaDeg)}
                className="w-full py-2 px-3 rounded-lg bg-[#1769AA] hover:bg-[#145a92] text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <Play weight="fill" className="w-3.5 h-3.5" />
                <span>Launch Matched {foilId.toUpperCase()} in 3D Tunnel</span>
              </button>
            </div>

            <div className="lg:col-span-8 flex flex-col gap-4">
              {/* Live SVG Airfoil Geometry Diagram */}
              <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[#161A1D]">
                    Section Geometry &amp; Empirical Boundary-Layer Landmarks
                  </h3>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      foilEval.isStalled ? 'text-red-700' : 'text-emerald-700'
                    }`}
                  >
                    {foilEval.isStalled ? '▲ Post-Stall Separation' : '● Attached Flow'}
                  </span>
                </div>
                <svg viewBox="0 0 420 210" className="w-full h-[180px] rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                  {/* Freestream vectors */}
                  {[45, 105, 165].map((y) => (
                    <g key={y} stroke="#CBD5E1" strokeWidth="1.2">
                      <line x1="16" y1={y} x2="54" y2={y} />
                      <polyline points={`48,${y - 3} 54,${y} 48,${y + 3}`} fill="none" />
                    </g>
                  ))}
                  {/* Airfoil section */}
                  <path
                    d={foilSvgGeometry.pathD}
                    fill="rgba(23, 105, 170, 0.14)"
                    stroke="#1769AA"
                    strokeWidth="2"
                  />
                  {/* Stagnation marker */}
                  <circle cx={foilSvgGeometry.stagPt[0]} cy={foilSvgGeometry.stagPt[1]} r="4.5" fill="#F59E0B" />
                  <text
                    x={foilSvgGeometry.stagPt[0] - 8}
                    y={foilSvgGeometry.stagPt[1] + 16}
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                    fill="#B45309"
                  >
                    Stag
                  </text>
                  {/* Transition marker */}
                  <circle cx={foilSvgGeometry.trPt[0]} cy={foilSvgGeometry.trPt[1]} r="4.5" fill="#059669" />
                  <text
                    x={foilSvgGeometry.trPt[0] - 10}
                    y={foilSvgGeometry.trPt[1] - 10}
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                    fill="#047857"
                  >
                    x_tr {(foilEval.cp.xTransitionUpper * 100).toFixed(0)}%
                  </text>
                  {/* Separation marker */}
                  {foilEval.cp.separationXc < 0.99 && (
                    <>
                      <circle cx={foilSvgGeometry.sepPt[0]} cy={foilSvgGeometry.sepPt[1]} r="4.5" fill="#DC2626" />
                      <text
                        x={foilSvgGeometry.sepPt[0] - 14}
                        y={foilSvgGeometry.sepPt[1] - 12}
                        fontSize="10"
                        fontFamily="JetBrains Mono, monospace"
                        fill="#B91C1C"
                      >
                        x_sep {(foilEval.cp.separationXc * 100).toFixed(0)}%
                      </text>
                    </>
                  )}
                </svg>
              </div>

              {/* Live Cp(x/c) Chart */}
              <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-[#161A1D]">
                    Chordwise Pressure Coefficient Cp(x/c) vs. XFOIL Reference
                  </h3>
                  <span className="text-xs font-mono text-[#5C6670]">
                    PG Factor ×{(1 / Math.sqrt(1 - Math.min(0.7, foilMach) ** 2)).toFixed(3)}
                  </span>
                </div>
                <D3LearningChart spec={cpChartSpec} ariaLabel="Chordwise Pressure Coefficient Cp Chart" />
              </div>
            </div>
          </section>
        )}

        {/* MODULE 03: PRANDTL FINITE-WING LIFTING-LINE */}
        {activeModule === 'lifting-line' && (
          <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-4 p-4 sm:p-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4">
              <div>
                <h2 className="text-base font-bold text-[#161A1D] flex items-center gap-2">
                  <CompassRose weight="duotone" className="w-4 h-4 text-[#1769AA]" />
                  <span>03. Finite-Wing Planform</span>
                </h2>
                <p className="text-xs text-[#5C6670] mt-1">
                  Observe how finite Aspect Ratio AR and Oswald efficiency e project 2D wind-tunnel sections into 3D wing performance.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {(['naca0012', 'naca2412'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setLlModel(id);
                      setLlCd0(AIRCRAFT_MODELS[id].cd0);
                    }}
                    className={`py-2 px-3 rounded-lg border text-xs font-semibold cursor-pointer ${
                      llModel === id
                        ? 'bg-[#1769AA] border-[#1769AA] text-white'
                        : 'bg-[var(--bg)] border-[var(--border)] text-[#161A1D]'
                    }`}
                  >
                    {id.toUpperCase()}
                  </button>
                ))}
              </div>

              <label className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Aspect Ratio AR = b² / S</span>
                  <span className="font-mono tabular-nums text-[#1769AA]">{llAspectRatio.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={3.0}
                  max={18.0}
                  step={0.2}
                  value={llAspectRatio}
                  onChange={(e) => setLlAspectRatio(Number(e.target.value))}
                />
                <div className="grid grid-cols-3 gap-1 text-[10.5px] font-mono">
                  {[
                    { label: 'Stubby 4.0', val: 4.0 },
                    { label: 'GA 6.9', val: 6.88 },
                    { label: 'Sailplane 16', val: 16.0 },
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => setLlAspectRatio(p.val)}
                      className="py-1 rounded bg-[var(--bg)] border border-[var(--border)] text-[#5C6670] hover:border-[#1769AA] cursor-pointer"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </label>

              <label className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Oswald Span Efficiency e</span>
                  <span className="font-mono tabular-nums text-[#1769AA]">{llOswaldE.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.6}
                  max={0.98}
                  step={0.01}
                  value={llOswaldE}
                  onChange={(e) => setLlOswaldE(Number(e.target.value))}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Angle of Attack α</span>
                  <span className="font-mono tabular-nums text-[#1769AA]">
                    {llAoaDeg >= 0 ? '+' : ''}
                    {llAoaDeg.toFixed(1)}°
                  </span>
                </div>
                <input
                  type="range"
                  min={-8}
                  max={14}
                  step={0.5}
                  value={llAoaDeg}
                  onChange={(e) => setLlAoaDeg(Number(e.target.value))}
                />
              </label>

              <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-xs font-mono tabular-nums flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Finite Slope Factor:</span>
                  <span className="font-bold text-[#161A1D]">×{liftingLineEval.finiteFactor.toFixed(3)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">2D Cl → 3D CL:</span>
                  <span className="font-bold text-[#1769AA]">
                    {liftingLineEval.cl2dOp.toFixed(3)} → {liftingLineEval.cl3dOp.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">αi / Downwash ε = 2αi:</span>
                  <span className="font-semibold text-[#161A1D]">
                    {liftingLineEval.fw.inducedAlpha_deg.toFixed(2)}° / {liftingLineEval.fw.downwashAngle_deg.toFixed(2)}°
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">CD = CD0 + CDi:</span>
                  <span className="font-semibold text-amber-700">
                    {llCd0.toFixed(4)} + {liftingLineEval.fw.cdi.toFixed(4)} = {liftingLineEval.cdTotal.toFixed(4)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#5C6670]">Operating L/D (Max Theory):</span>
                  <span className="font-semibold text-emerald-700">
                    {liftingLineEval.ldOp.toFixed(1)} ({liftingLineEval.ldMaxTheory.toFixed(1)})
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-8 flex flex-col gap-4">
              <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-[#161A1D]">
                    Prandtl Lifting-Line Projection: 2D Airfoil vs. 3D Finite Wing
                  </h3>
                  <span className="text-xs font-mono text-[#5C6670]">
                    CL,3D = Cl,2D / (1 + a₀ / (π·e·AR))
                  </span>
                </div>
                <D3LearningChart spec={llChartSpec} ariaLabel="Prandtl Lifting-Line Polar Chart" />
              </div>

              <div className="p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono tabular-nums">
                <div>
                  <div className="text-[#5C6670]">Induced Angle αi</div>
                  <div className="text-base font-bold text-[#161A1D] mt-0.5">
                    {liftingLineEval.fw.inducedAlpha_deg.toFixed(2)}° ({liftingLineEval.fw.inducedAlpha_rad.toFixed(4)} rad)
                  </div>
                </div>
                <div>
                  <div className="text-[#5C6670]">Inferred vs. Elliptic Peak Γ</div>
                  <div className="text-base font-bold text-[#1769AA] mt-0.5">
                    {liftingLineEval.fw.equivalentCirculation_m2_s.toFixed(1)} / {liftingLineEval.fw.ellipticRootCirculation_m2_s.toFixed(1)} m²/s
                  </div>
                </div>
                <div>
                  <div className="text-[#5C6670]">Induced Drag Fraction CDi / CD</div>
                  <div className="text-base font-bold text-amber-700 mt-0.5">
                    {liftingLineEval.cdTotal > 1e-5
                      ? ((liftingLineEval.fw.cdi / liftingLineEval.cdTotal) * 100).toFixed(1)
                      : '0.0'}
                    %
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* MODULE 04: FLAT-PLATE SKIN FRICTION & CONCEPT VERIFICATION QUIZ */}
        {activeModule === 'boundary-quiz' && (
          <section className="flex flex-col gap-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-5 p-4 sm:p-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4">
                <div>
                  <h2 className="text-base font-bold text-[#161A1D] flex items-center gap-2">
                    <ArrowUpRight weight="duotone" className="w-4 h-4 text-[#1769AA]" />
                    <span>04. Flat-Plate Skin Friction Reference</span>
                  </h2>
                  <p className="text-xs text-[#5C6670] mt-1">
                    Compare local Cf,x against plate-averaged Cf̄ for Blasius laminar and Schlichting turbulent boundary layers.
                  </p>
                </div>

                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Chord Reynolds Number Re</span>
                    <span className="font-mono tabular-nums text-[#1769AA]">
                      {selectedRe.toExponential(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4.0}
                    max={8.0}
                    step={0.05}
                    value={cfLogRe}
                    onChange={(e) => setCfLogRe(Number(e.target.value))}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Local Station x/c (for Cf,x)</span>
                    <span className="font-mono tabular-nums text-[#1769AA]">
                      {(cfXc * 100).toFixed(0)}% (Re_x = {selectedLocalRe.toExponential(2)})
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.05}
                    max={1.0}
                    step={0.05}
                    value={cfXc}
                    onChange={(e) => setCfXc(Number(e.target.value))}
                  />
                </label>

                <div className="p-3 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-xs font-mono tabular-nums grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="text-[#5C6670] text-[10.5px]">Blasius Local Cf,x</div>
                    <div className="font-bold text-emerald-700">{flatPlateEval.laminarLocalCf.toFixed(5)}</div>
                  </div>
                  <div>
                    <div className="text-[#5C6670] text-[10.5px]">Blasius Mean Cf̄</div>
                    <div className="font-bold text-emerald-700">{flatPlateEval.laminarMeanCf.toFixed(5)}</div>
                  </div>
                  <div>
                    <div className="text-[#5C6670] text-[10.5px]">Schlichting Local Cf,x</div>
                    <div className="font-bold text-amber-700">{flatPlateEval.turbulentLocalCf.toFixed(5)}</div>
                  </div>
                  <div>
                    <div className="text-[#5C6670] text-[10.5px]">Schlichting Mean Cf̄</div>
                    <div className="font-bold text-amber-700">{flatPlateEval.turbulentMeanCf.toFixed(5)}</div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-7 p-4 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-2">
                <h3 className="text-sm font-bold text-[#161A1D]">
                  Plate-Averaged Skin Friction Coefficient Cf̄ vs. Reynolds Number
                </h3>
                <D3LearningChart spec={cfChartSpec} ariaLabel="Plate-Averaged Skin Friction Chart" />
              </div>
            </div>

            {/* Concept Verification Check */}
            <div className="p-4 sm:p-5 rounded-xl bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
                <div className="flex items-center gap-2">
                  <GraduationCap weight="duotone" className="w-5 h-5 text-[#1769AA]" />
                  <h3 className="text-base font-bold text-[#161A1D]">
                    Engineering Verification Check ({correctCount} / {QUIZ_QUESTIONS.length} Verified)
                  </h3>
                </div>
                {answeredCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setQuizAnswers({})}
                    className="text-xs font-semibold text-[#1769AA] hover:underline cursor-pointer"
                  >
                    Reset Answers
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4">
                {QUIZ_QUESTIONS.map((q, idx) => {
                  const chosen = quizAnswers[q.id];
                  const isAnswered = chosen !== undefined;
                  const isCorrect = chosen === q.correctIndex;

                  return (
                    <div
                      key={q.id}
                      className="p-4 rounded-xl bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono font-semibold text-[#1769AA]">
                          Question {idx + 1} · {q.topic}
                        </span>
                        {isAnswered && (
                          <span
                            className={`text-xs font-semibold flex items-center gap-1 ${
                              isCorrect ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {isCorrect ? (
                              <>
                                <CheckCircle weight="fill" className="w-4 h-4" />
                                <span>Correct</span>
                              </>
                            ) : (
                              <>
                                <XCircle weight="fill" className="w-4 h-4" />
                                <span>Review Derivation</span>
                              </>
                            )}
                          </span>
                        )}
                      </div>

                      <p className="text-sm font-semibold text-[#161A1D]">{q.prompt}</p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {q.options.map((opt, optIdx) => {
                          const selected = chosen === optIdx;
                          const rightOpt = optIdx === q.correctIndex;
                          let cls =
                            'bg-[var(--surface)] border-[var(--border)] text-[#161A1D] hover:border-[#1769AA]';
                          if (isAnswered) {
                            if (rightOpt) {
                              cls = 'bg-emerald-50 border-emerald-400 text-emerald-950 font-semibold';
                            } else if (selected) {
                              cls = 'bg-red-50 border-red-400 text-red-950';
                            } else {
                              cls = 'bg-[var(--surface)] border-[var(--border)] text-[#5C6670]';
                            }
                          }
                          return (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setQuizAnswers((prev) => ({ ...prev, [q.id]: optIdx }))}
                              className={`p-2.5 rounded-lg border text-left text-xs transition-colors cursor-pointer ${cls}`}
                            >
                              {opt}
                            </button>
                          );
                        })}
                      </div>

                      {isAnswered && (
                        <div className="text-xs text-[#5C6670] bg-[var(--surface)] border border-[var(--border)] rounded-lg p-2.5 leading-relaxed">
                          <strong className="text-[#161A1D]">Derivation: </strong>
                          {q.explanation}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
