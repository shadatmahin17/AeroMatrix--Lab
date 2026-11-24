import { jsPDF } from 'jspdf';
import { AeroTelemetry, AircraftModelType, SimulationParams } from '../types/aerodynamics';
import {
  AIRCRAFT_MODELS,
  calculateAeroTelemetry,
  computeModelAlphaSweep,
} from './airfoilGenerators';
import { AlphaSweepResult, ISA_CONSTANTS } from '../lib/aeroPhysics';
import { computeBenchmarkDeviation, BenchmarkDeviationMetrics } from '../data/nacaBenchmarks';
import { CANONICAL_COORDINATE_SYSTEM } from '../simulation/contracts/ScientificContracts';
import {
  computeDeterministicHash,
  type ValidationStatus,
} from '../simulation/contracts/SimulationMetadata';

declare const __AEROLAB_LOGO_DATA_URL__: string | undefined;

const EMBEDDED_LOGO_PATH = '/public/aerolab-logo.png';

interface NodeBuiltinFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
}

interface NodeBuiltinPath {
  resolve(...segments: string[]): string;
}

interface NodeProcessLike {
  versions?: { node?: string };
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

function getNodeBuiltin<T>(id: string): T | null {
  if (typeof process === 'undefined') return null;
  const proc = process as unknown as NodeProcessLike;
  if (!proc.versions?.node || typeof proc.getBuiltinModule !== 'function') return null;
  try {
    return (proc.getBuiltinModule(id) as T) ?? null;
  } catch {
    return null;
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

let cachedLogoDataUrl: string =
  typeof __AEROLAB_LOGO_DATA_URL__ === 'string' ? __AEROLAB_LOGO_DATA_URL__ : '';

function getLogoDataUrl(): string {
  if (cachedLogoDataUrl.startsWith('data:image/')) {
    return cachedLogoDataUrl;
  }
  const fsMod = getNodeBuiltin<NodeBuiltinFs>('node:fs');
  const pathMod = getNodeBuiltin<NodeBuiltinPath>('node:path');
  const proc = typeof process !== 'undefined' ? (process as unknown as NodeProcessLike) : null;
  if (fsMod && pathMod && proc?.cwd) {
    const absPath = pathMod.resolve(proc.cwd(), 'public/aerolab-logo.png');
    if (fsMod.existsSync(absPath)) {
      cachedLogoDataUrl = `data:image/png;base64,${uint8ArrayToBase64(fsMod.readFileSync(absPath))}`;
      return cachedLogoDataUrl;
    }
  }
  return cachedLogoDataUrl;
}

interface DejaVuFontCache {
  regularB64: string;
  boldB64: string;
}

let cachedDejaVuFonts: DejaVuFontCache | null = null;
let fontLoadPromise: Promise<void> | null = null;

function tryLoadDejaVuFontsSyncNode(): DejaVuFontCache | null {
  if (cachedDejaVuFonts) return cachedDejaVuFonts;
  const fsMod = getNodeBuiltin<NodeBuiltinFs>('node:fs');
  const pathMod = getNodeBuiltin<NodeBuiltinPath>('node:path');
  const proc = typeof process !== 'undefined' ? (process as unknown as NodeProcessLike) : null;
  if (!fsMod || !pathMod || !proc?.cwd) return null;

  const regPath = pathMod.resolve(proc.cwd(), 'public/fonts/DejaVuSans.ttf');
  const boldPath = pathMod.resolve(proc.cwd(), 'public/fonts/DejaVuSans-Bold.ttf');
  if (fsMod.existsSync(regPath) && fsMod.existsSync(boldPath)) {
    cachedDejaVuFonts = {
      regularB64: uint8ArrayToBase64(fsMod.readFileSync(regPath)),
      boldB64: uint8ArrayToBase64(fsMod.readFileSync(boldPath)),
    };
    return cachedDejaVuFonts;
  }
  return null;
}

/**
 * Preloads /public/fonts/DejaVuSans.ttf and DejaVuSans-Bold.ttf (and /public/aerolab-logo.png
 * if needed) so browser & Web Worker PDF exports render full Greek & mathematical Unicode glyphs.
 */
export async function ensurePdfFontsLoaded(): Promise<void> {
  if (cachedDejaVuFonts) return;
  if (tryLoadDejaVuFontsSyncNode()) return;
  if (fontLoadPromise) return fontLoadPromise;

  fontLoadPromise = (async () => {
    if (typeof fetch !== 'function') return;
    try {
      const [regRes, boldRes] = await Promise.all([
        fetch('/fonts/DejaVuSans.ttf'),
        fetch('/fonts/DejaVuSans-Bold.ttf'),
      ]);
      if (regRes.ok && boldRes.ok) {
        const [regBuf, boldBuf] = await Promise.all([
          regRes.arrayBuffer(),
          boldRes.arrayBuffer(),
        ]);
        cachedDejaVuFonts = {
          regularB64: uint8ArrayToBase64(new Uint8Array(regBuf)),
          boldB64: uint8ArrayToBase64(new Uint8Array(boldBuf)),
        };
      }
      if (!cachedLogoDataUrl.startsWith('data:image/')) {
        const logoRes = await fetch('/aerolab-logo.png');
        if (logoRes.ok) {
          const logoBuf = await logoRes.arrayBuffer();
          cachedLogoDataUrl = `data:image/png;base64,${uint8ArrayToBase64(new Uint8Array(logoBuf))}`;
        }
      }
    } catch {
      // Fallback safely to built-in Helvetica if offline/unavailable
    }
  })();

  return fontLoadPromise;
}

export interface NumericalResidualCheck {
  id: string;
  label: string;
  residual: number;
  unit: string;
  toleranceLabel: string;
  passed: boolean;
  detail: string;
}

export interface EngineeringReportBundle {
  generatedAt: string;
  solverLabel: string;
  solverAssumptions: string[];
  reproducibility: {
    softwareVersion: string;
    engine: string;
    engineVersion: string;
    geometryHash: string;
    inputHash: string;
    coordinateSystem: string;
    numericalPrecision: string;
    meshResolution: string;
    validationStatus: ValidationStatus;
    logoAssetPath: string;
  };
  verificationDistinction: {
    numericalVerification: {
      status: 'verified' | 'unverified';
      summary: string;
      checks: string[];
      residuals: NumericalResidualCheck[];
      quadratureLift_N: number;
      quadratureRelErrorPct: number;
      quadraturePassed: boolean;
    };
    modelValidation: {
      status: 'verified' | 'empirical-only' | 'unvalidated';
      summary: string;
      referenceDataset: string | null;
    };
    operatingApplicability: {
      status: 'within-envelope' | 'regime-limited';
      summary: string;
      warnings: string[];
    };
  };
  model: {
    id: AircraftModelType;
    name: string;
    category: string;
    wingspan_m: number;
    chord_m: number;
    wingArea_m2: number;
    sweepDeg: number;
    aspectRatio: number;
    oswaldEfficiency: number;
    thicknessRatio: number;
    camberRatio: number;
    presetCd0: number;
  };
  flightConditions: {
    angleOfAttack_deg: number;
    flaps_deg: number;
    airspeed_kts: number;
    airspeed_ms: number;
    altitude_ft: number;
    altitude_m: number;
    isaTemperature_K: number;
    isaPressure_Pa: number;
    airDensity_kg_m3: number;
    dynamicViscosity_Pa_s: number;
    speedOfSound_ms: number;
  };
  dimensionless: {
    dynamicPressure_Pa: number;
    reynolds: number;
    reynoldsRegime: string;
    reynoldsRegimeLabel: string;
    mach: number;
    knudsen: number;
    prandtlGlauertFactor: number;
    compressibilityRegime: string;
    continuumValid: boolean;
    regimeWarnings: AeroTelemetry['regimeWarnings'];
  };
  forcesAndCirculation: {
    clAlpha_per_rad: number;
    cl: number;
    equivalentCirculation_m2_s: number;
    ellipticRootCirculation_m2_s: number;
    pressureLiftCheck_N: number;
    lift_N: number;
    drag_N: number;
    ldRatio: number;
    inducedAlpha_deg: number;
    downwashAngle_deg: number;
    dragDecomposition: {
      cdTotal: number;
      cd0Parasitic: number;
      cdiInduced: number;
      cdSeparation: number;
      cdWave: number;
    };
  };
  boundaryLayer: {
    regime: string;
    flowState: string;
    stagnationXc: number;
    xTransitionUpper: number;
    xTransitionLower: number;
    xSeparationUpper: number;
    skinFrictionDrag_cdf: number;
    laminarFlatPlateCfMean: number;
    turbulentFlatPlateCfMean: number;
    maxAdversePressureGrad: number;
    isStalled: boolean;
    stallMargin_deg: number;
  };
  alphaSweepData: AlphaSweepResult;
  benchmarkDeviation: BenchmarkDeviationMetrics | null;
}

function formatUtcIsoNoMillis(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function formatDisplayConfigName(name: string, category: string): string {
  const trimmed = name.trim();
  if (trimmed.includes('(') && trimmed.includes(')')) {
    return trimmed;
  }
  return `${trimmed} (${category})`;
}

export function buildEngineeringReportBundle(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): EngineeringReportBundle {
  const cfg = AIRCRAFT_MODELS[modelType];
  const sweep: Array<{ aoa: number; cl: number; cd: number }> = [];
  for (let a = -12; a <= 22; a += 1) {
    const pt = calculateAeroTelemetry(
      modelType,
      a,
      params.airspeed_kts,
      params.altitude_ft,
      params.flaps_deg
    );
    sweep.push({ aoa: a, cl: pt.cl, cd: pt.cd });
  }
  const benchmarkDeviation = computeBenchmarkDeviation(
    modelType,
    telemetry,
    params.angle_of_attack,
    sweep
  );

  const wingArea_m2 = telemetry.wingArea_m2 ?? cfg.wingArea_m2;
  const meanChord_m = wingArea_m2 / cfg.wingspan;
  const aspectRatio = (cfg.wingspan * cfg.wingspan) / Math.max(1e-4, wingArea_m2);

  const geometryHash = computeDeterministicHash({
    id: cfg.id,
    wingspan: cfg.wingspan,
    wingArea_m2,
    meanChord_m,
    sweepDeg: cfg.sweepDeg,
    oswald: telemetry.oswaldEfficiency,
    thickness: cfg.thicknessRatio,
    camber: cfg.camberRatio ?? 0.0,
  });
  const inputHash = computeDeterministicHash({
    modelType,
    aoa: Number(params.angle_of_attack.toFixed(4)),
    airspeed_kts: params.airspeed_kts,
    altitude_ft: params.altitude_ft,
    flaps_deg: params.flaps_deg,
  });

  // Exact full-precision SI residual checks (Section 8)
  const raw = telemetry.rawSI;
  const rhoRaw = raw?.density_kg_m3 ?? telemetry.air_density_kg_m3;
  const vRaw = raw?.velocity_ms ?? telemetry.airspeed_ms;
  const pRaw = raw?.pressure_Pa ?? telemetry.pressure_Pa;
  const tRaw = raw?.temperature_K ?? telemetry.temperature_K;
  const qRaw = raw?.dynamicPressure_Pa ?? 0.5 * rhoRaw * vRaw * vRaw;
  const clRaw = raw?.cl ?? telemetry.cl;
  const cd0Raw = raw?.cd0 ?? telemetry.cd0;
  const cdiRaw = raw?.cdi ?? telemetry.cdi;
  const cdSepRaw = raw?.cdSep ?? telemetry.cdSep;
  const cdWaveRaw = raw?.cdWave ?? telemetry.cdWave;
  const cdTotalRaw = raw?.cdTotal ?? cd0Raw + cdiRaw + cdSepRaw + cdWaveRaw;
  const alphaIRadRaw =
    raw?.inducedAlpha_rad ?? (telemetry.inducedAlpha_deg * Math.PI) / 180;
  const liftRaw = raw?.lift_N ?? telemetry.lift_N;
  const dragRaw = raw?.drag_N ?? telemetry.drag_N;
  const ldRaw = raw?.ldRatio ?? telemetry.ldRatio;
  const lpRaw = raw?.pressureLiftCheck_N ?? telemetry.pressureLiftCheck_N;
  const machRaw = raw?.mach ?? telemetry.mach;
  const knRaw = raw?.knudsen ?? telemetry.knudsen;

  const qRecomputed = 0.5 * rhoRaw * vRaw * vRaw;
  const resQ = Math.abs(qRaw - qRecomputed);
  const rhoIdeal = pRaw / (ISA_CONSTANTS.R_SPECIFIC_J_KG_K * tRaw);
  const resRho = Math.abs(rhoRaw - rhoIdeal);
  const cdiIdentity = alphaIRadRaw * clRaw;
  const resCdi = Math.abs(cdiRaw - cdiIdentity);
  const dragSum = cd0Raw + cdiRaw + cdSepRaw + cdWaveRaw;
  const resDragSum = Math.abs(cdTotalRaw - dragSum);
  const ldFromForces = dragRaw > 1e-12 ? liftRaw / dragRaw : 0;
  const ldFromCoeffs = cdTotalRaw > 1e-12 ? clRaw / cdTotalRaw : ldRaw;
  const resLD = Math.abs(ldFromForces - ldFromCoeffs);

  const quadratureRelErrorPct =
    Math.abs(liftRaw) > 1e-6
      ? (Math.abs(liftRaw - lpRaw) / Math.abs(liftRaw)) * 100
      : 0;
  const quadraturePassed = quadratureRelErrorPct < 0.1;

  const residuals: NumericalResidualCheck[] = [
    {
      id: 'q-recomputed',
      label: 'Dynamic pressure identity |q_{∞} − ½ρV^{2}|',
      residual: resQ,
      unit: 'Pa',
      toleranceLabel: '< 1e-9',
      passed: resQ < 1e-9,
      detail: `q = ${qRaw.toFixed(2)} Pa vs ½ρV² = ${qRecomputed.toFixed(2)} Pa`,
    },
    {
      id: 'rho-ideal-gas',
      label: 'Ideal-gas density |ρ − P/(RT)|',
      residual: resRho,
      unit: 'kg/m³',
      toleranceLabel: '< 1e-9',
      passed: resRho < 1e-9,
      detail: `ρ = ${rhoRaw.toFixed(6)} vs P/(RT) = ${rhoIdeal.toFixed(6)} kg/m³`,
    },
    {
      id: 'cdi-identity',
      label: 'Induced drag identity |C_{Di} − α_{i}·C_{L}|',
      residual: resCdi,
      unit: '—',
      toleranceLabel: '< 1e-9',
      passed: resCdi < 1e-9,
      detail: `CDi = ${cdiRaw.toFixed(6)} vs αi·CL = ${cdiIdentity.toFixed(6)}`,
    },
    {
      id: 'drag-sum',
      label: 'Drag summation |C_{D} − (C_{D0}+C_{Di}+C_{D,sep}+C_{D,wave})|',
      residual: resDragSum,
      unit: '—',
      toleranceLabel: '< 1e-9',
      passed: resDragSum < 1e-9,
      detail: `CD = ${cdTotalRaw.toFixed(6)} vs ΣCD,k = ${dragSum.toFixed(6)}`,
    },
    {
      id: 'ld-forces-vs-coeff',
      label: 'Force-to-coefficient efficiency |L/D − C_{L}/C_{D}|',
      residual: resLD,
      unit: '—',
      toleranceLabel: '< 1e-9',
      passed: resLD < 1e-9,
      detail: `L/D = ${ldFromForces.toFixed(6)} vs CL/CD = ${ldFromCoeffs.toFixed(6)}`,
    },
  ];

  const allAnalyticalResidualsPass = residuals.every((r) => r.passed);
  const numericalVerified = allAnalyticalResidualsPass && quadraturePassed;

  // Operating applicability computed strictly from M <= 0.70 and Kn <= 0.01
  const applicabilityInEnvelope = machRaw <= 0.7 && knRaw <= 0.01;

  const isWithinVlmEnvelope =
    applicabilityInEnvelope &&
    (telemetry.modelValidity?.isValid ?? true) &&
    !telemetry.isStalled;

  const validationStatus: ValidationStatus = !telemetry.continuumValid
    ? 'failed'
    : numericalVerified && isWithinVlmEnvelope
      ? 'verified'
      : 'unverified';

  const sweepData = computeModelAlphaSweep(
    modelType,
    vRaw,
    telemetry.altitude_m,
    params.flaps_deg
  );

  const sweepLabel = `${cfg.sweepDeg.toFixed(0)}°`;
  const arDisplay = aspectRatio < 3 ? 'AR < 3' : `AR = ${aspectRatio.toFixed(2)}`;

  return {
    generatedAt: formatUtcIsoNoMillis(),
    solverLabel: telemetry.solverModel,
    reproducibility: {
      softwareVersion: 'AeroMatrix-Lab/2.0',
      engine: 'si-physics-vlm-hybrid',
      engineVersion: '2.0.0',
      geometryHash,
      inputHash,
      coordinateSystem: `Nose ${CANONICAL_COORDINATE_SYSTEM.noseAxis}, Up ${CANONICAL_COORDINATE_SYSTEM.upAxis}, Span ${CANONICAL_COORDINATE_SYSTEM.spanAxis} (${CANONICAL_COORDINATE_SYSTEM.units})`,
      numericalPrecision: 'float64 (SI physics) / float32 (84×48×84 SDF & RK2 flow)',
      meshResolution: '84×48×84 SDF + 6-panel horseshoe VLM + 49-station Cp quadrature',
      validationStatus,
      logoAssetPath: EMBEDDED_LOGO_PATH,
    },
    verificationDistinction: {
      numericalVerification: {
        status: numericalVerified ? 'verified' : 'unverified',
        summary: numericalVerified
          ? `All 5 float64 SI identities < 1e-9 and Cp quadrature lift check passed (rel. err ${quadratureRelErrorPct.toFixed(4)}% < 0.1%).`
          : `One or more numerical identity residuals or Cp quadrature check exceeded tolerance (rel. err ${quadratureRelErrorPct.toFixed(4)}%).`,
        checks: [
          ...residuals.map((r) => `${r.detail} (|Δ| = ${r.residual.toExponential(2)})`),
          `Surrogate Cp Quadrature Lift Check: L = ${Math.round(liftRaw).toLocaleString('en-US')} N vs Lp = ${Math.round(lpRaw).toLocaleString('en-US')} N (rel. err ${quadratureRelErrorPct.toFixed(4)}%)`,
        ],
        residuals,
        quadratureLift_N: Math.round(lpRaw),
        quadratureRelErrorPct,
        quadraturePassed,
      },
      modelValidation: {
        status: benchmarkDeviation ? 'verified' : 'empirical-only',
        summary: benchmarkDeviation
          ? `Attached polar RMSE against ${benchmarkDeviation.reference}: ΔCL_RMSE=${benchmarkDeviation.rmseClAttached.toFixed(3)}, ΔCD_RMSE=${benchmarkDeviation.rmseCdAttached.toFixed(4)}.`
          : 'Empirical-only preset calibration; no dedicated wind-tunnel polar dataset overlaid for this airframe.',
        referenceDataset: benchmarkDeviation ? benchmarkDeviation.datasetName : null,
      },
      operatingApplicability: {
        status: applicabilityInEnvelope ? 'within-envelope' : 'regime-limited',
        summary: applicabilityInEnvelope
          ? `Within subsonic continuum envelope (M = ${machRaw.toFixed(3)} ≤ 0.70, Kn = ${knRaw.toExponential(2)} ≤ 0.01).`
          : `Regime-limited outside subsonic continuum envelope (M = ${machRaw.toFixed(3)}, Kn = ${knRaw.toExponential(2)}).`,
        warnings: telemetry.regimeWarnings.map((w) => `${w.title}: ${w.detail}`),
      },
    },
    solverAssumptions: [
      '3D engine is a reduced-order Biot–Savart vortex-lattice with an approximate 84×48×84 SDF surface-constraint model for visual flow rendering. It is **not** a solved 3D Navier–Stokes (RANS/LES) solver.',
      'The SI scientific layer (src/lib/aeroPhysics.ts) governs ISA state (0–20,000 m), Sutherland viscosity, dimensionless parameters, finite-wing metrics and the drag summation.',
      `Lift-curve slope uses the Helmbold/Raymer low-aspect-ratio form with Prandtl–Glauert (β = √(1−M^{2})) and sweep Λ = ${sweepLabel} at max thickness, so C_{L} responds to Mach. Prandtl's unswept lifting-line theory alone is not valid for ${arDisplay}.`,
      'Induced drag: α_{i} = C_{L}/(π e AR); far-wake downwash ε = 2α_{i}; C_{Di} = C_{L}^{2}/(π e AR). Prandtl–Glauert C_{p} = C_{p,0} / √(1 − M^{2}) is applied for 0.3 < M ≤ 0.7; limits above M = 0.7 are flagged.',
      'Equivalent uniform circulation Γ_{eq} = ½ V c̄ C_{L} is inferred from total lift (distinct from the elliptic peak Γ_{0} = (2/π) V c̄ C_{L}) and is not an independent lift proof.',
      'Transition, separation and flat-plate C_{f} values are empirical indicators, not solved boundary-layer PDEs.',
    ],
    model: {
      id: cfg.id,
      name: formatDisplayConfigName(cfg.name, cfg.category),
      category: cfg.category,
      wingspan_m: cfg.wingspan,
      chord_m: meanChord_m,
      wingArea_m2,
      sweepDeg: cfg.sweepDeg,
      aspectRatio,
      oswaldEfficiency: telemetry.oswaldEfficiency,
      thicknessRatio: cfg.thicknessRatio,
      camberRatio: cfg.camberRatio ?? 0.0,
      presetCd0: cfg.cd0,
    },
    flightConditions: {
      angleOfAttack_deg: Number(params.angle_of_attack.toFixed(2)),
      flaps_deg: params.flaps_deg,
      airspeed_kts: params.airspeed_kts,
      airspeed_ms: vRaw,
      altitude_ft: params.altitude_ft,
      altitude_m: telemetry.altitude_m,
      isaTemperature_K: tRaw,
      isaPressure_Pa: pRaw,
      airDensity_kg_m3: rhoRaw,
      dynamicViscosity_Pa_s: telemetry.dynamic_viscosity_Pa_s,
      speedOfSound_ms: telemetry.speed_of_sound_ms,
    },
    dimensionless: {
      dynamicPressure_Pa: qRaw,
      reynolds: telemetry.rawSI?.reynolds ?? telemetry.reynolds,
      reynoldsRegime: telemetry.reynoldsRegime,
      reynoldsRegimeLabel: telemetry.reynoldsRegimeLabel,
      mach: machRaw,
      knudsen: knRaw,
      prandtlGlauertFactor: Number(telemetry.prandtlGlauertFactor.toFixed(3)),
      compressibilityRegime: telemetry.compressibilityRegime,
      continuumValid: telemetry.continuumValid,
      regimeWarnings: telemetry.regimeWarnings,
    },
    forcesAndCirculation: {
      clAlpha_per_rad: raw?.clAlpha_per_rad ?? telemetry.liftCurveSlope_per_rad ?? 0,
      cl: clRaw,
      equivalentCirculation_m2_s: telemetry.equivalentCirculation_m2_s,
      ellipticRootCirculation_m2_s: telemetry.ellipticRootCirculation_m2_s,
      pressureLiftCheck_N: Math.round(lpRaw),
      lift_N: Math.round(liftRaw),
      drag_N: Math.round(dragRaw),
      ldRatio: ldRaw,
      inducedAlpha_deg: (alphaIRadRaw * 180) / Math.PI,
      downwashAngle_deg: (2 * alphaIRadRaw * 180) / Math.PI,
      dragDecomposition: {
        cdTotal: cdTotalRaw,
        cd0Parasitic: cd0Raw,
        cdiInduced: cdiRaw,
        cdSeparation: cdSepRaw,
        cdWave: cdWaveRaw,
      },
    },
    boundaryLayer: {
      regime: telemetry.boundaryLayerRegime,
      flowState: telemetry.flowState,
      stagnationXc: telemetry.stagnationXc,
      xTransitionUpper: telemetry.xTransitionUpper,
      xTransitionLower: telemetry.xTransitionLower,
      xSeparationUpper: telemetry.xSeparationUpper,
      skinFrictionDrag_cdf: telemetry.skinFrictionDrag_cdf,
      laminarFlatPlateCfMean: telemetry.laminarFlatPlateCfMean,
      turbulentFlatPlateCfMean: telemetry.turbulentFlatPlateCfMean,
      maxAdversePressureGrad: telemetry.maxAdversePressureGrad,
      isStalled: telemetry.isStalled,
      stallMargin_deg: telemetry.stallMargin,
    },
    alphaSweepData: sweepData,
    benchmarkDeviation,
  };
}

function stripRichMarkup(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/([A-Za-zα-ωΑ-Ω])_\{([^}]+)\}/g, '$1_$2')
    .replace(/\^\{([^}]+)\}/g, '^$1')
    .replace(/c̄/g, 'c_bar');
}

export function formatEngineeringReportMarkdown(bundle: EngineeringReportBundle): string {
  const {
    model,
    flightConditions,
    dimensionless,
    forcesAndCirculation,
    boundaryLayer,
  } = bundle;

  const pgFactorStr = dimensionless.prandtlGlauertFactor.toFixed(3);
  const reCompact =
    dimensionless.reynolds > 300_000
      ? 'Turbulent-dominated, Re > 3×10⁵'
      : dimensionless.reynolds >= 100_000
        ? 'Transitional, 1×10⁵ ≤ Re ≤ 3×10⁵'
        : 'Laminar-dominated, Re < 1×10⁵';

  const lines: string[] = [
    `# AeroLab Engineering Simulation Report`,
    ``,
    `- **Configuration:** ${model.name}`,
    `- **Generated (UTC):** ${bundle.generatedAt}`,
    `- **Solver:** ${bundle.solverLabel}`,
    ``,
    `## 1. Solver Scope & Physical Assumptions`,
    ...bundle.solverAssumptions.map((a) => `- ${stripRichMarkup(a)}`),
    ``,
    `## 2. Geometry & Reference Planform`,
    `| Parameter | Value |`,
    `| --- | ---: |`,
    `| Wingspan (b) | ${model.wingspan_m.toFixed(2)} m |`,
    `| Reference planform area (S) | ${model.wingArea_m2.toFixed(2)} m² |`,
    `| Mean geometric chord (c̄ = S / b) | ${model.chord_m.toFixed(2)} m |`,
    `| Aspect ratio (AR = b² / S) | ${model.aspectRatio.toFixed(2)} |`,
    `| Sweep at max-thickness line (Λ) | ${model.sweepDeg.toFixed(1)}° |`,
    `| Oswald span efficiency (e) | ${model.oswaldEfficiency.toFixed(3)} |`,
    `| Preset zero-lift drag (C_D0) | ${model.presetCd0.toFixed(4)} |`,
    `| Thickness ratio (t/c) | ${(model.thicknessRatio * 100).toFixed(1)} % |`,
    ``,
    `## 3. Flight Conditions & ISA Atmospheric State (SI, 0 – 20,000 m)`,
    `| Quantity | Value |`,
    `| --- | ---: |`,
    `| Angle of attack (α) / flap deflection (δ_f) | ${flightConditions.angleOfAttack_deg >= 0 ? '+' : ''}${flightConditions.angleOfAttack_deg.toFixed(2)}° / ${flightConditions.flaps_deg.toFixed(1)}° |`,
    `| True airspeed (V_∞) | ${flightConditions.airspeed_ms.toFixed(2)} m/s (${Math.round(flightConditions.airspeed_kts)} kt) |`,
    `| ISA geopotential altitude (h) | ${flightConditions.altitude_m.toFixed(1)} m (${Math.round(flightConditions.altitude_ft).toLocaleString('en-US')} ft) |`,
    `| Static temperature T(h) | ${flightConditions.isaTemperature_K.toFixed(2)} K |`,
    `| Static pressure P(h) | ${Math.round(flightConditions.isaPressure_Pa).toLocaleString('en-US')} Pa |`,
    `| Air density ρ(h) | ${flightConditions.airDensity_kg_m3.toFixed(4)} kg/m³ |`,
    `| Sutherland viscosity μ(T) | ${flightConditions.dynamicViscosity_Pa_s.toExponential(4)} Pa·s |`,
    `| Speed of sound a(T) | ${flightConditions.speedOfSound_ms.toFixed(2)} m/s |`,
    ``,
    `## 4. Dimensionless Parameters & Regime Validity`,
    `| Parameter | Value |`,
    `| --- | ---: |`,
    `| Dynamic pressure (q_∞) | ${Math.round(dimensionless.dynamicPressure_Pa).toLocaleString('en-US')} Pa |`,
    `| Reynolds number (Re) | ${dimensionless.reynolds.toExponential(3)} (${reCompact}) |`,
    `| Mach number (M_∞) | ${dimensionless.mach.toFixed(3)} (${dimensionless.compressibilityRegime}, PG ×${pgFactorStr}) |`,
    `| Prandtl–Glauert factor | ×${pgFactorStr} (Cp = Cp,0 / √(1 − M²)) |`,
    `| Knudsen number (Kn) | ${dimensionless.knudsen.toExponential(3)} (${dimensionless.continuumValid ? 'Continuum valid, Kn ≤ 0.01' : 'Continuum breakdown, Kn > 0.01'}) |`,
    ``,
    `## 5. Force Decomposition, Circulation & Drag`,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Lift-curve slope (C_Lα) | ${forcesAndCirculation.clAlpha_per_rad.toFixed(3)} /rad |`,
    `| Total lift coefficient (C_L) | ${forcesAndCirculation.cl.toFixed(3)} |`,
    `| Total aerodynamic lift (L) | ${forcesAndCirculation.lift_N.toLocaleString('en-US')} N |`,
    `| Induced AoA (α_i) / Downwash (ε = 2α_i) | ${forcesAndCirculation.inducedAlpha_deg.toFixed(2)}° / ${forcesAndCirculation.downwashAngle_deg.toFixed(2)}° |`,
    `| Equivalent circulation (Γ_eq = ½ V c̄ C_L) | ${forcesAndCirculation.equivalentCirculation_m2_s.toFixed(2)} m²/s |`,
    `| Elliptic root circulation (Γ_0 = (2/π) V c̄ C_L) | ${forcesAndCirculation.ellipticRootCirculation_m2_s.toFixed(2)} m²/s |`,
    `| Total drag coefficient (C_D) | ${forcesAndCirculation.dragDecomposition.cdTotal.toFixed(4)} |`,
    `| Drag components (C_D0 / C_Di / C_D,sep / C_D,wave) | ${forcesAndCirculation.dragDecomposition.cd0Parasitic.toFixed(4)} / ${forcesAndCirculation.dragDecomposition.cdiInduced.toFixed(4)} / ${forcesAndCirculation.dragDecomposition.cdSeparation.toFixed(4)} / ${forcesAndCirculation.dragDecomposition.cdWave.toFixed(4)} |`,
    `| Total aerodynamic drag (D) | ${forcesAndCirculation.drag_N.toLocaleString('en-US')} N |`,
    `| Glide efficiency (L/D) | ${forcesAndCirculation.ldRatio.toFixed(2)} |`,
    ``,
    `## 6. Empirical Boundary-Layer & Flat-Plate Estimates`,
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Boundary-layer indicator | ${boundaryLayer.regime} (${boundaryLayer.flowState}) |`,
    `| Blasius laminar mean C_f,lam | ${boundaryLayer.laminarFlatPlateCfMean.toFixed(5)} |`,
    `| Schlichting turbulent mean C_f,turb | ${boundaryLayer.turbulentFlatPlateCfMean.toFixed(5)} |`,
    `| Wing flat-plate skin-friction ref (C_D,f = 2·C_f,turb) | ${boundaryLayer.skinFrictionDrag_cdf.toFixed(5)} |`,
    ``,
    `## 7. Alpha Sweep (0° to 15°, step 0.2°)`,
    `| α (deg) | C_L | C_D | C_Di | L/D |`,
    `| ---: | ---: | ---: | ---: | ---: |`,
    ...[0, 2, 4, 5, 6, 8, 10, 12, 15].map((aTarget) => {
      const pt =
        bundle.alphaSweepData.points.find((p) => Math.abs(p.alphaDeg - aTarget) < 0.05) ??
        bundle.alphaSweepData.points[0];
      return `| ${pt.alphaDeg.toFixed(1)} | ${pt.cl.toFixed(3)} | ${pt.cd.toFixed(4)} | ${pt.cdi.toFixed(4)} | ${pt.ldRatio.toFixed(2)} |`;
    }),
    ``,
    `## 8. Verification, Validation, Applicability & Record`,
    `- **Numerical Verification (${bundle.verificationDistinction.numericalVerification.status}):** ${bundle.verificationDistinction.numericalVerification.summary}`,
    `- **Model Validation (${bundle.verificationDistinction.modelValidation.status}):** ${bundle.verificationDistinction.modelValidation.summary}`,
    `- **Operating Applicability (${bundle.verificationDistinction.operatingApplicability.status}):** ${bundle.verificationDistinction.operatingApplicability.summary}`,
    ``,
    `## 9. Reproducible Record`,
    `- Software / Engine: ${bundle.reproducibility.softwareVersion} / ${bundle.reproducibility.engine} v${bundle.reproducibility.engineVersion}`,
    `- Geometry Hash / Input Hash: \`${bundle.reproducibility.geometryHash}\` / \`${bundle.reproducibility.inputHash}\``,
    `- Coordinate Convention: ${bundle.reproducibility.coordinateSystem}`,
    `- Audit Validation Status: ${bundle.reproducibility.validationStatus}`,
    ``,
  ];

  return lines.join('\n');
}

export function downloadEngineeringMarkdownReport(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): string {
  const bundle = buildEngineeringReportBundle(modelType, params, telemetry);
  const md = formatEngineeringReportMarkdown(bundle);
  const fileName = `aerolab_report_${modelType}_aoa${params.angle_of_attack.toFixed(1)}deg.md`;
  triggerBlobDownload(new Blob([md], { type: 'text/markdown;charset=utf-8' }), fileName);
  return fileName;
}

export function downloadEngineeringJsonReport(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): string {
  const bundle = buildEngineeringReportBundle(modelType, params, telemetry);
  const json = JSON.stringify(bundle, null, 2);
  const fileName = `aerolab_report_${modelType}_aoa${params.angle_of_attack.toFixed(1)}deg.json`;
  triggerBlobDownload(new Blob([json], { type: 'application/json;charset=utf-8' }), fileName);
  return fileName;
}

// ---------------------------------------------------------------------------
// Rich Text Engine for jsPDF (Unicode DejaVuSans + Typographic Sub/Superscripts)
// ---------------------------------------------------------------------------

interface RichAtom {
  text: string;
  script: 'normal' | 'sub' | 'sup';
  bold: boolean;
  macronOverC?: boolean;
}

function parseRichAtoms(input: string, baseBold: boolean): RichAtom[] {
  const atoms: RichAtom[] = [];
  let i = 0;
  let curBold = baseBold;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    // Split out c + combining macron (\u0304) so macron draws cleanly across any viewer
    let seg = '';
    for (let k = 0; k < buffer.length; k++) {
      const ch = buffer[k];
      if (ch === 'c' && buffer[k + 1] === '\u0304') {
        if (seg) {
          atoms.push({ text: seg, script: 'normal', bold: curBold });
          seg = '';
        }
        atoms.push({ text: 'c', script: 'normal', bold: curBold, macronOverC: true });
        k += 1;
      } else if (ch !== '\u0304') {
        seg += ch;
      }
    }
    if (seg) {
      atoms.push({ text: seg, script: 'normal', bold: curBold });
    }
    buffer = '';
  };

  while (i < input.length) {
    if (input[i] === '*' && input[i + 1] === '*') {
      flush();
      curBold = !curBold;
      i += 2;
      continue;
    }
    if ((input[i] === '_' || input[i] === '^') && input[i + 1] === '{') {
      const closeIdx = input.indexOf('}', i + 2);
      if (closeIdx !== -1) {
        flush();
        atoms.push({
          text: input.slice(i + 2, closeIdx),
          script: input[i] === '_' ? 'sub' : 'sup',
          bold: curBold,
        });
        i = closeIdx + 1;
        continue;
      }
    }
    buffer += input[i];
    i += 1;
  }
  flush();
  return atoms;
}

function tokenizeRichWords(input: string, baseBold: boolean): RichAtom[][] {
  const atoms = parseRichAtoms(input, baseBold);
  const tokens: RichAtom[][] = [];
  let current: RichAtom[] = [];

  for (const atom of atoms) {
    if (atom.script !== 'normal' || atom.macronOverC) {
      current.push(atom);
      continue;
    }
    const parts = atom.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (current.length > 0) {
          tokens.push(current);
          current = [];
        }
        tokens.push([{ text: ' ', script: 'normal', bold: atom.bold }]);
      } else {
        current.push({ text: part, script: 'normal', bold: atom.bold });
      }
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function toAsciiFallback(text: string): string {
  return text
    .replace(/α/g, 'alpha')
    .replace(/β/g, 'beta')
    .replace(/γ/g, 'gamma')
    .replace(/δ/g, 'delta')
    .replace(/ε/g, 'eps')
    .replace(/η/g, 'eta')
    .replace(/Λ/g, 'Lambda')
    .replace(/μ/g, 'mu')
    .replace(/π/g, 'pi')
    .replace(/ρ/g, 'rho')
    .replace(/Γ/g, 'Gamma')
    .replace(/∞/g, 'inf')
    .replace(/√/g, 'sqrt')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/≈/g, '~')
    .replace(/×/g, 'x')
    .replace(/·/g, '*')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/°/g, ' deg')
    .replace(/[−–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}

/**
 * Generates a structured 4-page A4 PDF Aerospace Engineering Simulation Report
 * matching the AeroLab reference layout using jsPDF and DejaVu Sans.
 */
export function generateEngineeringPdfBlob(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): { blob: Blob; fileName: string; bundle: EngineeringReportBundle } {
  const bundle = buildEngineeringReportBundle(modelType, params, telemetry);
  const {
    model,
    flightConditions,
    dimensionless,
    forcesAndCirculation,
    boundaryLayer,
    alphaSweepData,
    verificationDistinction,
    reproducibility,
  } = bundle;

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  // Register Unicode DejaVu Sans font (from /public/fonts/) when available
  const nodeFonts = tryLoadDejaVuFontsSyncNode();
  const activeFonts = cachedDejaVuFonts ?? nodeFonts;
  let fontFamily = 'helvetica';
  if (activeFonts) {
    try {
      doc.addFileToVFS('DejaVuSans.ttf', activeFonts.regularB64);
      doc.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
      doc.addFileToVFS('DejaVuSans-Bold.ttf', activeFonts.boldB64);
      doc.addFont('DejaVuSans-Bold.ttf', 'DejaVuSans', 'bold');
      fontFamily = 'DejaVuSans';
    } catch {
      fontFamily = 'helvetica';
    }
  }
  const hasUnicodeFont = fontFamily === 'DejaVuSans';

  const safeGlyphs = (s: string): string => (hasUnicodeFont ? s : toAsciiFallback(s));

  const measureAtoms = (atoms: RichAtom[], fontSize: number): number => {
    let w = 0;
    for (const atom of atoms) {
      const sz = atom.script === 'normal' ? fontSize : fontSize * 0.68;
      doc.setFont(fontFamily, atom.bold ? 'bold' : 'normal');
      doc.setFontSize(sz);
      w += doc.getTextWidth(safeGlyphs(atom.text));
    }
    return w;
  };

  const drawAtoms = (
    atoms: RichAtom[],
    x: number,
    yBaseline: number,
    fontSize: number,
    color: [number, number, number],
    align: 'left' | 'right' | 'center' = 'left'
  ) => {
    const totalW = align === 'left' ? 0 : measureAtoms(atoms, fontSize);
    let cursorX = align === 'right' ? x - totalW : align === 'center' ? x - totalW / 2 : x;

    doc.setTextColor(color[0], color[1], color[2]);
    for (const atom of atoms) {
      const sz = atom.script === 'normal' ? fontSize : fontSize * 0.68;
      const yOffset =
        atom.script === 'sub'
          ? fontSize * 0.115
          : atom.script === 'sup'
            ? -fontSize * 0.14
            : 0;
      doc.setFont(fontFamily, atom.bold ? 'bold' : 'normal');
      doc.setFontSize(sz);
      const rendered = safeGlyphs(atom.text);
      const w = doc.getTextWidth(rendered);
      doc.text(rendered, cursorX, yBaseline + yOffset);
      if (atom.macronOverC) {
        const barY = yBaseline - fontSize * 0.22;
        doc.setDrawColor(color[0], color[1], color[2]);
        doc.setLineWidth(0.22);
        doc.line(cursorX + 0.12, barY, cursorX + w - 0.12, barY);
      }
      cursorX += w;
    }
  };

  const drawRichText = (
    markup: string,
    x: number,
    yBaseline: number,
    fontSize: number,
    color: [number, number, number],
    options?: { bold?: boolean; align?: 'left' | 'right' | 'center' }
  ) => {
    const atoms = parseRichAtoms(markup, options?.bold ?? false);
    drawAtoms(atoms, x, yBaseline, fontSize, color, options?.align ?? 'left');
  };

  const wrapRichLines = (markup: string, maxWidthMm: number, baseBold = false, fontSize = 8.0): RichAtom[][] => {
    const tokens = tokenizeRichWords(markup, baseBold);
    const lines: RichAtom[][] = [];
    let currentLine: RichAtom[] = [];
    let currentW = 0;

    for (const tok of tokens) {
      const isSpace = tok.length === 1 && tok[0].text === ' ' && tok[0].script === 'normal';
      const tokW = measureAtoms(tok, fontSize);
      if (isSpace && currentLine.length === 0) continue;
      if (!isSpace && currentLine.length > 0 && currentW + tokW > maxWidthMm) {
        while (
          currentLine.length > 0 &&
          currentLine[currentLine.length - 1].text === ' ' &&
          currentLine[currentLine.length - 1].script === 'normal'
        ) {
          currentLine.pop();
        }
        lines.push(currentLine);
        currentLine = [...tok];
        currentW = tokW;
      } else {
        currentLine.push(...tok);
        currentW += tokW;
      }
    }
    if (currentLine.length > 0) {
      while (
        currentLine.length > 0 &&
        currentLine[currentLine.length - 1].text === ' ' &&
        currentLine[currentLine.length - 1].script === 'normal'
      ) {
        currentLine.pop();
      }
      if (currentLine.length > 0) lines.push(currentLine);
    }
    return lines.length > 0 ? lines : [[{ text: '', script: 'normal', bold: baseBold }]];
  };

  // Page dimensions & color palette matching AeroLab reference
  const pageWidth = doc.internal.pageSize.getWidth(); // 210 mm
  const pageHeight = doc.internal.pageSize.getHeight(); // 297 mm
  const marginX = 18;
  const contentW = pageWidth - marginX * 2; // 174 mm
  const topY = 13;
  const bottomLimit = pageHeight - 17;
  let y = topY;

  const ACCENT_BLUE: [number, number, number] = [27, 106, 165]; // #1b6aa5
  const SUMMARY_BG: [number, number, number] = [234, 242, 250]; // #eaf2fa
  const ROW_ALT_BG: [number, number, number] = [244, 248, 252]; // #f4f8fc
  const LINE_BORDER: [number, number, number] = [213, 225, 236]; // #d5e1ec
  const DARK_TEXT: [number, number, number] = [22, 28, 36];
  const BODY_TEXT: [number, number, number] = [44, 56, 70];
  const MUTED_TEXT: [number, number, number] = [100, 116, 139];
  const ORANGE_ACCENT: [number, number, number] = [217, 130, 43]; // #d9822b

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > bottomLimit) {
      doc.addPage();
      y = topY + 2;
    }
  };

  const drawSectionHeading = (title: string) => {
    const spaceAbove = 3.2; // ~9 pt space above
    ensureSpace(12 + spaceAbove);
    y += spaceAbove;
    drawRichText(title.toUpperCase(), marginX, y, 10.5, ACCENT_BLUE, { bold: true });
    y += 1.6;
    doc.setDrawColor(ACCENT_BLUE[0], ACCENT_BLUE[1], ACCENT_BLUE[2]);
    doc.setLineWidth(0.35);
    doc.line(marginX, y, marginX + contentW, y);
    y += 4.2;
  };

  const drawTwoColTable = (
    rows: Array<[string, string]>,
    options?: { labelColW?: number; fontSize?: number; rowPadY?: number }
  ) => {
    const labelColW = options?.labelColW ?? 92;
    const valColW = contentW - labelColW;
    const fontSize = options?.fontSize ?? 8.0;
    const lineH = 3.7;
    const padY = options?.rowPadY ?? 1.6;

    rows.forEach(([labelMarkup, valMarkup], idx) => {
      const labelLines = wrapRichLines(labelMarkup, labelColW - 4, false, fontSize);
      const valLines = wrapRichLines(valMarkup, valColW - 4, false, fontSize);
      const maxLines = Math.max(labelLines.length, valLines.length, 1);
      const rowH = maxLines * lineH + padY * 2;

      ensureSpace(rowH + 1);

      if (idx % 2 === 0) {
        doc.setFillColor(ROW_ALT_BG[0], ROW_ALT_BG[1], ROW_ALT_BG[2]);
      } else {
        doc.setFillColor(255, 255, 255);
      }
      doc.rect(marginX, y, contentW, rowH, 'F');

      doc.setDrawColor(LINE_BORDER[0], LINE_BORDER[1], LINE_BORDER[2]);
      doc.setLineWidth(0.2);
      doc.line(marginX, y + rowH, marginX + contentW, y + rowH);
      if (idx === 0) {
        doc.line(marginX, y, marginX + contentW, y);
      }

      const firstBaselineY = y + padY + 2.75;
      labelLines.forEach((lAtoms, li) => {
        drawAtoms(lAtoms, marginX + 2.0, firstBaselineY + li * lineH, fontSize, BODY_TEXT, 'left');
      });
      valLines.forEach((vAtoms, vi) => {
        drawAtoms(
          vAtoms,
          marginX + contentW - 2.0,
          firstBaselineY + vi * lineH,
          fontSize,
          DARK_TEXT,
          'right'
        );
      });

      y += rowH;
    });
    y += 2.2;
  };

  doc.setProperties({
    title: `AeroLab Engineering Report - ${model.name}`,
    subject: 'Aerodynamic Simulation & SI Telemetry Verification Report',
    creator: 'AeroLab Wind Tunnel',
  });

  // =========================================================================
  // PAGE 1: HEADER + OPERATING-POINT SUMMARY + SECTIONS 1, 2, 3
  // =========================================================================

  // Header band: #1b6aa5, 22 mm tall, full content width (174 mm), Page 1 only
  const bannerH = 22;
  doc.setFillColor(ACCENT_BLUE[0], ACCENT_BLUE[1], ACCENT_BLUE[2]);
  doc.rect(marginX, y, contentW, bannerH, 'F');

  const logoBoxW = 36;
  const logoBoxH = 16;
  const logoBoxX = marginX + 3;
  const logoBoxY = y + (bannerH - logoBoxH) / 2;
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(logoBoxX, logoBoxY, logoBoxW, logoBoxH, 1.8, 1.8, 'F');

  const logoW = 30;
  const logoH = Number(((logoW * 409) / 830).toFixed(2));
  const logoX = logoBoxX + (logoBoxW - logoW) / 2;
  const logoY = logoBoxY + (logoBoxH - logoH) / 2;
  const logoDataUrl = getLogoDataUrl();
  if (logoDataUrl.startsWith('data:image/')) {
    try {
      doc.addImage(logoDataUrl, 'PNG', logoX, logoY, logoW, logoH, 'aerolab-logo', 'FAST');
    } catch {
      drawRichText('AERO Lab', logoBoxX + logoBoxW / 2, logoBoxY + 9.5, 10, ACCENT_BLUE, {
        bold: true,
        align: 'center',
      });
    }
  } else {
    drawRichText('AERO Lab', logoBoxX + logoBoxW / 2, logoBoxY + 9.5, 10, ACCENT_BLUE, {
      bold: true,
      align: 'center',
    });
  }

  const headerTextX = marginX + 43;
  drawRichText('AEROLAB ENGINEERING SIMULATION REPORT', headerTextX, y + 7.8, 12.5, [255, 255, 255], {
    bold: true,
  });
  drawRichText(
    `Configuration: ${model.name}  |  Generated (UTC): ${bundle.generatedAt}`,
    headerTextX,
    y + 13.0,
    8.0,
    [240, 247, 253]
  );
  drawRichText(`Solver: ${bundle.solverLabel}`, headerTextX, y + 17.5, 6.8, [215, 234, 248]);

  y += bannerH + 6.0;

  // Operating-point summary caption + 6-cell box
  const aoaSign = flightConditions.angleOfAttack_deg >= 0 ? '+' : '';
  const summaryCaption = `**Operating-point summary** (α = ${aoaSign}${flightConditions.angleOfAttack_deg.toFixed(1)}°, V_{∞} = ${flightConditions.airspeed_ms.toFixed(2)} m/s, h = ${Math.round(flightConditions.altitude_m).toLocaleString('en-US')} m ISA)`;
  drawRichText(summaryCaption, marginX, y, 8.0, BODY_TEXT);
  y += 2.2;

  const formatForceCompact = (newtons: number): string => {
    if (Math.abs(newtons) >= 1e6) return `${(newtons / 1e6).toFixed(2)} MN`;
    if (Math.abs(newtons) >= 1e3) return `${(newtons / 1e3).toFixed(1)} kN`;
    return `${Math.round(newtons)} N`;
  };

  const summaryCells: Array<{ label: string; value: string }> = [
    { label: 'C_{L}', value: forcesAndCirculation.cl.toFixed(3) },
    { label: 'C_{D}', value: forcesAndCirculation.dragDecomposition.cdTotal.toFixed(4) },
    { label: 'L/D', value: forcesAndCirculation.ldRatio.toFixed(2) },
    { label: 'Lift', value: formatForceCompact(forcesAndCirculation.lift_N) },
    { label: 'Drag', value: formatForceCompact(forcesAndCirculation.drag_N) },
    { label: 'M_{∞}', value: dimensionless.mach.toFixed(3) },
  ];

  const boxH = 13.5;
  const cellW = contentW / summaryCells.length;
  doc.setFillColor(SUMMARY_BG[0], SUMMARY_BG[1], SUMMARY_BG[2]);
  doc.setDrawColor(ACCENT_BLUE[0], ACCENT_BLUE[1], ACCENT_BLUE[2]);
  doc.setLineWidth(0.35);
  doc.rect(marginX, y, contentW, boxH, 'FD');

  summaryCells.forEach((cell, idx) => {
    const cx = marginX + idx * cellW;
    if (idx > 0) {
      doc.setDrawColor(LINE_BORDER[0], LINE_BORDER[1], LINE_BORDER[2]);
      doc.setLineWidth(0.25);
      doc.line(cx, y, cx, y + boxH);
    }
    drawRichText(cell.label, cx + 2.2, y + 4.4, 7.8, BODY_TEXT, { bold: true });
    drawRichText(cell.value, cx + 2.2, y + 11.1, 11.0, DARK_TEXT, { bold: true });
  });

  y += boxH + 3.2;

  // Section 1: Solver Scope & Physical Assumptions
  drawSectionHeading('1. Solver Scope & Physical Assumptions');
  for (const assumption of bundle.solverAssumptions) {
    const wrapped = wrapRichLines(`• ${assumption}`, contentW - 1, false, 7.9);
    const blockH = wrapped.length * 3.6 + 1.1;
    ensureSpace(blockH);
    wrapped.forEach((lineAtoms, li) => {
      drawAtoms(lineAtoms, marginX, y + li * 3.6, 7.9, DARK_TEXT, 'left');
    });
    y += blockH;
  }

  // Section 2: Geometry & Reference Planform
  drawSectionHeading('2. Geometry & Reference Planform');
  const sRowLabel =
    model.id === 'f22'
      ? 'Reference planform area (S, published F-22 wing area)'
      : 'Reference planform area (S, preset planform reference)';
  drawTwoColTable(
    [
      ['Wingspan (b)', `${model.wingspan_m.toFixed(2)} m`],
      [sRowLabel, `${model.wingArea_m2.toFixed(2)} m^{2}`],
      ['Mean geometric chord (c̄ = S / b) – reference length for Re', `${model.chord_m.toFixed(2)} m`],
      ['Aspect ratio (AR = b^{2} / S)', model.aspectRatio.toFixed(2)],
      ['Sweep at max-thickness line (Λ, assumed input)', `${model.sweepDeg.toFixed(1)}°`],
      ['Oswald span efficiency (e, assumed input)', model.oswaldEfficiency.toFixed(3)],
      ['Preset zero-lift drag (C_{D0}, referenced to S)', model.presetCd0.toFixed(4)],
      ['Thickness ratio (t/c)', `${(model.thicknessRatio * 100).toFixed(1)} %`],
    ],
    { labelColW: 112, fontSize: 8.0, rowPadY: 1.65 }
  );

  // Section 3: Flight Conditions & ISA Atmospheric State
  drawSectionHeading('3. Flight Conditions & ISA Atmospheric State (SI, 0 – 20,000 m)');
  drawTwoColTable(
    [
      [
        'Angle of attack (α) / flap deflection (δ_{f})',
        `${aoaSign}${flightConditions.angleOfAttack_deg.toFixed(2)}° / ${flightConditions.flaps_deg.toFixed(1)}°`,
      ],
      [
        'True airspeed (V_{∞})',
        `${flightConditions.airspeed_ms.toFixed(2)} m/s (${Math.round(flightConditions.airspeed_kts)} kt)`,
      ],
      [
        'ISA geopotential altitude (h)',
        `${flightConditions.altitude_m.toLocaleString('en-US', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} m (${Math.round(flightConditions.altitude_ft).toLocaleString('en-US')} ft)`,
      ],
      ['Static temperature T(h)', `${flightConditions.isaTemperature_K.toFixed(2)} K`],
      [
        'Static pressure P(h)',
        `${Math.round(flightConditions.isaPressure_Pa).toLocaleString('en-US')} Pa`,
      ],
      ['Air density ρ(h)', `${flightConditions.airDensity_kg_m3.toFixed(4)} kg/m^{3}`],
      [
        'Sutherland viscosity μ(T)',
        `${flightConditions.dynamicViscosity_Pa_s.toExponential(4)} Pa·s`,
      ],
      ['Speed of sound a(T)', `${flightConditions.speedOfSound_ms.toFixed(2)} m/s`],
    ],
    { labelColW: 102, fontSize: 8.0, rowPadY: 1.65 }
  );

  // =========================================================================
  // PAGE 2: SECTIONS 4, 5, 6 (Page break after Section 3)
  // =========================================================================
  doc.addPage();
  y = topY + 2;

  // Section 4: Dimensionless Parameters & Regime Validity
  drawSectionHeading('4. Dimensionless Parameters & Regime Validity');
  const pgRounded = dimensionless.prandtlGlauertFactor.toFixed(3);
  const reRegimeCompact =
    dimensionless.reynolds > 300_000
      ? 'Turbulent-dominated, Re > 3×10^{5}'
      : dimensionless.reynolds >= 100_000
        ? 'Transitional, 1×10^{5} ≤ Re ≤ 3×10^{5}'
        : 'Laminar-dominated, Re < 1×10^{5}';
  const machRegimeCompact =
    dimensionless.compressibilityRegime === 'prandtl-glauert'
      ? `Subsonic compressible, PG ×${pgRounded}`
      : dimensionless.compressibilityRegime === 'incompressible'
        ? `Incompressible, PG ×${pgRounded}`
        : `Transonic limit, PG ×${pgRounded}`;

  drawTwoColTable(
    [
      [
        'Dynamic pressure (q_{∞} = ½ ρ V^{2})',
        `${Math.round(dimensionless.dynamicPressure_Pa).toLocaleString('en-US')} Pa`,
      ],
      [
        'Reynolds number (Re = ρ V c̄ / μ)',
        `${dimensionless.reynolds.toExponential(3)} (${reRegimeCompact})`,
      ],
      [
        'Mach number (M_{∞} = V / a)',
        `${dimensionless.mach.toFixed(3)} (${machRegimeCompact})`,
      ],
      [
        'Prandtl–Glauert compressibility factor',
        `×${pgRounded} (C_{p} = C_{p,0} / √(1 − M^{2}))`,
      ],
      [
        'Knudsen number (Kn = √(πγ/2) · M / Re)',
        `${dimensionless.knudsen.toExponential(3)} (${dimensionless.continuumValid ? 'Continuum valid, Kn ≤ 0.01' : 'Continuum breakdown, Kn > 0.01'})`,
      ],
    ],
    { labelColW: 86, fontSize: 7.9, rowPadY: 1.6 }
  );

  // [+ INFO] / warning note box
  const infoNotes =
    dimensionless.regimeWarnings.length > 0
      ? dimensionless.regimeWarnings
      : [
          {
            code: 'MACH_COMPRESSIBLE' as const,
            severity: 'info' as const,
            title: `Incompressible Continuum Envelope (M = ${dimensionless.mach.toFixed(3)})`,
            detail: `Prandtl–Glauert compressibility correction C_{p} = C_{p,0} / √(1 − M^{2}) is unity (×${pgRounded}); flow remains within linear attached subsonic bounds.`,
          },
        ];

  for (const w of infoNotes) {
    const isWarn = w.severity !== 'info';
    const boxBg: [number, number, number] = isWarn ? [254, 243, 199] : SUMMARY_BG;
    const boxBorder: [number, number, number] = isWarn ? ORANGE_ACCENT : ACCENT_BLUE;
    const boxText: [number, number, number] = isWarn ? [120, 53, 15] : [20, 62, 99];
    const cleanDetail = w.detail.replace(/Cp = Cp,0 \/ √\(1 − M²\)/g, 'C_{p} = C_{p,0} / √(1 − M^{2})');
    const noteMarkup = `**[${w.severity.toUpperCase()}] ${w.title}:** ${cleanDetail}`;
    const noteLines = wrapRichLines(noteMarkup, contentW - 6, false, 7.6);
    const boxHeight = noteLines.length * 3.5 + 3.4;
    ensureSpace(boxHeight + 2);
    doc.setFillColor(boxBg[0], boxBg[1], boxBg[2]);
    doc.setDrawColor(boxBorder[0], boxBorder[1], boxBorder[2]);
    doc.setLineWidth(0.3);
    doc.rect(marginX, y, contentW, boxHeight, 'FD');
    noteLines.forEach((lineAtoms, li) => {
      drawAtoms(lineAtoms, marginX + 3, y + 4.0 + li * 3.5, 7.6, boxText, 'left');
    });
    y += boxHeight + 2.2;
  }

  // Section 5: Force Decomposition, Circulation & Drag (NO 80/20 share, NO Kutta residual)
  drawSectionHeading('5. Force Decomposition, Circulation & Drag');
  const deg = forcesAndCirculation.dragDecomposition;
  drawTwoColTable(
    [
      [
        'Lift-curve slope (C_{Lα}, Helmbold/Raymer, η = 0.95)',
        `${forcesAndCirculation.clAlpha_per_rad.toFixed(3)} /rad (${((forcesAndCirculation.clAlpha_per_rad * Math.PI) / 180).toFixed(4)} /deg)`,
      ],
      ['Total lift coefficient (C_{L} = C_{Lα} · α)', forcesAndCirculation.cl.toFixed(3)],
      [
        'Total aerodynamic lift (L = q_{∞} S C_{L})',
        `${forcesAndCirculation.lift_N.toLocaleString('en-US')} N (${(forcesAndCirculation.lift_N / 1000).toFixed(1)} kN)`,
      ],
      [
        'Induced angle of attack (α_{i} = C_{L} / (π e AR))',
        `${forcesAndCirculation.inducedAlpha_deg.toFixed(2)}°`,
      ],
      [
        'Far-wake downwash angle (ε = 2 α_{i})',
        `${forcesAndCirculation.downwashAngle_deg.toFixed(2)}°`,
      ],
      [
        'Equivalent uniform circulation (Γ_{eq} = ½ V c̄ C_{L})',
        `${forcesAndCirculation.equivalentCirculation_m2_s.toFixed(2)} m^{2}/s`,
      ],
      [
        'Elliptic root circulation (Γ_{0} = (2/π) V c̄ C_{L})',
        `${forcesAndCirculation.ellipticRootCirculation_m2_s.toFixed(2)} m^{2}/s`,
      ],
      ['Preset zero-lift parasitic drag (C_{D0})', deg.cd0Parasitic.toFixed(4)],
      ['Induced vortex drag (C_{Di} = C_{L}^{2} / (π e AR))', deg.cdiInduced.toFixed(4)],
      [
        'Separation / wave drag (C_{D,sep} / C_{D,wave})',
        `${deg.cdSeparation.toFixed(4)} / ${deg.cdWave.toFixed(4)}`,
      ],
      [
        'Total drag coefficient (C_{D} = C_{D0} + C_{Di} + C_{D,sep} + C_{D,wave})',
        deg.cdTotal.toFixed(4),
      ],
      [
        'Total aerodynamic drag (D = q_{∞} S C_{D})',
        `${forcesAndCirculation.drag_N.toLocaleString('en-US')} N (${(forcesAndCirculation.drag_N / 1000).toFixed(1)} kN)`,
      ],
      ['Aerodynamic efficiency (L/D = C_{L} / C_{D})', forcesAndCirculation.ldRatio.toFixed(2)],
    ],
    { labelColW: 108, fontSize: 7.9, rowPadY: 1.55 }
  );

  // CD0 note under Section 5
  const cd0Note = `**Note:** Preset C_{D0} = ${deg.cd0Parasitic.toFixed(4)} is referenced to S = ${model.wingArea_m2.toFixed(2)} m^{2}; separation and transonic wave drag increments are identically zero below M = 0.70 in attached flow.`;
  const cd0NoteLines = wrapRichLines(cd0Note, contentW - 4, false, 7.5);
  const cd0BoxH = cd0NoteLines.length * 3.4 + 3.0;
  ensureSpace(cd0BoxH + 2);
  doc.setFillColor(ROW_ALT_BG[0], ROW_ALT_BG[1], ROW_ALT_BG[2]);
  doc.setDrawColor(LINE_BORDER[0], LINE_BORDER[1], LINE_BORDER[2]);
  doc.setLineWidth(0.25);
  doc.rect(marginX, y, contentW, cd0BoxH, 'FD');
  cd0NoteLines.forEach((lineAtoms, li) => {
    drawAtoms(lineAtoms, marginX + 2.5, y + 3.8 + li * 3.4, 7.5, BODY_TEXT, 'left');
  });
  y += cd0BoxH + 2.2;

  // Section 6: Empirical Boundary-Layer & Flat-Plate Estimates
  drawSectionHeading('6. Empirical Boundary-Layer & Flat-Plate Estimates');
  drawTwoColTable(
    [
      ['Empirical boundary-layer indicator', `${boundaryLayer.regime} (${boundaryLayer.flowState})`],
      ['Estimated stagnation point (x_{stag} / c)', `${(boundaryLayer.stagnationXc * 100).toFixed(1)} %`],
      [
        'Empirical transition (upper / lower x_{tr} / c)',
        `${(boundaryLayer.xTransitionUpper * 100).toFixed(1)}% / ${(boundaryLayer.xTransitionLower * 100).toFixed(1)}%`,
      ],
      ['Empirical separation onset (x_{sep} / c)', `${(boundaryLayer.xSeparationUpper * 100).toFixed(1)} %`],
      [
        'Blasius laminar mean (C_{f,lam} = 1.328 / √Re)',
        boundaryLayer.laminarFlatPlateCfMean.toFixed(5),
      ],
      [
        'Schlichting turbulent mean (C_{f,turb} = 0.074 / Re^{0.2})',
        boundaryLayer.turbulentFlatPlateCfMean.toFixed(5),
      ],
      [
        'Wing flat-plate skin friction ref (C_{D,f} = 2 · C_{f,turb})',
        boundaryLayer.skinFrictionDrag_cdf.toFixed(5),
      ],
      ['Peak adverse pressure gradient max(dC_{p}/d(x/c))', boundaryLayer.maxAdversePressureGrad.toFixed(2)],
      [
        'Stall margin',
        `${boundaryLayer.stallMargin_deg.toFixed(1)}° (${boundaryLayer.isStalled ? 'STALLED' : 'Attached'})`,
      ],
    ],
    { labelColW: 108, fontSize: 7.9, rowPadY: 1.55 }
  );

  // =========================================================================
  // PAGE 3: SECTIONS 7 & 8 (Page break after Section 6)
  // =========================================================================
  doc.addPage();
  y = topY + 2;

  // Section 7: Alpha Sweep (3 vector charts side-by-side + table)
  drawSectionHeading('7. Alpha Sweep (α = 0° to 15°, Step 0.2°)');

  const chartGap = 4.5;
  const chartBoxW = (contentW - chartGap * 2) / 3; // 55 mm
  const chartBoxH = 44;

  const drawVectorChart = (
    boxX: number,
    boxY: number,
    titleMarkup: string,
    xLabelMarkup: string,
    yLabelMarkup: string,
    xs: number[],
    ys: number[],
    opX: number,
    opY: number,
    xDecimals: number,
    yDecimals: number
  ) => {
    const padL = 9.5;
    const padR = 2.5;
    const padT = 6.5;
    const padB = 8.0;
    const plotX = boxX + padL;
    const plotY = boxY + padT;
    const plotW = chartBoxW - padL - padR;
    const plotH = chartBoxH - padT - padB;

    drawRichText(titleMarkup, boxX + chartBoxW / 2, boxY + 4.0, 7.6, DARK_TEXT, {
      bold: true,
      align: 'center',
    });

    const minXRaw = Math.min(...xs);
    const maxXRaw = Math.max(...xs);
    const minYRaw = Math.min(...ys, 0);
    const maxYRaw = Math.max(...ys);
    const xSpan = Math.max(1e-6, maxXRaw - minXRaw);
    const ySpanRaw = Math.max(1e-6, maxYRaw - minYRaw);
    const xMin = minXRaw;
    const xMax = maxXRaw;
    const yMin = minYRaw;
    const yMax = maxYRaw + ySpanRaw * 0.08;
    const ySpan = Math.max(1e-6, yMax - yMin);

    const mapX = (xv: number) => plotX + ((xv - xMin) / xSpan) * plotW;
    const mapY = (yv: number) => plotY + plotH - ((yv - yMin) / ySpan) * plotH;

    // Light grid lines (4 intervals)
    const ticks = 4;
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.18);
    for (let t = 0; t <= ticks; t++) {
      const frac = t / ticks;
      const gy = plotY + plotH - frac * plotH;
      const gx = plotX + frac * plotW;
      doc.line(plotX, gy, plotX + plotW, gy);
      doc.line(gx, plotY, gx, plotY + plotH);

      const yVal = yMin + frac * ySpan;
      const xVal = xMin + frac * xSpan;
      drawRichText(yVal.toFixed(yDecimals), plotX - 1.2, gy + 0.9, 5.8, MUTED_TEXT, {
        align: 'right',
      });
      drawRichText(xVal.toFixed(xDecimals), gx, plotY + plotH + 3.0, 5.8, MUTED_TEXT, {
        align: 'center',
      });
    }

    // Bottom and left axes only (no top/right spines)
    doc.setDrawColor(100, 116, 139);
    doc.setLineWidth(0.3);
    doc.line(plotX, plotY, plotX, plotY + plotH);
    doc.line(plotX, plotY + plotH, plotX + plotW, plotY + plotH);

    // Data polyline (#1b6aa5)
    doc.setDrawColor(ACCENT_BLUE[0], ACCENT_BLUE[1], ACCENT_BLUE[2]);
    doc.setLineWidth(0.45);
    for (let k = 1; k < xs.length; k++) {
      doc.line(mapX(xs[k - 1]), mapY(ys[k - 1]), mapX(xs[k]), mapY(ys[k]));
    }

    // Operating point marker (#d9822b) if within domain
    if (opX >= xMin - 1e-6 && opX <= xMax + 1e-6) {
      const ox = mapX(Math.max(xMin, Math.min(xMax, opX)));
      const oy = mapY(Math.max(yMin, Math.min(yMax, opY)));
      doc.setFillColor(255, 255, 255);
      doc.circle(ox, oy, 1.35, 'F');
      doc.setFillColor(ORANGE_ACCENT[0], ORANGE_ACCENT[1], ORANGE_ACCENT[2]);
      doc.circle(ox, oy, 0.95, 'F');
    }

    drawRichText(xLabelMarkup, plotX + plotW / 2, boxY + chartBoxH - 1.2, 6.2, BODY_TEXT, {
      align: 'center',
    });
    drawRichText(yLabelMarkup, boxX + 1.0, plotY + 2.0, 6.2, BODY_TEXT);
  };

  const opAoa = flightConditions.angleOfAttack_deg;
  const opCl = forcesAndCirculation.cl;
  const opCd = forcesAndCirculation.dragDecomposition.cdTotal;
  const opLd = forcesAndCirculation.ldRatio;

  drawVectorChart(
    marginX,
    y,
    'Lift Curve (C_{L}–α)',
    'α (deg)',
    'C_{L}',
    alphaSweepData.alphaDeg,
    alphaSweepData.CL,
    opAoa,
    opCl,
    0,
    2
  );
  drawVectorChart(
    marginX + chartBoxW + chartGap,
    y,
    'Drag Polar (C_{L}–C_{D})',
    'C_{D}',
    'C_{L}',
    alphaSweepData.CD,
    alphaSweepData.CL,
    opCd,
    opCl,
    3,
    2
  );
  drawVectorChart(
    marginX + (chartBoxW + chartGap) * 2,
    y,
    'Efficiency (L/D–α)',
    'α (deg)',
    'L/D',
    alphaSweepData.alphaDeg,
    alphaSweepData.LD,
    opAoa,
    opLd,
    0,
    1
  );

  y += chartBoxH + 1.5;
  drawRichText(
    'Blue curve: 0–15° sweep (Δα = 0.2°). Orange marker (#d9822b): active operating point.',
    marginX,
    y,
    7.0,
    MUTED_TEXT
  );
  y += 3.2;

  // Alpha Sweep Sample Table at alpha = 0, 2, 4, 5, 6, 8, 10, 12, 15
  const sweepTableAlphas = [0, 2, 4, 5, 6, 8, 10, 12, 15];
  const sweepColW = [30, 36, 36, 36, 36]; // sums to 174 mm
  const sweepHeaders = ['α (deg)', 'C_{L}', 'C_{D}', 'C_{Di}', 'L/D'];
  const headerH = 6.2;

  doc.setFillColor(ACCENT_BLUE[0], ACCENT_BLUE[1], ACCENT_BLUE[2]);
  doc.rect(marginX, y, contentW, headerH, 'F');
  let colX = marginX;
  sweepHeaders.forEach((hdr, idx) => {
    drawRichText(
      hdr,
      idx === 0 ? colX + 2.5 : colX + sweepColW[idx] - 2.5,
      y + 4.3,
      7.7,
      [255, 255, 255],
      { bold: true, align: idx === 0 ? 'left' : 'right' }
    );
    colX += sweepColW[idx];
  });
  y += headerH;

  sweepTableAlphas.forEach((aTarget, rIdx) => {
    const pt =
      alphaSweepData.points.find((p) => Math.abs(p.alphaDeg - aTarget) < 0.05) ??
      alphaSweepData.points[0];
    const isOpRow = Math.abs(pt.alphaDeg - opAoa) < 0.11;
    const rowH = 5.4;

    if (isOpRow) {
      doc.setFillColor(255, 244, 230); // Highlighted operating row
    } else if (rIdx % 2 === 0) {
      doc.setFillColor(ROW_ALT_BG[0], ROW_ALT_BG[1], ROW_ALT_BG[2]);
    } else {
      doc.setFillColor(255, 255, 255);
    }
    doc.rect(marginX, y, contentW, rowH, 'F');
    doc.setDrawColor(
      isOpRow ? ORANGE_ACCENT[0] : LINE_BORDER[0],
      isOpRow ? ORANGE_ACCENT[1] : LINE_BORDER[1],
      isOpRow ? ORANGE_ACCENT[2] : LINE_BORDER[2]
    );
    doc.setLineWidth(isOpRow ? 0.35 : 0.2);
    doc.line(marginX, y + rowH, marginX + contentW, y + rowH);

    const vals = [
      `${pt.alphaDeg.toFixed(1)}°${isOpRow ? ' (op)' : ''}`,
      pt.cl.toFixed(3),
      pt.cd.toFixed(4),
      pt.cdi.toFixed(4),
      pt.ldRatio.toFixed(2),
    ];
    let cx = marginX;
    vals.forEach((val, ci) => {
      drawRichText(
        val,
        ci === 0 ? cx + 2.5 : cx + sweepColW[ci] - 2.5,
        y + 3.8,
        7.6,
        isOpRow ? [146, 64, 14] : DARK_TEXT,
        { bold: isOpRow, align: ci === 0 ? 'left' : 'right' }
      );
      cx += sweepColW[ci];
    });
    y += rowH;
  });

  y += 3.0;

  // Section 8: Verification, Validation, Applicability & Record
  drawSectionHeading('8. Verification, Validation, Applicability & Record');
  const vd = verificationDistinction;
  const residualRows: Array<[string, string]> = vd.numericalVerification.residuals.map((r) => [
    r.label,
    `${r.residual.toExponential(2)} ${r.unit === '—' ? '' : r.unit}(${r.passed ? `pass ${r.toleranceLabel}` : 'FAIL'})`.replace(
      /\s+\(/,
      ' ('
    ),
  ]);

  residualRows.push([
    'Surrogate C_{p} quadrature lift check (L_{p} vs L)',
    `${vd.numericalVerification.quadratureLift_N.toLocaleString('en-US')} N (err ${vd.numericalVerification.quadratureRelErrorPct.toFixed(4)}%, ${vd.numericalVerification.quadraturePassed ? 'pass < 0.1%' : 'FAIL'})`,
  ]);
  residualRows.push([
    'Numerical verification status',
    `**${vd.numericalVerification.status}** (residuals < 1e-9, quadrature < 0.1%)`,
  ]);
  residualRows.push([
    'Model validation status',
    `**${vd.modelValidation.status}** (${vd.modelValidation.referenceDataset ?? 'no external wind-tunnel overlay'})`,
  ]);
  residualRows.push([
    'Operating applicability status',
    `**${vd.operatingApplicability.status}** (M = ${dimensionless.mach.toFixed(3)} ≤ 0.70, Kn = ${dimensionless.knudsen.toExponential(2)} ≤ 0.01)`,
  ]);

  drawTwoColTable(residualRows, { labelColW: 96, fontSize: 7.7, rowPadY: 1.5 });

  // =========================================================================
  // PAGE 4: SECTION 9 (Page break after Section 8; NO Annex A in production)
  // =========================================================================
  doc.addPage();
  y = topY + 2;

  drawSectionHeading('9. Reproducible Record');
  drawTwoColTable(
    [
      ['Software / solver engine', `${reproducibility.softwareVersion} | ${reproducibility.engine} v${reproducibility.engineVersion}`],
      ['Geometry hash (SHA-like deterministic ID)', reproducibility.geometryHash],
      ['Input configuration hash', reproducibility.inputHash],
      ['Generated timestamp (UTC)', bundle.generatedAt],
      ['Canonical coordinate convention', reproducibility.coordinateSystem],
      ['Numerical precision', reproducibility.numericalPrecision],
      ['Discretization & quadrature grid', reproducibility.meshResolution],
      ['Audit validation status', reproducibility.validationStatus.toUpperCase()],
      ['Embedded brand logo path', reproducibility.logoAssetPath],
    ],
    { labelColW: 78, fontSize: 8.0, rowPadY: 1.8 }
  );

  // Page footers across every page (NO "REFERENCE LAYOUT" text in production)
  const totalPages = doc.getNumberOfPages();
  for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
    doc.setPage(pageNum);
    doc.setDrawColor(LINE_BORDER[0], LINE_BORDER[1], LINE_BORDER[2]);
    doc.setLineWidth(0.25);
    doc.line(marginX, pageHeight - 12, marginX + contentW, pageHeight - 12);
    drawRichText(
      'AeroLab Aerospace Simulation & Engineering Laboratory (SI Units)',
      marginX,
      pageHeight - 7.5,
      7.5,
      MUTED_TEXT
    );
    drawRichText(`Page ${pageNum} of ${totalPages}`, marginX + contentW, pageHeight - 7.5, 7.5, MUTED_TEXT, {
      align: 'right',
    });
  }

  const fileName = `aerolab_report_${modelType}_aoa${params.angle_of_attack.toFixed(1)}deg.pdf`;
  const arrayBuffer = doc.output('arraybuffer');
  const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
  return { blob, fileName, bundle };
}

/**
 * Generates and downloads an A4 PDF engineering report directly to the user's device.
 */
export function downloadEngineeringPdfReport(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): string {
  const { blob, fileName } = generateEngineeringPdfBlob(modelType, params, telemetry);
  triggerBlobDownload(blob, fileName);
  return fileName;
}

/**
 * Backward-compatible alias: triggers a direct downloadable PDF engineering report.
 */
export function printEngineeringReport(
  modelType: AircraftModelType,
  params: SimulationParams,
  telemetry: AeroTelemetry
): string {
  return downloadEngineeringPdfReport(modelType, params, telemetry);
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', fileName);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    if (link.parentNode) {
      link.parentNode.removeChild(link);
    }
    URL.revokeObjectURL(url);
  }, 2000);
}
