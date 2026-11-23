import {
  ChordwiseCpStation,
  CompressibilityRegime,
  RegimeWarning,
  ReynoldsRegime,
} from '../types/aerodynamics';

/**
 * Pure SI Scientific Calculation Layer (Zero UI / Zero Three.js dependencies).
 * All internal calculations strictly use SI units (m, s, kg, Pa, K, rad).
 */

export const SOLVER_LABEL_3D =
  'Reduced-Order Biot–Savart Vortex-Lattice & Approximate SDF Surface-Constraint Model';
export const SOLVER_LABEL_2D =
  'Incompressible GPU D2Q9 Lattice-Boltzmann (LBM) Solver';

// Physical SI Constants (International Standard Atmosphere)
export const ISA_CONSTANTS = {
  T0_K: 288.15, // Sea-level standard temperature (K)
  P0_PA: 101325, // Sea-level standard pressure (Pa)
  LAPSE_RATE_K_M: 0.0065, // Troposphere temperature lapse rate (K/m)
  R_SPECIFIC_J_KG_K: 287.058, // Specific gas constant for dry air (J/(kg·K))
  GAMMA: 1.4, // Ratio of specific heats (cp/cv) for diatomic air
  G0_M_S2: 9.80665, // Standard gravitational acceleration (m/s^2)
  TROPOPAUSE_M: 11000, // Tropopause geopotential altitude (m)
  MAX_ALTITUDE_M: 20000, // Lower stratosphere model ceiling (20 km)
  MU0_PA_S: 1.7894e-5, // Sea-level reference dynamic viscosity (Pa·s)
  SUTHERLAND_C_K: 110.4, // Sutherland effective temperature constant for air (K)
  KTS_TO_MS: 0.514444, // Exact international knot in m/s (1852 / 3600 ≈ 0.514444)
  FT_TO_M: 0.3048, // Exact international foot in m
} as const;

// ---------------------------------------------------------------------------
// Input Validation Helpers
// ---------------------------------------------------------------------------

function assertFinite(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`Invalid physical parameter "${name}": expected a finite number, got ${value}.`);
  }
  return value;
}

function assertPositive(value: number, name: string): number {
  assertFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`Invalid physical parameter "${name}": must be > 0, got ${value}.`);
  }
  return value;
}

function assertNonNegative(value: number, name: string): number {
  assertFinite(value, name);
  if (value < 0) {
    throw new RangeError(`Invalid physical parameter "${name}": must be >= 0, got ${value}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1. International Standard Atmosphere (ISA, 0–20,000 m)
// ---------------------------------------------------------------------------

export interface ISAStateSI {
  altitude_m: number;
  temperature_K: number;
  pressure_Pa: number;
  density_kg_m3: number;
  dynamicViscosity_Pa_s: number;
  speedOfSound_ms: number;
}

/**
 * International Standard Atmosphere (ISA) model strictly valid from 0 m to 20,000 m (20 km):
 * - Troposphere (0..11,000 m): linear lapse rate T(h) = T0 - L*h, L = 0.0065 K/m
 * - Lower Stratosphere (11,000..20,000 m): isothermal T = 216.65 K
 * - Dynamic viscosity mu(T) via Sutherland's Law
 * - Speed of sound a(T) = sqrt(gamma * R * T)
 *
 * Throws RangeError for non-finite or out-of-range (< 0 or > 20,000 m) altitudes.
 */
export function computeISA(altitudeMeters: number): ISAStateSI {
  assertFinite(altitudeMeters, 'altitudeMeters');
  if (altitudeMeters < 0 || altitudeMeters > ISA_CONSTANTS.MAX_ALTITUDE_M) {
    throw new RangeError(
      `Invalid altitude "${altitudeMeters} m": ISA model is valid strictly for 0 <= h <= ${ISA_CONSTANTS.MAX_ALTITUDE_M} m.`
    );
  }

  const {
    T0_K,
    P0_PA,
    LAPSE_RATE_K_M,
    R_SPECIFIC_J_KG_K,
    GAMMA,
    G0_M_S2,
    TROPOPAUSE_M,
    MU0_PA_S,
    SUTHERLAND_C_K,
  } = ISA_CONSTANTS;

  const pressureExponent = G0_M_S2 / (R_SPECIFIC_J_KG_K * LAPSE_RATE_K_M); // ≈ 5.25588

  let temperature_K: number;
  let pressure_Pa: number;

  if (altitudeMeters <= TROPOPAUSE_M) {
    temperature_K = T0_K - LAPSE_RATE_K_M * altitudeMeters;
    pressure_Pa = P0_PA * Math.pow(temperature_K / T0_K, pressureExponent);
  } else {
    const T11 = T0_K - LAPSE_RATE_K_M * TROPOPAUSE_M; // 216.65 K
    const P11 = P0_PA * Math.pow(T11 / T0_K, pressureExponent);
    temperature_K = T11;
    pressure_Pa =
      P11 * Math.exp((-G0_M_S2 * (altitudeMeters - TROPOPAUSE_M)) / (R_SPECIFIC_J_KG_K * T11));
  }

  const density_kg_m3 = pressure_Pa / (R_SPECIFIC_J_KG_K * temperature_K);
  const speedOfSound_ms = Math.sqrt(GAMMA * R_SPECIFIC_J_KG_K * temperature_K);

  // Sutherland's Law for air dynamic viscosity
  const dynamicViscosity_Pa_s =
    MU0_PA_S *
    Math.pow(temperature_K / T0_K, 1.5) *
    ((T0_K + SUTHERLAND_C_K) / (temperature_K + SUTHERLAND_C_K));

  return {
    altitude_m: altitudeMeters,
    temperature_K,
    pressure_Pa,
    density_kg_m3,
    dynamicViscosity_Pa_s,
    speedOfSound_ms,
  };
}

// ---------------------------------------------------------------------------
// 2. Compressibility & Pressure Coefficient (Separated from Color-Map Clamping)
// ---------------------------------------------------------------------------

export interface PrandtlGlauertResult {
  regime: CompressibilityRegime;
  factor: number; // 1 / sqrt(1 - M^2) when 0.3 < M <= 0.7 (1.0 when M <= 0.3)
  beta: number; // sqrt(1 - M_eff^2)
}

/**
 * Evaluates compressibility regime and Prandtl-Glauert transformation factor:
 *  - M <= 0.3: incompressible (factor = 1.0)
 *  - 0.3 < M <= 0.7: subsonic small-disturbance Prandtl-Glauert, Cp_corr = Cp_0 / sqrt(1 - M^2)
 *  - M > 0.7: transonic-limit (factor capped at M=0.7 to avoid singularity; regime guardrail flags breakdown)
 */
export function computePrandtlGlauert(mach: number): PrandtlGlauertResult {
  assertNonNegative(mach, 'mach');
  if (mach <= 0.3) {
    return { regime: 'incompressible', factor: 1.0, beta: 1.0 };
  }
  if (mach <= 0.7) {
    const beta = Math.sqrt(1 - mach * mach);
    return { regime: 'prandtl-glauert', factor: 1 / beta, beta };
  }
  const betaCap = Math.sqrt(1 - 0.7 * 0.7);
  return { regime: 'transonic-limit', factor: 1 / betaCap, beta: betaCap };
}

/**
 * Computes raw incompressible pressure coefficient Cp,0 = 1 - (V / V_inf)^2.
 * Never applies display color-map clamping.
 */
export function computeRawCp(localVelocity_ms: number, freestreamVelocity_ms: number): number {
  assertNonNegative(localVelocity_ms, 'localVelocity_ms');
  assertPositive(freestreamVelocity_ms, 'freestreamVelocity_ms');
  const ratio = localVelocity_ms / freestreamVelocity_ms;
  return 1 - ratio * ratio;
}

/**
 * Applies Prandtl-Glauert small-disturbance subsonic compressibility correction
 * Cp_corr = Cp_0 / sqrt(1 - M^2) for 0.3 < M <= 0.7 (incompressible fallback for M <= 0.3).
 * Does NOT apply visual color-map clamping.
 */
export function applyPrandtlGlauertCp(cpIncompressible: number, mach: number): number {
  assertFinite(cpIncompressible, 'cpIncompressible');
  assertNonNegative(mach, 'mach');
  if (mach <= 0.3) return cpIncompressible;
  const mEff = Math.min(mach, 0.7);
  const beta = Math.sqrt(1 - mEff * mEff);
  return cpIncompressible / beta;
}

/**
 * Visual-only color-map clamping ([-3.5, 1.0]) for shader/particle rendering.
 * Kept strictly isolated from raw physical Cp.
 */
export function clampCpForColorMap(cp: number, minCp = -3.5, maxCp = 1.0): number {
  assertFinite(cp, 'cp');
  return Math.max(minCp, Math.min(maxCp, cp));
}

// ---------------------------------------------------------------------------
// 3. Dimensionless Numbers, Reynolds-Regime Indicator & Guardrails
// ---------------------------------------------------------------------------

export function classifyReynoldsRegime(reynolds: number): {
  reynoldsRegime: ReynoldsRegime;
  reynoldsRegimeLabel: string;
} {
  assertNonNegative(reynolds, 'reynolds');
  if (reynolds < 500_000) {
    return {
      reynoldsRegime: 'laminar-dominated',
      reynoldsRegimeLabel: 'Laminar-Dominated Re Indicator (< 5×10⁵; not a solved transition)',
    };
  }
  if (reynolds <= 3_000_000) {
    return {
      reynoldsRegime: 'transitional-regime',
      reynoldsRegimeLabel: 'Transitional Re Indicator (5×10⁵–3×10⁶; not a solved transition)',
    };
  }
  return {
    reynoldsRegime: 'turbulent-dominated',
    reynoldsRegimeLabel: 'Turbulent-Dominated Re Indicator (> 3×10⁶; not a solved transition)',
  };
}

export interface DimensionlessParametersResult {
  dynamicPressure_Pa: number;
  reynolds: number;
  reynoldsRegime: ReynoldsRegime;
  reynoldsRegimeLabel: string;
  mach: number;
  knudsen: number;
  prandtlGlauertFactor: number;
  compressibilityRegime: CompressibilityRegime;
  continuumValid: boolean;
  regimeWarnings: RegimeWarning[];
}

/**
 * Computes exact SI dimensionless numbers and physical regime validity guardrails.
 * Throws RangeError on non-finite or non-positive physical dimensions/fluid properties.
 */
export function computeDimensionlessAndGuardrails(params: {
  density_kg_m3: number;
  dynamicViscosity_Pa_s: number;
  speedOfSound_ms: number;
  velocity_ms: number;
  chord_m: number;
}): DimensionlessParametersResult {
  const density_kg_m3 = assertPositive(params.density_kg_m3, 'density_kg_m3');
  const dynamicViscosity_Pa_s = assertPositive(params.dynamicViscosity_Pa_s, 'dynamicViscosity_Pa_s');
  const speedOfSound_ms = assertPositive(params.speedOfSound_ms, 'speedOfSound_ms');
  const chord_m = assertPositive(params.chord_m, 'chord_m');
  const v = assertNonNegative(params.velocity_ms, 'velocity_ms');

  const dynamicPressure_Pa = 0.5 * density_kg_m3 * v * v;
  const mach = v / speedOfSound_ms;
  const reynolds = (density_kg_m3 * v * chord_m) / dynamicViscosity_Pa_s;

  // Kn = (M / Re) * sqrt(gamma * pi / 2)
  const knudsen =
    reynolds > 0
      ? (mach / reynolds) * Math.sqrt((ISA_CONSTANTS.GAMMA * Math.PI) / 2)
      : 0;

  const pg = computePrandtlGlauert(mach);
  const continuumValid = knudsen <= 0.01;
  const reInfo = classifyReynoldsRegime(reynolds);

  const regimeWarnings: RegimeWarning[] = [];

  if (mach >= 1.0) {
    regimeWarnings.push({
      code: 'MACH_SUPERSONIC',
      severity: 'critical',
      title: `Supersonic Limit (M = ${mach.toFixed(2)} ≥ 1.00)`,
      detail:
        'Incompressible Bernoulli & Prandtl–Glauert subsonic laws do not apply. Reduced-order engine uses Mach cone kinematics (μ = arcsin 1/M) and linearized Ackeret wave drag.',
    });
  } else if (mach > 0.7) {
    regimeWarnings.push({
      code: 'MACH_TRANSONIC_LIMIT',
      severity: 'warning',
      title: `Transonic Limit (M = ${mach.toFixed(2)} > 0.70)`,
      detail:
        'Prandtl–Glauert small-disturbance limit exceeded. Reduced-order potential flow omits shock–boundary-layer interaction; wave drag heuristic active.',
    });
  } else if (mach > 0.3) {
    regimeWarnings.push({
      code: 'MACH_COMPRESSIBLE',
      severity: 'info',
      title: `Compressible Subsonic (M = ${mach.toFixed(2)} > 0.30)`,
      detail: `Incompressible Bernoulli loses accuracy above M = 0.30. Small-disturbance Prandtl–Glauert correction Cp = Cp,0 / √(1 − M²) active (factor ×${pg.factor.toFixed(3)}).`,
    });
  }

  if (!continuumValid) {
    regimeWarnings.push({
      code: 'KNUDSEN_NON_CONTINUUM',
      severity: 'critical',
      title: `Continuum Breakdown (Kn = ${knudsen.toExponential(2)} > 0.01)`,
      detail:
        'Mean free path is significant relative to chord length. Continuum Navier–Stokes & no-slip boundary assumptions lose physical validity.',
    });
  }

  return {
    dynamicPressure_Pa,
    reynolds,
    reynoldsRegime: reInfo.reynoldsRegime,
    reynoldsRegimeLabel: reInfo.reynoldsRegimeLabel,
    mach,
    knudsen,
    prandtlGlauertFactor: pg.factor,
    compressibilityRegime: pg.regime,
    continuumValid,
    regimeWarnings,
  };
}

// ---------------------------------------------------------------------------
// 4. Finite-Wing Lifting-Line & Exact Drag Summation
// ---------------------------------------------------------------------------

export interface FiniteWingAeroResult {
  wingArea_m2: number;
  aspectRatio: number;
  inducedAlpha_rad: number;
  inducedAlpha_deg: number;
  downwashAngle_rad: number;
  downwashAngle_deg: number;
  cdi: number;
  equivalentCirculation_m2_s: number; // Gamma_eq = 0.5 * V_inf * c * CL
  ellipticRootCirculation_m2_s: number; // Gamma_0 = (2/pi) * V_inf * c * CL
  lift_N: number;
}

/**
 * Pure SI Prandtl Lifting-Line calculations for finite wing planform geometry:
 *  - S = b * c, AR = b^2 / S
 *  - alpha_i = CL / (pi * e * AR) [rad]
 *  - epsilon = 2 * alpha_i [rad] (far-wake Trefftz downwash)
 *  - CDi = CL^2 / (pi * e * AR)
 *  - Gamma_eq = 0.5 * V_inf * c * CL (equivalent uniform bound circulation inferred from total CL)
 *  - Gamma_0 = (2/pi) * V_inf * c * CL (elliptic spanwise vortex-model peak circulation)
 */
export function computeFiniteWingAerodynamics(params: {
  wingspan_m: number;
  chord_m: number;
  oswaldEfficiency: number;
  cl: number;
  velocity_ms: number;
  density_kg_m3: number;
}): FiniteWingAeroResult {
  const b = assertPositive(params.wingspan_m, 'wingspan_m');
  const c = assertPositive(params.chord_m, 'chord_m');
  const e = assertPositive(params.oswaldEfficiency, 'oswaldEfficiency');
  if (e > 1.0) {
    throw new RangeError(`Invalid physical parameter "oswaldEfficiency": must be <= 1.0, got ${e}.`);
  }
  const cl = assertFinite(params.cl, 'cl');
  const v = assertNonNegative(params.velocity_ms, 'velocity_ms');
  const rho = assertPositive(params.density_kg_m3, 'density_kg_m3');

  const wingArea_m2 = b * c;
  const aspectRatio = (b * b) / wingArea_m2;
  const inducedAlpha_rad = cl / (Math.PI * e * aspectRatio);
  const inducedAlpha_deg = (inducedAlpha_rad * 180) / Math.PI;
  const downwashAngle_rad = 2 * inducedAlpha_rad;
  const downwashAngle_deg = 2 * inducedAlpha_deg;
  const cdi = (cl * cl) / (Math.PI * e * aspectRatio);

  const equivalentCirculation_m2_s = 0.5 * v * c * cl;
  const ellipticRootCirculation_m2_s = (2 / Math.PI) * v * c * cl;
  const lift_N = 0.5 * rho * v * v * wingArea_m2 * cl;

  return {
    wingArea_m2,
    aspectRatio,
    inducedAlpha_rad,
    inducedAlpha_deg,
    downwashAngle_rad,
    downwashAngle_deg,
    cdi,
    equivalentCirculation_m2_s,
    ellipticRootCirculation_m2_s,
    lift_N,
  };
}

/**
 * Exact drag decomposition sum: CD = CD0 + CDi + CDsep + CDwave.
 */
export function computeTotalDrag(components: {
  cd0: number;
  cdi: number;
  cdSep: number;
  cdWave: number;
}): number {
  const cd0 = assertNonNegative(components.cd0, 'cd0');
  const cdi = assertNonNegative(components.cdi, 'cdi');
  const cdSep = assertNonNegative(components.cdSep, 'cdSep');
  const cdWave = assertNonNegative(components.cdWave, 'cdWave');
  return cd0 + cdi + cdSep + cdWave;
}

// ---------------------------------------------------------------------------
// 5. Flat-Plate Boundary-Layer Reference Estimates (Local vs Plate-Averaged)
// ---------------------------------------------------------------------------

export interface FlatPlateSkinFrictionResult {
  laminarLocalCf: number; // Blasius local Cf,x = 0.664 / sqrt(Re_x)
  laminarMeanCf: number; // Blasius plate-averaged Cf_bar = 1.328 / sqrt(Re)
  turbulentLocalCf: number; // Schlichting local Cf,x = 0.0592 / Re_x^0.2
  turbulentMeanCf: number; // Schlichting/Prandtl plate-averaged Cf_bar = 0.074 / Re^0.2
  isEmpiricalReference: true;
}

/**
 * Computes classic incompressible flat-plate skin-friction coefficients, explicitly
 * distinguishing local Cf(x) from chord/plate-averaged Cf_bar.
 */
export function computeFlatPlateSkinFriction(
  reynolds: number,
  reynoldsLocal = reynolds
): FlatPlateSkinFrictionResult {
  const re = assertPositive(reynolds, 'reynolds');
  const reX = assertPositive(reynoldsLocal, 'reynoldsLocal');

  return {
    laminarLocalCf: 0.664 / Math.sqrt(reX),
    laminarMeanCf: 1.328 / Math.sqrt(re),
    turbulentLocalCf: 0.0592 / Math.pow(reX, 0.2),
    turbulentMeanCf: 0.074 / Math.pow(re, 0.2),
    isEmpiricalReference: true,
  };
}

// ---------------------------------------------------------------------------
// 6. Empirical/Heuristic Transition, Separation & Surrogate Chordwise Cp Model
// ---------------------------------------------------------------------------

export interface ChordwiseCpIntegrationResult {
  stations: ChordwiseCpStation[];
  clUpper: number;
  clLower: number;
  clIntegrated: number;
  suctionPercentage: number;
  compressionPercentage: number;
  kuttaTeDeltaCp: number;
  separationXc: number;
  stagnationXc: number;
  xTransitionUpper: number;
  xTransitionLower: number;
  skinFrictionDrag_cdf: number;
  maxAdversePressureGrad: number;
  boundaryLayerRegime: 'Fully Laminar' | 'Transitional' | 'Turbulent Attached' | 'Separated';
  isEmpiricalEstimate: true;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const span = Math.max(1e-6, edge1 - edge0);
  const t = Math.max(0, Math.min(1, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

/**
 * Empirical/heuristic adverse-pressure-gradient separation onset estimate x_sep/c in [0.14, 1.0]
 * and Kirchhoff separated lift factor ((1 + sqrt(x_sep/c)) / 2)^2.
 * Note: Heuristic stall model — NOT a solved boundary-layer PDE prediction.
 */
export function computeSeparationOnset(params: {
  aoaDeg: number;
  posStallAngle: number;
  negStallAngle: number;
  reynolds: number;
  isBluffCylinder?: boolean;
}): {
  xSeparationUpper: number;
  kirchhoffLiftFactor: number;
  separationIntensity: number;
  isEmpiricalEstimate: true;
} {
  const { aoaDeg, posStallAngle, negStallAngle, reynolds, isBluffCylinder = false } = params;
  assertFinite(aoaDeg, 'aoaDeg');
  assertNonNegative(reynolds, 'reynolds');

  if (isBluffCylinder) {
    return {
      xSeparationUpper: 0.52,
      kirchhoffLiftFactor: 0.74,
      separationIntensity: 0.85,
      isEmpiricalEstimate: true,
    };
  }
  if (posStallAngle <= 0) {
    return {
      xSeparationUpper: 1.0,
      kirchhoffLiftFactor: 1.0,
      separationIntensity: 0,
      isEmpiricalEstimate: true,
    };
  }

  // Empirical Reynolds stall shift relative to Re = 3e6 reference
  const reLogRatio = Math.log10(Math.max(1e4, reynolds) / 3e6);
  const reStallShiftDeg = Math.max(-1.8, Math.min(1.8, reLogRatio * 0.85));

  const stallRef = aoaDeg >= 0
    ? Math.max(4, posStallAngle + reStallShiftDeg)
    : Math.max(4, negStallAngle + reStallShiftDeg);
  const absAoa = Math.abs(aoaDeg);

  // Empirical incipient trailing-edge separation threshold (~82% of stall angle)
  const onsetAngle = stallRef * 0.82;
  if (absAoa <= onsetAngle) {
    return {
      xSeparationUpper: 1.0,
      kirchhoffLiftFactor: 1.0,
      separationIntensity: 0,
      isEmpiricalEstimate: true,
    };
  }

  const excessRatio = (absAoa - onsetAngle) / Math.max(1.5, stallRef * 0.42);
  const xSep = Math.max(0.14, 1.0 / (1 + Math.pow(excessRatio, 1.85) * 1.45));
  const rootTerm = (1 + Math.sqrt(xSep)) * 0.5;
  const kirchhoffLiftFactor = rootTerm * rootTerm;
  const separationIntensity = Math.max(0, Math.min(1, 1 - xSep));

  return {
    xSeparationUpper: Number(xSep.toFixed(3)),
    kirchhoffLiftFactor,
    separationIntensity,
    isEmpiricalEstimate: true,
  };
}

/**
 * Reduced-order surrogate chordwise Cp & empirical boundary-layer estimator:
 * - Cosine-clustered stations along x/c in [0, 1].
 * - Analytical Kutta closure at trailing edge (gamma(1) = 0 => Delta Cp(1) -> 0).
 * - Prandtl-Glauert compressibility scaling Cp_corr = Cp_0 / sqrt(1 - M^2) up to M = 0.7 (raw physical values).
 * - Integrates CL_upper = int(-Cp_upper) d(x/c) and CL_lower = int(+Cp_lower) d(x/c).
 * - Evaluates empirical transition indicator x_tr/c(Re, dCp/dx) and integrates flat-plate
 *   Blasius (0.664/sqrt(Re_x)) + Schlichting (0.0592/Re_x^0.2) skin-friction reference CD,f.
 */
export function computeChordwiseCpAndLift(params: {
  targetCl: number;
  aoaDeg: number;
  mach: number;
  reynolds: number;
  thicknessRatio: number;
  camberRatio: number;
  flapsDeg: number;
  xSeparationUpper: number;
  isStalled: boolean;
  degPastStall: number;
  isBluffCylinder?: boolean;
  numStations?: number;
}): ChordwiseCpIntegrationResult {
  const {
    targetCl,
    aoaDeg,
    mach,
    reynolds,
    thicknessRatio,
    camberRatio,
    flapsDeg,
    xSeparationUpper,
    isStalled,
    degPastStall,
    isBluffCylinder = false,
    numStations = 48,
  } = params;

  assertFinite(targetCl, 'targetCl');
  assertFinite(aoaDeg, 'aoaDeg');
  assertNonNegative(mach, 'mach');
  assertNonNegative(reynolds, 'reynolds');

  const N = Math.max(24, numStations);
  const stations: ChordwiseCpStation[] = [];
  const reSafe = Math.max(1e3, reynolds);

  if (isBluffCylinder) {
    for (let i = 0; i <= N; i++) {
      const xc = i / N;
      const theta = xc * Math.PI;
      let cpBase0: number;
      if (xc <= 0.52) {
        cpBase0 = 1 - 4 * Math.pow(Math.sin(theta), 2) * 0.62;
      } else {
        const wakeT = (xc - 0.52) / 0.48;
        cpBase0 = -0.92 + 0.14 * wakeT;
      }
      const asym = targetCl * 0.78 * Math.sin(theta);
      const cpU0 = cpBase0 - asym;
      const cpL0 = cpBase0 + asym;
      const cpU = applyPrandtlGlauertCp(cpU0, mach);
      const cpL = applyPrandtlGlauertCp(cpL0, mach);

      const rex = Math.max(50, reSafe * Math.max(0.01, xc));
      const attachedMask = xc <= 0.52 ? 1 - smoothstep(0.48, 0.54, xc) : 0;
      const cf = (0.664 / Math.sqrt(rex)) * attachedMask;

      stations.push({
        xc: Number(xc.toFixed(4)),
        cpUpper: Number(cpU.toFixed(4)),
        cpLower: Number(cpL.toFixed(4)),
        cpUpperIncomp: Number(cpU0.toFixed(4)),
        cpLowerIncomp: Number(cpL0.toFixed(4)),
        cfUpper: Number(cf.toFixed(6)),
        cfLower: Number(cf.toFixed(6)),
      });
    }

    let clU = 0;
    let clL = 0;
    let cdf = 0;
    for (let i = 0; i < stations.length - 1; i++) {
      const dx = stations[i + 1].xc - stations[i].xc;
      clU += 0.5 * (-stations[i].cpUpper - stations[i + 1].cpUpper) * dx;
      clL += 0.5 * (stations[i].cpLower + stations[i + 1].cpLower) * dx;
      cdf +=
        0.5 *
        (stations[i].cfUpper + stations[i + 1].cfUpper + stations[i].cfLower + stations[i + 1].cfLower) *
        dx;
    }
    return {
      stations,
      clUpper: Number(clU.toFixed(4)),
      clLower: Number(clL.toFixed(4)),
      clIntegrated: Number((clU + clL).toFixed(4)),
      suctionPercentage: 50,
      compressionPercentage: 50,
      kuttaTeDeltaCp: Number(
        Math.abs(stations[stations.length - 1].cpLower - stations[stations.length - 1].cpUpper).toFixed(4)
      ),
      separationXc: 0.52,
      stagnationXc: 0.0,
      xTransitionUpper: 0.52,
      xTransitionLower: 0.52,
      skinFrictionDrag_cdf: Number(cdf.toFixed(5)),
      maxAdversePressureGrad: 3.8,
      boundaryLayerRegime: 'Separated',
      isEmpiricalEstimate: true,
    };
  }

  const tau = Math.max(0.03, Math.min(0.28, thicknessRatio));
  const rLe = 1.1019 * tau * tau;
  const leReg = 0.55 * rLe + 0.004;

  const xcArr: number[] = new Array(N + 1);
  const uThick: number[] = new Array(N + 1);
  const gShape: number[] = new Array(N + 1);

  const aoaWeight = Math.min(1.5, Math.max(-1.5, aoaDeg / 10));
  const camberWeight = Math.min(1.2, Math.max(0, camberRatio * 18));
  const flapWeight = Math.max(0, flapsDeg / 35) * 0.7;

  for (let i = 0; i <= N; i++) {
    const beta = (Math.PI * i) / N;
    const xc = 0.5 * (1 - Math.cos(beta));
    xcArr[i] = xc;

    const leFactor = Math.sqrt(xc / (xc + leReg));
    const crestBoost = 1.85 * tau * Math.pow(Math.max(0, 1 - xc), 0.45) * Math.pow(Math.sin(Math.PI * xc), 0.6);
    const teDecel = -0.14 * tau * xc * xc;
    uThick[i] = leFactor * (1 + crestBoost + teDecel);

    const gAlpha = Math.sqrt(Math.max(0, 1 - xc) / (xc + leReg));
    const gCamber = Math.sin(Math.PI * xc);
    const gFlap =
      flapWeight > 0
        ? Math.sin(Math.PI * xc) *
          (0.35 + 0.9 * Math.exp(-18 * (xc - 0.72) * (xc - 0.72))) *
          Math.sqrt(Math.max(0, 1 - xc))
        : 0;

    const dirWeight = Math.abs(aoaWeight) + 0.35 * camberWeight + 0.25 * flapWeight;
    const wA = dirWeight > 1e-4 ? (0.45 + 0.55 * (Math.abs(aoaWeight) / dirWeight)) : 1.0;
    const wC = camberWeight * 0.65;
    const wF = flapWeight * 0.75;

    gShape[i] = wA * gAlpha + wC * gCamber + wF * gFlap;
  }

  gShape[N] = 0;

  const separationXc = isStalled
    ? Math.min(xSeparationUpper, Math.max(0.14, 0.72 - Math.min(1, degPastStall / 15) * 0.54))
    : xSeparationUpper;

  const cpUpperArr: number[] = new Array(N + 1);
  const cpLowerArr: number[] = new Array(N + 1);
  const cpUpper0Arr: number[] = new Array(N + 1);
  const cpLower0Arr: number[] = new Array(N + 1);

  const evaluateForGamma = (kGamma: number, storeArrays: boolean) => {
    let clU = 0;
    let clL = 0;

    let prevXc = xcArr[0];
    let prevCpU = 0;
    let prevCpL = 0;

    const wakeCp0 = separationXc < 0.98
      ? -0.46 + 0.14 * Math.min(1, (1 - separationXc) * 1.4)
      : 0;

    const teBaseVel = uThick[N];
    const teCp0 = 1 - teBaseVel * teBaseVel;

    for (let i = 0; i <= N; i++) {
      const xc = xcArr[i];
      const ut = uThick[i];
      const dv = kGamma * gShape[i];

      const vu = ut + dv;
      const vl = ut - dv;

      let cpU0 = 1 - vu * vu;
      const cpL0 = 1 - vl * vl;

      if (separationXc < 0.99 && xc > separationXc) {
        const sNorm = (xc - separationXc) / Math.max(1e-4, 1 - separationXc);
        const sepBlend = 1 - Math.exp(-sNorm * 5.5);
        const teClosure = Math.pow(sNorm, 2.5);
        const targetSepCp0 = wakeCp0 * (1 - teClosure) + teCp0 * teClosure;
        cpU0 = cpU0 * (1 - sepBlend) + targetSepCp0 * sepBlend;
      }

      // Raw physical Prandtl-Glauert Cp (no artificial color-map clamping)
      const cpU = applyPrandtlGlauertCp(cpU0, mach);
      const cpL = applyPrandtlGlauertCp(cpL0, mach);

      if (storeArrays) {
        cpUpperArr[i] = cpU;
        cpLowerArr[i] = cpL;
        cpUpper0Arr[i] = cpU0;
        cpLower0Arr[i] = cpL0;
      }

      if (i > 0) {
        const dx = xc - prevXc;
        clU += 0.5 * (-prevCpU - cpU) * dx;
        clL += 0.5 * (prevCpL + cpL) * dx;
      }

      prevXc = xc;
      prevCpU = cpU;
      prevCpL = cpL;
    }

    return { clU, clL, clTotal: clU + clL };
  };

  let linearCrossIntegral = 0;
  for (let i = 1; i <= N; i++) {
    const dx = xcArr[i] - xcArr[i - 1];
    const f0 = 4 * uThick[i - 1] * gShape[i - 1];
    const f1 = 4 * uThick[i] * gShape[i];
    linearCrossIntegral += 0.5 * (f0 + f1) * dx;
  }

  const pg = computePrandtlGlauert(mach);
  let kGamma =
    linearCrossIntegral > 1e-5 ? (targetCl / pg.factor) / linearCrossIntegral : 0;

  if (Math.abs(targetCl) > 1e-4) {
    let k0 = kGamma;
    let e0 = evaluateForGamma(k0, false).clTotal - targetCl;
    if (Math.abs(e0) > 1e-4) {
      let k1 = k0 * (e0 > 0 ? 0.88 : 1.12);
      if (Math.abs(k1 - k0) < 1e-5) k1 = k0 + 0.02;
      let e1 = evaluateForGamma(k1, false).clTotal - targetCl;
      for (let iter = 0; iter < 6; iter++) {
        if (Math.abs(e1) < 1e-4 || Math.abs(e1 - e0) < 1e-7) break;
        const kNext = k1 - e1 * ((k1 - k0) / (e1 - e0));
        k0 = k1;
        e0 = e1;
        k1 = Math.max(-1.6, Math.min(1.6, kNext));
        e1 = evaluateForGamma(k1, false).clTotal - targetCl;
      }
      kGamma = k1;
    }
  }

  const finalRes = evaluateForGamma(kGamma, true);

  let stagnationXc = 0;
  let maxStagCp = -Infinity;
  for (let i = 0; i <= N && xcArr[i] <= 0.15; i++) {
    const cMax = Math.max(cpUpperArr[i], cpLowerArr[i]);
    if (cMax > maxStagCp) {
      maxStagCp = cMax;
      stagnationXc = xcArr[i];
    }
  }

  let peakIdxUpper = 0;
  let minCpUpper = Infinity;
  for (let i = 0; i <= N; i++) {
    if (cpUpperArr[i] < minCpUpper) {
      minCpUpper = cpUpperArr[i];
      peakIdxUpper = i;
    }
  }

  let peakIdxLower = 0;
  let minCpLower = Infinity;
  for (let i = 0; i <= N; i++) {
    if (cpLowerArr[i] < minCpLower) {
      minCpLower = cpLowerArr[i];
      peakIdxLower = i;
    }
  }

  let maxAdversePressureGrad = 0;
  let xTransitionUpper = 1.0;
  let xTransitionLower = 1.0;

  for (let i = 1; i <= N; i++) {
    const dx = Math.max(0.012, xcArr[i] - xcArr[i - 1]);
    const rex = reSafe * xcArr[i];

    const dCpUpperDx = (cpUpperArr[i] - cpUpperArr[i - 1]) / dx;
    if (i >= peakIdxUpper && xcArr[i] <= separationXc && dCpUpperDx > maxAdversePressureGrad) {
      maxAdversePressureGrad = dCpUpperDx;
    }

    if (xTransitionUpper === 1.0 && i > 1) {
      const apgU = i >= peakIdxUpper ? Math.max(0, dCpUpperDx) : 0;
      const reCritU = 1.15e6 / (1 + 2.2 * apgU);
      if (rex >= reCritU) {
        xTransitionUpper = xcArr[i];
      }
    }

    const dCpLowerDx = (cpLowerArr[i] - cpLowerArr[i - 1]) / dx;
    if (xTransitionLower === 1.0 && i > 1) {
      const apgL = i >= peakIdxLower ? Math.max(0, dCpLowerDx) : 0;
      const reCritL = 1.15e6 / (1 + 2.2 * apgL);
      if (rex >= reCritL) {
        xTransitionLower = xcArr[i];
      }
    }
  }

  xTransitionUpper = Math.min(xTransitionUpper, separationXc);

  let skinFrictionDrag_cdf = 0;
  for (let i = 0; i <= N; i++) {
    const xc = xcArr[i];
    const rex = Math.max(80, reSafe * Math.max(0.002, xc));
    const flatPlate = computeFlatPlateSkinFriction(reSafe, rex);
    const cfLam = flatPlate.laminarLocalCf;
    const cfTurb = flatPlate.turbulentLocalCf;

    const wTurbU =
      xTransitionUpper < 0.999 ? smoothstep(xTransitionUpper - 0.025, xTransitionUpper + 0.025, xc) : 0;
    const sepAttenU =
      separationXc < 0.99 ? 1 - smoothstep(separationXc - 0.02, separationXc + 0.04, xc) : 1;
    const cfUpper = (cfLam * (1 - wTurbU) + cfTurb * wTurbU) * sepAttenU;

    const wTurbL =
      xTransitionLower < 0.999 ? smoothstep(xTransitionLower - 0.025, xTransitionLower + 0.025, xc) : 0;
    const cfLower = cfLam * (1 - wTurbL) + cfTurb * wTurbL;

    stations.push({
      xc: Number(xc.toFixed(4)),
      cpUpper: Number(cpUpperArr[i].toFixed(4)),
      cpLower: Number(cpLowerArr[i].toFixed(4)),
      cpUpperIncomp: Number(cpUpper0Arr[i].toFixed(4)),
      cpLowerIncomp: Number(cpLower0Arr[i].toFixed(4)),
      cfUpper: Number(cfUpper.toFixed(6)),
      cfLower: Number(cfLower.toFixed(6)),
    });

    if (i > 0) {
      const dx = xc - xcArr[i - 1];
      const prev = stations[i - 1];
      const curr = stations[i];
      skinFrictionDrag_cdf += 0.5 * (prev.cfUpper + curr.cfUpper + prev.cfLower + curr.cfLower) * dx;
    }
  }

  const last = stations[stations.length - 1];
  const kuttaTeDeltaCp = last ? Math.abs(last.cpLower - last.cpUpper) : 0;

  let boundaryLayerRegime: ChordwiseCpIntegrationResult['boundaryLayerRegime'] = 'Transitional';
  if (separationXc < 0.95) {
    boundaryLayerRegime = 'Separated';
  } else if (xTransitionUpper >= 0.98 && xTransitionLower >= 0.98) {
    boundaryLayerRegime = 'Fully Laminar';
  } else if (xTransitionUpper <= 0.12) {
    boundaryLayerRegime = 'Turbulent Attached';
  }

  let suctionPercentage = 50;
  let compressionPercentage = 50;
  if (Math.abs(finalRes.clTotal) >= 0.01) {
    if (finalRes.clTotal >= 0) {
      const posUpper = Math.max(0, finalRes.clU);
      const posLower = Math.max(0, finalRes.clL);
      const denom = posUpper + posLower;
      if (denom > 1e-5) {
        suctionPercentage = (posUpper / denom) * 100;
        compressionPercentage = (posLower / denom) * 100;
      }
    } else {
      const negUpper = Math.max(0, -finalRes.clU);
      const negLower = Math.max(0, -finalRes.clL);
      const denom = negUpper + negLower;
      if (denom > 1e-5) {
        suctionPercentage = (negLower / denom) * 100;
        compressionPercentage = (negUpper / denom) * 100;
      }
    }
  }

  return {
    stations,
    clUpper: Number(finalRes.clU.toFixed(4)),
    clLower: Number(finalRes.clL.toFixed(4)),
    clIntegrated: Number(finalRes.clTotal.toFixed(4)),
    suctionPercentage: Number(suctionPercentage.toFixed(1)),
    compressionPercentage: Number(compressionPercentage.toFixed(1)),
    kuttaTeDeltaCp: Number(kuttaTeDeltaCp.toFixed(4)),
    separationXc: Number(separationXc.toFixed(3)),
    stagnationXc: Number(stagnationXc.toFixed(3)),
    xTransitionUpper: Number(xTransitionUpper.toFixed(3)),
    xTransitionLower: Number(xTransitionLower.toFixed(3)),
    skinFrictionDrag_cdf: Number(skinFrictionDrag_cdf.toFixed(5)),
    maxAdversePressureGrad: Number(maxAdversePressureGrad.toFixed(2)),
    boundaryLayerRegime,
    isEmpiricalEstimate: true,
  };
}
