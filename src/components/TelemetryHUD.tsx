import React, { useState, useRef, useEffect } from 'react';
import { AeroTelemetry, AircraftModelType, SimulationParams } from '../types/aerodynamics';
import {
  downloadTelemetryJSON,
  downloadTelemetryCSV,
  ExportDataPayload,
} from '../utils/telemetryExport';
import {
  downloadEngineeringMarkdownReport,
  downloadEngineeringPdfReport,
} from '../utils/engineeringReport';
import {
  Gauge,
  Wind,
  Pulse,
  ArrowUpRight,
  ShieldWarning,
  CheckCircle,
  DownloadSimple,
  ArrowDown,
  ArrowUp,
  SlidersHorizontal,
  CaretDown,
  CaretUp,
  Flame,
  FileCode,
  FileCsv,
  FileText,
  FilePdf,
  WarningCircle,
} from '@phosphor-icons/react';

interface TelemetryHUDProps {
  telemetry: AeroTelemetry;
  aoaDeg: number;
  modelType: AircraftModelType;
  params: SimulationParams;
}

export const TelemetryHUD: React.FC<TelemetryHUDProps> = ({
  telemetry,
  aoaDeg,
  modelType,
  params,
}) => {
  const [showPhysicsDetails, setShowPhysicsDetails] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };
    if (showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showExportMenu]);

  const formatForce = (newtons: number) => {
    if (Math.abs(newtons) >= 1e6) return `${(newtons / 1e6).toFixed(2)} MN`;
    if (Math.abs(newtons) >= 1e3) return `${(newtons / 1e3).toFixed(1)} kN`;
    return `${newtons} N`;
  };

  const formatSci = (val: number, digits = 2) => {
    if (val === 0) return '0';
    return val.toExponential(digits);
  };

  const suctionPercentage = telemetry.suctionPercentage;
  const compressionPercentage = telemetry.compressionPercentage;

  // Drag component shares for proportional decomposition bar
  const totalCdSafe = Math.max(1e-5, telemetry.cd0 + telemetry.cdi + telemetry.cdSep + telemetry.cdWave);
  const cd0Pct = (telemetry.cd0 / totalCdSafe) * 100;
  const cdiPct = (telemetry.cdi / totalCdSafe) * 100;
  const cdSepPct = (telemetry.cdSep / totalCdSafe) * 100;
  const cdWavePct = (telemetry.cdWave / totalCdSafe) * 100;

  const exportPayload: ExportDataPayload = {
    telemetry,
    aoaDeg,
    modelType,
    params,
    suctionPercentage,
    compressionPercentage,
    downwashDeg: telemetry.downwashAngle_deg,
  };

  const handleExportJSON = () => {
    downloadTelemetryJSON(exportPayload);
    setExportSuccessMsg('JSON Snapshot Saved');
    setShowExportMenu(false);
    setTimeout(() => {
      setExportSuccessMsg(null);
    }, 3500);
  };

  const handleExportCSV = () => {
    downloadTelemetryCSV(exportPayload);
    setExportSuccessMsg('CSV Dataset Saved');
    setShowExportMenu(false);
    setTimeout(() => {
      setExportSuccessMsg(null);
    }, 3500);
  };

  return (
    <div className="w-full flex flex-col gap-3">
      {/* HUD Header Toolbar */}
      <div className="flex flex-col gap-1 px-0.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Pulse weight="duotone" className="w-4 h-4 text-[#1769AA] shrink-0" />
            <span className="text-xs font-bold uppercase tracking-wider text-[#161A1D] truncate">
              Telemetry &amp; Forces
            </span>
            {exportSuccessMsg && (
              <span className="ml-1 text-[10px] font-mono text-emerald-700 flex items-center gap-1 shrink-0">
                <CheckCircle weight="duotone" className="w-3.5 h-3.5 text-emerald-600" />
                <span>{exportSuccessMsg}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowPhysicsDetails((prev) => !prev)}
              className="px-2 py-1 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[#1769AA] text-[11px] font-semibold text-[#161A1D] flex items-center gap-1 transition-colors shadow-sm cursor-pointer whitespace-nowrap"
              title="Toggle first-principles physics decomposition"
            >
              <SlidersHorizontal weight="duotone" className="w-3.5 h-3.5 text-[#1769AA]" />
              <span>{showPhysicsDetails ? 'Compact' : 'Breakdown'}</span>
              {showPhysicsDetails ? (
                <CaretUp weight="bold" className="w-3 h-3 text-[#5C6670]" />
              ) : (
                <CaretDown weight="bold" className="w-3 h-3 text-[#5C6670]" />
              )}
            </button>

            {/* Dedicated Export Dropdown Menu */}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setShowExportMenu((prev) => !prev)}
                className="px-2.5 py-1 rounded-lg bg-[#1769AA] hover:bg-[#145a92] text-white text-[11px] font-semibold flex items-center gap-1.5 transition-colors shadow-sm cursor-pointer whitespace-nowrap"
                title="Export flight telemetry and aerodynamic dataset"
                aria-expanded={showExportMenu}
                aria-haspopup="true"
              >
                <DownloadSimple weight="bold" className="w-3.5 h-3.5" />
                <span>Export</span>
                <CaretDown
                  weight="bold"
                  className={`w-3 h-3 text-white/80 transition-transform duration-200 ${
                    showExportMenu ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {showExportMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-60 max-w-[calc(100vw-2rem)] rounded-xl bg-[var(--surface)] border border-[var(--border)] shadow-xl p-1.5 z-50 flex flex-col gap-1">
                  <div className="px-2 py-1 border-b border-[var(--border)]">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-[#5C6670]">
                      Export Flight Data
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleExportJSON}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--bg)] flex items-start gap-2.5 text-[#161A1D] group transition-colors cursor-pointer"
                  >
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/18 to-orange-500/10 ring-1 ring-amber-500/25 flex items-center justify-center text-amber-700 shrink-0">
                      <FileCode weight="duotone" className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[#161A1D] flex items-center gap-1.5">
                        JSON Snapshot
                        <span className="text-[10px] font-mono text-amber-700">.json</span>
                      </span>
                      <span className="text-[10px] text-[#5C6670] leading-tight">
                        Full ISA state, force breakdown &amp; polar sweep
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={handleExportCSV}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--bg)] flex items-start gap-2.5 text-[#161A1D] group transition-colors cursor-pointer"
                  >
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500/18 to-teal-500/10 ring-1 ring-emerald-500/25 flex items-center justify-center text-emerald-700 shrink-0">
                      <FileCsv weight="duotone" className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[#161A1D] flex items-center gap-1.5">
                        CSV Dataset
                        <span className="text-[10px] font-mono text-emerald-700">.csv</span>
                      </span>
                      <span className="text-[10px] text-[#5C6670] leading-tight">
                        Spreadsheet table with metrics &amp; AoA sweep
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      downloadEngineeringMarkdownReport(modelType, params, telemetry);
                      setExportSuccessMsg('Engineering Report (.md) Saved');
                      setShowExportMenu(false);
                      setTimeout(() => setExportSuccessMsg(null), 3500);
                    }}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--bg)] flex items-start gap-2.5 text-[#161A1D] group transition-colors cursor-pointer"
                  >
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#1769AA]/18 to-sky-500/10 ring-1 ring-[#1769AA]/25 flex items-center justify-center text-[#1769AA] shrink-0">
                      <FileText weight="duotone" className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[#161A1D] flex items-center gap-1.5">
                        Engineering Report
                        <span className="text-[10px] font-mono text-[#1769AA]">.md</span>
                      </span>
                      <span className="text-[10px] text-[#5C6670] leading-tight">
                        ISA state, assumptions &amp; NACA deviations
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      downloadEngineeringPdfReport(modelType, params, telemetry);
                      setExportSuccessMsg('Engineering Report (.pdf) Saved');
                      setShowExportMenu(false);
                      setTimeout(() => setExportSuccessMsg(null), 3500);
                    }}
                    className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--bg)] flex items-start gap-2.5 text-[#161A1D] group transition-colors cursor-pointer"
                  >
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500/18 to-red-500/10 ring-1 ring-rose-500/25 flex items-center justify-center text-rose-700 shrink-0">
                      <FilePdf weight="duotone" className="w-4 h-4" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-semibold text-[#161A1D] flex items-center gap-1.5">
                        Engineering Report
                        <span className="text-[10px] font-mono text-rose-700">.pdf</span>
                      </span>
                      <span className="text-[10px] text-[#5C6670] leading-tight">
                        Downloadable A4 aerospace verification PDF
                      </span>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Explicit Reduced-Order Solver Transparency Label */}
        <p className="text-[10.5px] font-mono text-[#5C6670] leading-snug">
          <span className="sm:hidden">Solver: Reduced-Order Biot–Savart VLM</span>
          <span className="hidden sm:inline">Solver: {telemetry.solverModel}</span>
        </p>
      </div>

      {/* Physical Regime Guardrails (Mach & Knudsen) */}
      {telemetry.regimeWarnings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {telemetry.regimeWarnings.map((w) => {
            const isCritical = w.severity === 'critical';
            const isWarn = w.severity === 'warning';
            return (
              <div
                key={w.code}
                className={`p-2.5 rounded-lg border text-[11px] leading-snug flex items-start gap-2 ${
                  isCritical
                    ? 'bg-red-50 border-red-300 text-red-900'
                    : isWarn
                    ? 'bg-amber-50 border-amber-300 text-amber-900'
                    : 'bg-sky-50 border-sky-200 text-sky-900'
                }`}
              >
                <WarningCircle
                  weight="duotone"
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    isCritical ? 'text-red-600' : isWarn ? 'text-amber-600' : 'text-[#1769AA]'
                  }`}
                />
                <div className="min-w-0">
                  <div className="font-semibold font-mono tabular-nums">
                    {isCritical ? '✖ ' : isWarn ? '▲ ' : '● '}
                    {w.title}
                  </div>
                  <div className="text-[10.5px] opacity-90 mt-0.5">{w.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 6 Primary Telemetry Metric Cards */}
      <div className="w-full grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
        {/* 1. Lift Coefficient (CL) */}
        <div className="antigravity-card p-2.5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Lift Coeff
            </span>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#1769AA]/16 to-[#0EA5E9]/14 ring-1 ring-[#1769AA]/20 flex items-center justify-center text-[#1769AA]">
              <ArrowUpRight weight="bold" className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-lg sm:text-2xl font-bold tracking-tight text-[#161A1D] font-mono tabular-nums">
              {telemetry.cl.toFixed(3)}
            </span>
            <span className="text-[11px] font-mono text-[#1769AA] font-bold">CL</span>
          </div>
          <div className="text-[10px] text-[#5C6670] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span>Force:</span>
            <span className="font-mono tabular-nums text-[#1769AA] font-semibold">
              {formatForce(telemetry.lift_N)}
            </span>
          </div>
        </div>

        {/* 2. Drag Coefficient (CD) */}
        <div className="antigravity-card p-2.5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Drag Coeff
            </span>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-amber-500/18 to-orange-500/12 ring-1 ring-amber-500/25 flex items-center justify-center text-amber-700">
              <Wind weight="duotone" className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-lg sm:text-2xl font-bold tracking-tight text-[#161A1D] font-mono tabular-nums">
              {telemetry.cd.toFixed(4)}
            </span>
            <span className="text-[11px] font-mono text-amber-700 font-bold">CD</span>
          </div>
          <div className="text-[10px] text-[#5C6670] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span>Force:</span>
            <span className="font-mono tabular-nums text-amber-700 font-semibold">
              {formatForce(telemetry.drag_N)}
            </span>
          </div>
        </div>

        {/* 3. Aerodynamic Efficiency (L/D) */}
        <div className="antigravity-card p-2.5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Efficiency
            </span>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-emerald-500/18 to-teal-500/12 ring-1 ring-emerald-500/25 flex items-center justify-center text-emerald-700">
              <Pulse weight="duotone" className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-lg sm:text-2xl font-bold tracking-tight text-emerald-700 font-mono tabular-nums">
              {telemetry.ldRatio.toFixed(1)}
            </span>
            <span className="text-[11px] font-mono text-emerald-700 font-bold">L/D</span>
          </div>
          <div className="text-[10px] text-[#5C6670] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span>Glide:</span>
            <span className="font-mono tabular-nums text-emerald-700 font-semibold">
              {telemetry.ldRatio > 0 ? `${telemetry.ldRatio.toFixed(1)}:1` : '0:1'}
            </span>
          </div>
        </div>

        {/* 4. Speed & Mach Regime */}
        <div className="antigravity-card p-2.5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Mach &amp; V∞
            </span>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#1769AA]/16 to-[#0EA5E9]/14 ring-1 ring-[#1769AA]/20 flex items-center justify-center text-[#1769AA]">
              <Gauge weight="duotone" className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span
              className={`text-lg sm:text-2xl font-bold tracking-tight font-mono tabular-nums ${
                telemetry.mach >= 0.7 ? 'text-amber-700' : 'text-[#161A1D]'
              }`}
            >
              M {telemetry.mach.toFixed(3)}
            </span>
          </div>
          <div className="text-[10px] text-[#5C6670] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span>{telemetry.airspeed_ms.toFixed(1)} m/s</span>
            <span className="font-mono tabular-nums text-[#1769AA] font-semibold">
              {params.airspeed_kts} kts
            </span>
          </div>
        </div>

        {/* 5. Dynamic Pressure (q) */}
        <div className="antigravity-card p-2.5 rounded-xl flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Dyn Pressure
            </span>
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-slate-500/12 to-slate-400/8 ring-1 ring-slate-300/70 flex items-center justify-center text-[#475569]">
              <Flame weight="duotone" className="w-3.5 h-3.5" />
            </div>
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span className="text-lg sm:text-2xl font-bold tracking-tight text-[#161A1D] font-mono tabular-nums">
              {(telemetry.dynamic_pressure_pa / 1000).toFixed(2)}
            </span>
            <span className="text-[11px] font-mono text-[#5C6670] font-bold">kPa</span>
          </div>
          <div className="text-[10px] text-[#5C6670] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span>{(telemetry.altitude_m / 1000).toFixed(2)} km</span>
            <span className="font-mono tabular-nums text-[#161A1D] font-medium">
              {params.altitude_ft.toLocaleString()} ft
            </span>
          </div>
        </div>

        {/* 6. Flow State & Stall Margin */}
        <div
          className={`antigravity-card p-2.5 rounded-xl flex flex-col justify-between ${
            telemetry.isStalled
              ? '!border-red-300 !bg-red-50'
              : telemetry.stallMargin < 4
              ? '!border-amber-300 !bg-amber-50'
              : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider font-sans text-[#5C6670]">
              Flow State
            </span>
            {telemetry.isStalled ? (
              <ShieldWarning weight="duotone" className="w-4 h-4 text-red-600" />
            ) : (
              <CheckCircle weight="duotone" className="w-4 h-4 text-emerald-600" />
            )}
          </div>
          <div className="my-1.5 flex items-baseline gap-1">
            <span
              className={`text-sm sm:text-base font-bold tracking-tight font-sans truncate ${
                telemetry.isStalled ? 'text-red-700' : 'text-[#161A1D]'
              }`}
            >
              {telemetry.flowState}
            </span>
          </div>
          <div className="text-[10px] flex items-center justify-between pt-1.5 border-t border-[var(--border)]">
            <span className="text-[#5C6670]">Stall Margin:</span>
            <span
              className={`font-mono tabular-nums font-semibold ${
                telemetry.stallMargin <= 0
                  ? 'text-red-700'
                  : telemetry.stallMargin < 3
                  ? 'text-amber-700'
                  : 'text-emerald-700'
              }`}
            >
              {telemetry.stallMargin > 0
                ? `+${telemetry.stallMargin.toFixed(1)}°`
                : `${telemetry.stallMargin.toFixed(1)}°`}
            </span>
          </div>
        </div>
      </div>

      {/* FIRST-PRINCIPLES PHYSICS BREAKDOWN PANEL */}
      {showPhysicsDetails && (
        <div className="antigravity-glass p-3 sm:p-3.5 rounded-xl flex flex-col gap-3">
          {/* A. Surface Cp Integration (Upper vs Lower Lift) */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-1 border-b border-[var(--border)] pb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <ArrowUp weight="bold" className="w-3.5 h-3.5 text-[#1769AA] shrink-0" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#161A1D] truncate">
                  {telemetry.surfacePressureSplitMode === 'integrated-surrogate-cp'
                    ? 'Integrated Surrogate Cp'
                    : 'Illustrative Pressure Split'}
                </span>
              </div>
              <span className="text-[10.5px] font-mono tabular-nums text-[#1769AA] font-semibold shrink-0">
                ∫ΔCp dx = {(telemetry.clUpper + telemetry.clLower).toFixed(3)}
              </span>
            </div>

            <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-[var(--bg)] border border-[var(--border)]">
              <div
                style={{ width: `${suctionPercentage}%` }}
                className={`h-full transition-all duration-200 ${
                  telemetry.isStalled ? 'bg-red-500' : 'bg-[#1769AA]'
                }`}
                title={`Surrogate Upper Surface Contribution: ${suctionPercentage.toFixed(1)}%`}
              />
              <div
                style={{ width: `${compressionPercentage}%` }}
                className="h-full bg-amber-500 transition-all duration-200"
                title={`Surrogate Lower Surface Contribution: ${compressionPercentage.toFixed(1)}%`}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10.5px] font-mono tabular-nums">
              <div className="flex flex-col">
                <span className={telemetry.isStalled ? 'text-red-700 font-semibold' : 'text-[#1769AA] font-semibold'}>
                  CL,upper: {telemetry.clUpper >= 0 ? '+' : ''}
                  {telemetry.clUpper.toFixed(3)} ({suctionPercentage.toFixed(1)}%)
                </span>
                <span className="text-[9.5px] text-[#5C6670] font-sans">
                  {telemetry.surfacePressureSplitMode === 'integrated-surrogate-cp'
                    ? '∫(−Cp,u) d(x/c)'
                    : 'Illustrative upper share'}
                </span>
              </div>
              <div className="flex flex-col text-right">
                <span className="text-amber-700 font-semibold">
                  CL,lower: {telemetry.clLower >= 0 ? '+' : ''}
                  {telemetry.clLower.toFixed(3)} ({compressionPercentage.toFixed(1)}%)
                </span>
                <span className="text-[9.5px] text-[#5C6670] font-sans">
                  {telemetry.surfacePressureSplitMode === 'integrated-surrogate-cp'
                    ? '∫(+Cp,l) d(x/c)'
                    : 'Illustrative lower share'}
                </span>
              </div>
            </div>
          </div>

          {/* B. Equivalent & Vortex-Model Circulation, Lifting-Line Downwash */}
          <div className="pt-2.5 border-t border-[var(--border)] flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#161A1D]">
                Circulation &amp; Finite Wing
              </span>
              <span className="text-[10px] font-mono tabular-nums text-[#5C6670]">
                AR {telemetry.aspectRatio.toFixed(2)} · e {telemetry.oswaldEfficiency.toFixed(2)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10.5px]">
              <div className="p-2 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                <div className="text-[9.5px] text-[#5C6670]">Inferred Γ_eq / Vortex Γ₀</div>
                <div className="font-mono tabular-nums font-bold text-[#161A1D] mt-0.5">
                  {telemetry.equivalentCirculation_m2_s.toFixed(1)} / {telemetry.ellipticRootCirculation_m2_s.toFixed(1)} m²/s
                </div>
                <div className="text-[9.5px] font-mono tabular-nums text-[#5C6670]">
                  Γ_eq=½V∞cCL · Γ₀=(2/π)V∞cCL
                </div>
              </div>

              <div className="p-2 rounded-lg bg-[var(--bg)] border border-[var(--border)]">
                <div className="text-[9.5px] text-[#5C6670] flex items-center gap-1">
                  <ArrowDown weight="bold" className="w-3 h-3 text-[#1769AA]" />
                  <span>αi / Downwash ε</span>
                </div>
                <div className="font-mono tabular-nums font-bold text-[#1769AA] mt-0.5">
                  {telemetry.inducedAlpha_deg.toFixed(2)}° / {telemetry.downwashAngle_deg.toFixed(2)}°
                </div>
                <div className="text-[9.5px] font-mono tabular-nums text-[#5C6670]">
                  ε = 2CL/(π·e·AR) · TE |ΔCp|: {telemetry.kuttaTeDeltaCp.toFixed(4)}
                </div>
              </div>
            </div>
          </div>

          {/* C. Drag Decomposition: CD = CD0 + CDi + CDsep + CDwave */}
          <div className="pt-2.5 border-t border-[var(--border)] flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#161A1D]">
                Drag Decomposition
              </span>
              <span className="text-[10.5px] font-mono tabular-nums font-semibold text-amber-700">
                CD = {telemetry.cd.toFixed(4)}
              </span>
            </div>

            <div className="w-full h-2 rounded-full overflow-hidden flex bg-[var(--bg)] border border-[var(--border)]">
              <div style={{ width: `${cd0Pct}%` }} className="h-full bg-slate-500" title={`CD0: ${telemetry.cd0.toFixed(4)}`} />
              <div style={{ width: `${cdiPct}%` }} className="h-full bg-[#1769AA]" title={`CDi: ${telemetry.cdi.toFixed(4)}`} />
              <div style={{ width: `${cdSepPct}%` }} className="h-full bg-red-500" title={`CDsep: ${telemetry.cdSep.toFixed(4)}`} />
              <div style={{ width: `${cdWavePct}%` }} className="h-full bg-amber-500" title={`CDwave: ${telemetry.cdWave.toFixed(4)}`} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Parasitic CD0:</span>
                <span className="font-semibold text-[#161A1D]">{telemetry.cd0.toFixed(4)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#1769AA]">Induced CDi:</span>
                <span className="font-semibold text-[#1769AA]">{telemetry.cdi.toFixed(4)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-red-700">Separation CDsep:</span>
                <span className="font-semibold text-red-700">{telemetry.cdSep.toFixed(4)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-amber-700">Wave CDwave:</span>
                <span className="font-semibold text-amber-700">{telemetry.cdWave.toFixed(4)}</span>
              </div>
            </div>
          </div>

          {/* D. ISA Atmospheric State & Dimensionless Numbers */}
          <div className="pt-2.5 border-t border-[var(--border)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#161A1D]">
                ISA State &amp; Dimensionless
              </span>
              <span
                className={`text-[10px] font-mono font-semibold ${
                  telemetry.continuumValid ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {telemetry.continuumValid ? '● Continuum Valid' : '✖ Slip/Rarefied'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Re:</span>
                <span className="font-semibold text-[#161A1D]">{formatSci(telemetry.reynolds, 2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Kn:</span>
                <span className="font-semibold text-[#161A1D]">{formatSci(telemetry.knudsen, 2)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">T / P:</span>
                <span className="font-semibold text-[#161A1D]">
                  {telemetry.temperature_K.toFixed(1)}K · {(telemetry.pressure_Pa / 1000).toFixed(1)}kPa
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">ρ / a:</span>
                <span className="font-semibold text-[#161A1D]">
                  {telemetry.air_density_kg_m3.toFixed(3)} · {telemetry.speed_of_sound_ms.toFixed(0)}m/s
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">μ (Suth):</span>
                <span className="font-semibold text-[#161A1D]">
                  {formatSci(telemetry.dynamic_viscosity_Pa_s, 2)} Pa·s
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">PG β⁻¹:</span>
                <span className="font-semibold text-[#1769AA]">
                  ×{telemetry.prandtlGlauertFactor.toFixed(3)}
                </span>
              </div>
            </div>
            <div className="text-[9.5px] font-mono text-[#5C6670] pt-0.5">
              Re Indicator: <span className="text-[#161A1D] font-semibold">{telemetry.reynoldsRegime}</span> (not solved transition)
            </div>
          </div>

          {/* E. Empirical Boundary-Layer & Flat-Plate Reference Estimates */}
          <div className="pt-2.5 border-t border-[var(--border)] flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[#161A1D] truncate">
                Empirical BL &amp; Flat-Plate Ref
              </span>
              <span
                className={`text-[10px] font-mono font-semibold shrink-0 ${
                  telemetry.boundaryLayerRegime === 'Separated'
                    ? 'text-red-700'
                    : telemetry.boundaryLayerRegime === 'Fully Laminar'
                    ? 'text-emerald-700'
                    : 'text-[#1769AA]'
                }`}
              >
                {telemetry.boundaryLayerRegime === 'Separated' ? '▲ ' : '● '}
                {telemetry.boundaryLayerRegime}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums">
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Est. x_tr/c (U/L):</span>
                <span className="font-semibold text-[#161A1D]">
                  {(telemetry.xTransitionUpper * 100).toFixed(0)}% / {(telemetry.xTransitionLower * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Est. x_sep/c (U):</span>
                <span
                  className={`font-semibold ${
                    telemetry.xSeparationUpper < 0.95 ? 'text-red-700' : 'text-emerald-700'
                  }`}
                >
                  {(telemetry.xSeparationUpper * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Flat-Plate CD,f:</span>
                <span className="font-semibold text-[#161A1D]">
                  {telemetry.skinFrictionDrag_cdf.toFixed(5)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#5C6670]">Cf̄ (Lam / Turb):</span>
                <span className="font-semibold text-[#161A1D]">
                  {telemetry.laminarFlatPlateCfMean.toFixed(4)} / {telemetry.turbulentFlatPlateCfMean.toFixed(4)}
                </span>
              </div>
              <div className="col-span-2 flex items-center justify-between">
                <span className="text-[#5C6670]">Est. Stag / Max dCp/dx:</span>
                <span className="font-semibold text-[#161A1D]">
                  {(telemetry.stagnationXc * 100).toFixed(1)}% · {telemetry.maxAdversePressureGrad.toFixed(1)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
