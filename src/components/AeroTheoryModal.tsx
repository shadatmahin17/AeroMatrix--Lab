import React, { useState } from 'react';
import {
  X,
  BookOpenText,
  CompassRose,
  Warning,
  Wind,
  Lightning,
  Eye,
  FileText,
  FileCode,
  FilePdf,
  CheckCircle,
} from '@phosphor-icons/react';
import { AeroTelemetry, SimulationParams } from '../types/aerodynamics';
import { AIRCRAFT_MODELS } from '../utils/airfoilGenerators';
import {
  downloadEngineeringJsonReport,
  downloadEngineeringMarkdownReport,
  downloadEngineeringPdfReport,
  ensurePdfFontsLoaded,
} from '../utils/engineeringReport';

interface AeroTheoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  telemetry: AeroTelemetry;
  params: SimulationParams;
  onParamChange: <K extends keyof SimulationParams>(key: K, value: SimulationParams[K]) => void;
  labMode: '3d' | '2d';
}

export const AeroTheoryModal: React.FC<AeroTheoryModalProps> = ({
  isOpen,
  onClose,
  telemetry,
  params,
  onParamChange,
  labMode,
}) => {
  const [reportMsg, setReportMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const modelCfg = AIRCRAFT_MODELS[params.modelType];
  const flashMsg = (msg: string) => {
    setReportMsg(msg);
    setTimeout(() => setReportMsg(null), 3000);
  };

  const annotationControls: Array<{
    key:
      | 'show_stagnation_annotation'
      | 'show_transition_annotation'
      | 'show_separation_annotation'
      | 'show_vortex_filaments'
      | 'show_downwash_vectors';
    label: string;
    liveValue: string;
    swatch: string;
  }> = [
    {
      key: 'show_stagnation_annotation',
      label: 'Stagnation Point',
      liveValue: `x_stag = ${(telemetry.stagnationXc * 100).toFixed(1)}% c`,
      swatch: 'bg-amber-500',
    },
    {
      key: 'show_transition_annotation',
      label: 'Transition Line (x_tr)',
      liveValue: `x_tr = ${(telemetry.xTransitionUpper * 100).toFixed(0)}% c`,
      swatch: 'bg-emerald-500',
    },
    {
      key: 'show_separation_annotation',
      label: 'Separation Onset (x_sep)',
      liveValue:
        telemetry.xSeparationUpper < 0.995
          ? `x_sep = ${(telemetry.xSeparationUpper * 100).toFixed(1)}% c`
          : 'Attached (100% c)',
      swatch: 'bg-red-500',
    },
    {
      key: 'show_vortex_filaments',
      label: 'Bound Vortex Filaments',
      liveValue: `Γ₀ = ${telemetry.ellipticRootCirculation_m2_s.toFixed(1)} m²/s`,
      swatch: 'bg-sky-400',
    },
    {
      key: 'show_downwash_vectors',
      label: 'Downwash Vectors (ε)',
      liveValue: `ε = ${telemetry.downwashAngle_deg.toFixed(2)}°`,
      swatch: 'bg-cyan-400',
    },
  ];

  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-[440px] md:w-[480px] bg-[var(--surface)] border-l border-[var(--border)] shadow-2xl flex flex-col"
      role="dialog"
      aria-label="Aerodynamics Theory and Verification Lab"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--surface)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpenText weight="duotone" className="w-5 h-5 text-[#1769AA] shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-[#161A1D] tracking-wide font-sans truncate">
              Theory &amp; Verification Lab
            </h2>
            <p className="text-[10px] font-mono text-[#5C6670] truncate">
              {labMode === '3d' ? telemetry.solverModel : 'Incompressible GPU D2Q9 LBM Solver'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-[#5C6670] hover:text-[#161A1D] hover:bg-[var(--bg)] transition-colors shrink-0 cursor-pointer"
          aria-label="Collapse theory drawer"
        >
          <X weight="bold" className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="px-4 py-3.5 overflow-y-auto overscroll-contain space-y-3.5 text-xs text-[#5C6670] leading-relaxed font-sans custom-scrollbar flex-1">
        {/* 1. Interactive 3D/2D Visual Annotations */}
        <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[#161A1D] font-bold">
              <Eye weight="duotone" className="w-4 h-4 text-[#1769AA]" />
              <span>3D / 2D Tunnel Annotations</span>
            </div>
            <button
              type="button"
              onClick={() => {
                const allOn = annotationControls.every((c) => Boolean(params[c.key]));
                annotationControls.forEach((c) => onParamChange(c.key, !allOn));
              }}
              className="text-[10.5px] font-mono font-semibold text-[#1769AA] hover:underline cursor-pointer"
            >
              {annotationControls.every((c) => Boolean(params[c.key])) ? 'Hide All' : 'Show All'}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-1.5">
            {annotationControls.map((item) => {
              const active = Boolean(params[item.key]);
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onParamChange(item.key, !active)}
                  className={`w-full px-2.5 py-1.5 rounded-lg border text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[var(--surface)] border-[#1769AA] text-[#161A1D]'
                      : 'bg-[var(--surface)]/60 border-[var(--border)] text-[#5C6670] hover:border-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-2 font-semibold text-[11px]">
                    <span className={`w-2 h-2 rounded-full ${item.swatch} shrink-0`} />
                    <span>{item.label}</span>
                  </span>
                  <span className="font-mono tabular-nums text-[10px] text-[#1769AA]">
                    {item.liveValue} · {active ? 'ON' : 'OFF'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2. Live Governing Equations Synced to Telemetry */}
        <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[#1769AA] font-bold">
              <CompassRose weight="duotone" className="w-4 h-4" />
              <span>Live Governing Equations (SI)</span>
            </div>
            <span className="font-mono tabular-nums text-[10px] text-[#5C6670]">
              {modelCfg.name.split(' (')[0]}
            </span>
          </div>

          {/* Equation 1: Bernoulli + Prandtl-Glauert */}
          <div className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[#161A1D]">1. Bernoulli &amp; Prandtl–Glauert</span>
              <span className="font-mono text-[10px] text-[#1769AA]">
                {telemetry.compressibilityRegime}
              </span>
            </div>
            <div className="font-mono text-[11px] text-[#161A1D]">
              Cp,corr = [1 − (V/V∞)²] / √(1 − M∞²)
            </div>
            <div className="font-mono tabular-nums text-[10.5px] text-[#5C6670]">
              q∞ = {telemetry.dynamic_pressure_pa.toLocaleString()} Pa · M∞ = {telemetry.mach.toFixed(3)} · β⁻¹ = ×
              {telemetry.prandtlGlauertFactor.toFixed(3)} · Lp = {telemetry.pressureLiftCheck_N.toLocaleString()} N
            </div>
          </div>

          {/* Equation 2: Inferred vs Elliptic Circulation */}
          <div className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[#161A1D]">2. Equivalent vs. Vortex-Model Circulation</span>
              <span className="font-mono text-[10px] text-emerald-700">
                |ΔCp(1)| = {telemetry.kuttaTeDeltaCp.toFixed(4)}
              </span>
            </div>
            <div className="font-mono text-[11px] text-[#161A1D]">
              Γ_eq = ½·V∞·c·CL &nbsp;|&nbsp; Γ₀ = (2/π)·V∞·c·CL
            </div>
            <div className="font-mono tabular-nums text-[10.5px] text-[#5C6670]">
              Γ_eq = <b className="text-[#161A1D]">{telemetry.equivalentCirculation_m2_s.toFixed(1)} m²/s</b> (inferred from CL) · Γ₀ ={' '}
              <b className="text-[#1769AA]">{telemetry.ellipticRootCirculation_m2_s.toFixed(1)} m²/s</b> (elliptic peak)
            </div>
            <div className="text-[10px] text-[#5C6670]">
              Note: L = ρ·V∞·Γ_eq·b = {telemetry.kuttaLift_N.toLocaleString()} N is an algebraic consistency identity with CL, not an independent solver check.
            </div>
          </div>

          {/* Equation 3: Prandtl Lifting-Line & Biot-Savart */}
          <div className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[#161A1D]">3. Biot–Savart &amp; Prandtl Lifting-Line</span>
              <span className="font-mono text-[10px] text-[#1769AA]">
                AR {telemetry.aspectRatio.toFixed(2)} · e {telemetry.oswaldEfficiency.toFixed(2)}
              </span>
            </div>
            <div className="font-mono text-[11px] text-[#161A1D]">
              αi = CL / (π·e·AR), &nbsp; ε = 2αi, &nbsp; CDi = CL² / (π·e·AR)
            </div>
            <div className="font-mono tabular-nums text-[10.5px] text-[#5C6670]">
              αi = {telemetry.inducedAlpha_deg.toFixed(2)}° · ε = {telemetry.downwashAngle_deg.toFixed(2)}° · CDi ={' '}
              <b className="text-[#1769AA]">{telemetry.cdi.toFixed(4)}</b>
            </div>
          </div>

          {/* Equation 4: Empirical Flat-Plate Skin Friction & Stall */}
          <div className="p-2.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-[#161A1D]">4. Empirical BL &amp; Flat-Plate Cf Ref</span>
              <span className="font-mono text-[10px] text-amber-700">
                {telemetry.boundaryLayerRegime}
              </span>
            </div>
            <div className="font-mono text-[11px] text-[#161A1D]">
              Local: Cf,x = 0.664/√Re_x | 0.0592/Re_x⁰·² · Mean: Cf̄ = 1.328/√Re | 0.074/Re⁰·²
            </div>
            <div className="font-mono tabular-nums text-[10.5px] text-[#5C6670]">
              Re = {telemetry.reynolds.toExponential(2)} · Cf̄_lam = {telemetry.laminarFlatPlateCfMean.toFixed(4)} · Cf̄_turb ={' '}
              {telemetry.turbulentFlatPlateCfMean.toFixed(4)}
            </div>
            <div className="font-mono tabular-nums text-[10.5px] text-[#5C6670]">
              Empirical est.: x_tr = {(telemetry.xTransitionUpper * 100).toFixed(0)}% · x_sep ={' '}
              {(telemetry.xSeparationUpper * 100).toFixed(1)}% · Flat-plate CD,f ={' '}
              <b className="text-[#161A1D]">{telemetry.skinFrictionDrag_cdf.toFixed(5)}</b>
            </div>
          </div>
        </div>

        {/* 3. Downloadable Engineering Report */}
        <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[#161A1D] font-bold">
              <Wind weight="duotone" className="w-4 h-4 text-[#1769AA]" />
              <span>Export Engineering Report</span>
            </div>
            {reportMsg && (
              <span className="text-[10px] font-mono text-emerald-700 flex items-center gap-1">
                <CheckCircle weight="duotone" className="w-3.5 h-3.5" />
                <span>{reportMsg}</span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#5C6670]">
            Generates a complete ISA flight summary, solver transparency statement, dimensionless numbers, force/drag decompositions, boundary-layer metrics, and NACA benchmark deviations.
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => {
                downloadEngineeringMarkdownReport(params.modelType, params, telemetry);
                flashMsg('Markdown Saved');
              }}
              className="px-2 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <FileText weight="duotone" className="w-3.5 h-3.5 text-[#1769AA]" />
              <span>.MD</span>
            </button>
            <button
              type="button"
              onClick={() => {
                downloadEngineeringJsonReport(params.modelType, params, telemetry);
                flashMsg('JSON Saved');
              }}
              className="px-2 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[#1769AA] text-[#161A1D] text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <FileCode weight="duotone" className="w-3.5 h-3.5 text-amber-600" />
              <span>.JSON</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  await ensurePdfFontsLoaded();
                  downloadEngineeringPdfReport(params.modelType, params, telemetry);
                  flashMsg('PDF Saved');
                })();
              }}
              className="px-2 py-2 rounded-lg bg-[#1769AA] hover:bg-[#145a92] text-white text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <FilePdf weight="duotone" className="w-3.5 h-3.5" />
              <span>.PDF</span>
            </button>
          </div>
        </div>

        {/* 4. Physical Validity & Compressibility Notes */}
        <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--border)] space-y-1.5">
          <div className="flex items-center gap-1.5 text-amber-700 font-bold">
            <Lightning weight="duotone" className="w-4 h-4" />
            <span>Regime Validity &amp; Solver Transparency</span>
          </div>
          <p className="text-[11px] text-[#5C6670]">
            The 3D workstation runs a <strong className="text-[#161A1D]">Reduced-Order Biot–Savart Vortex-Lattice &amp; Surface-Constraint Model</strong> (not a 3D Navier–Stokes RANS/LES solver). Prandtl–Glauert compressibility scaling holds for <span className="font-mono">0.3 &lt; M ≤ 0.7</span>; continuum assumptions hold for <span className="font-mono">Kn ≤ 0.01</span>.
          </p>
          {!telemetry.continuumValid && (
            <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-[10.5px] flex items-start gap-1.5">
              <Warning weight="duotone" className="w-4 h-4 shrink-0 mt-0.5" />
              <span>Kn = {telemetry.knudsen.toExponential(2)} exceeds 0.01 continuum threshold.</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
