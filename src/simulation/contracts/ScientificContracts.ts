import {
  computeDimensionlessAndGuardrails,
  computeFiniteWingAerodynamics,
  computeISA,
  computeTotalDrag,
  ISA_CONSTANTS,
} from '../../lib/aeroPhysics';
import {
  AircraftModelConfig,
  AircraftModelType,
  CompressibilityRegime,
  RegimeWarning,
  ReynoldsRegime,
} from '../../types/aerodynamics';

export interface CoordinateSystemSpec {
  noseAxis: '-X';
  upAxis: '+Y';
  spanAxis: '+Z';
  handedness: 'right-handed';
  units: 'SI';
  tunnelReferenceMaxDim: number;
  aerodynamicCenterFraction: number;
}

export const CANONICAL_COORDINATE_SYSTEM: CoordinateSystemSpec = {
  noseAxis: '-X',
  upAxis: '+Y',
  spanAxis: '+Z',
  handedness: 'right-handed',
  units: 'SI',
  tunnelReferenceMaxDim: 10.0,
  aerodynamicCenterFraction: 0.35,
};

/**
 * Single-source-of-truth thermodynamic and dimensionless flow conditions in SI units.
 * Dependent quantities (temperature, pressure, density, dynamicViscosity, speedOfSound,
 * mach, reynolds, knudsen, dynamicPressure) are strictly derived from ISA & SUTHERLAND equations.
 */
export interface FlowConditions {
  altitude: number; // m (0..20,000)
  velocity: number; // m/s
  chord: number; // m (reference length for Re & Kn)
  angleOfAttackDeg: number;
  flapsDeg: number;
  temperature: number; // K
  pressure: number; // Pa
  density: number; // kg/m^3
  dynamicViscosity: number; // Pa·s
  speedOfSound: number; // m/s
  dynamicPressure: number; // Pa
  mach: number;
  reynolds: number;
  knudsen: number;
  reynoldsRegime: ReynoldsRegime;
  compressibilityRegime: CompressibilityRegime;
  prandtlGlauertFactor: number;
  continuumValid: boolean;
  regimeWarnings: RegimeWarning[];
}

export interface AircraftGeometry {
  modelType: AircraftModelType;
  name: string;
  referenceArea: number; // m^2
  referenceChord: number; // m
  wingspan: number; // m
  aspectRatio: number; // b^2 / S
  oswaldEfficiency: number;
  sweepAngle: number; // deg
  thicknessRatio: number;
  camberRatio: number;
  coordinateSystem: CoordinateSystemSpec;
}

export interface AeroResult {
  liftCoefficient: number;
  dragCoefficient: number;
  momentCoefficient: number;
  lift: number; // N
  drag: number; // N
  ldRatio: number;
  reynolds: number;
  mach: number;
  cd0: number;
  cdi: number;
  cdSep: number;
  cdWave: number;
  inducedAlphaDeg: number;
  downwashAngleDeg: number;
  equivalentCirculation: number; // m^2/s
  ellipticRootCirculation: number; // m^2/s
  kuttaTeDeltaCp: number;
  isStalled: boolean;
  stallMarginDeg: number;
  flowState: string;
}

/**
 * Derives consistent SI `FlowConditions` from primary independent inputs `(altitude_m, velocity_ms, chord_m)`
 * so no engine or UI view can inject conflicting density, viscosity, Reynolds, or Mach values.
 */
export function deriveFlowConditions(params: {
  altitude_m: number;
  velocity_ms: number;
  chord_m: number;
  angleOfAttackDeg?: number;
  flapsDeg?: number;
}): FlowConditions {
  const clampedAlt = Math.max(0, Math.min(ISA_CONSTANTS.MAX_ALTITUDE_M, params.altitude_m));
  const safeVelocity = Math.max(0, params.velocity_ms);
  const safeChord = Math.max(1e-4, params.chord_m);

  const isa = computeISA(clampedAlt);
  const dim = computeDimensionlessAndGuardrails({
    density_kg_m3: isa.density_kg_m3,
    dynamicViscosity_Pa_s: isa.dynamicViscosity_Pa_s,
    speedOfSound_ms: isa.speedOfSound_ms,
    velocity_ms: safeVelocity,
    chord_m: safeChord,
  });

  return {
    altitude: isa.altitude_m,
    velocity: safeVelocity,
    chord: safeChord,
    angleOfAttackDeg: params.angleOfAttackDeg ?? 0,
    flapsDeg: params.flapsDeg ?? 0,
    temperature: isa.temperature_K,
    pressure: isa.pressure_Pa,
    density: isa.density_kg_m3,
    dynamicViscosity: isa.dynamicViscosity_Pa_s,
    speedOfSound: isa.speedOfSound_ms,
    dynamicPressure: dim.dynamicPressure_Pa,
    mach: dim.mach,
    reynolds: dim.reynolds,
    knudsen: dim.knudsen,
    reynoldsRegime: dim.reynoldsRegime,
    compressibilityRegime: dim.compressibilityRegime,
    prandtlGlauertFactor: dim.prandtlGlauertFactor,
    continuumValid: dim.continuumValid,
    regimeWarnings: dim.regimeWarnings,
  };
}

export function buildAircraftGeometryContract(cfg: AircraftModelConfig): AircraftGeometry {
  const referenceArea = cfg.wingspan * cfg.chord;
  const aspectRatio = (cfg.wingspan * cfg.wingspan) / Math.max(1e-6, referenceArea);
  return {
    modelType: cfg.id,
    name: cfg.name,
    referenceArea,
    referenceChord: cfg.chord,
    wingspan: cfg.wingspan,
    aspectRatio,
    oswaldEfficiency: cfg.oswaldEfficiency ?? 0.85,
    sweepAngle: cfg.sweepDeg ?? 0,
    thicknessRatio: cfg.thicknessRatio ?? 0.12,
    camberRatio: cfg.camberRatio ?? 0,
    coordinateSystem: CANONICAL_COORDINATE_SYSTEM,
  };
}

export function buildAeroResultFromForces(params: {
  geometry: AircraftGeometry;
  flow: FlowConditions;
  cl: number;
  cd0: number;
  cdSep: number;
  cdWave: number;
  cm?: number;
  kuttaTeDeltaCp?: number;
  isStalled: boolean;
  stallMarginDeg: number;
  flowState: string;
}): AeroResult {
  const finiteWing = computeFiniteWingAerodynamics({
    wingspan_m: params.geometry.wingspan,
    chord_m: params.geometry.referenceChord,
    oswaldEfficiency: params.geometry.oswaldEfficiency,
    cl: params.cl,
    velocity_ms: params.flow.velocity,
    density_kg_m3: params.flow.density,
  });

  const cd = computeTotalDrag({
    cd0: params.cd0,
    cdi: finiteWing.cdi,
    cdSep: params.cdSep,
    cdWave: params.cdWave,
  });

  const drag = params.flow.dynamicPressure * params.geometry.referenceArea * cd;
  const lift = finiteWing.lift_N;
  const ldRatio = drag > 1e-6 ? lift / drag : 0;

  return {
    liftCoefficient: params.cl,
    dragCoefficient: cd,
    momentCoefficient: params.cm ?? -0.25 * params.cl * 0.1,
    lift,
    drag,
    ldRatio,
    reynolds: params.flow.reynolds,
    mach: params.flow.mach,
    cd0: params.cd0,
    cdi: finiteWing.cdi,
    cdSep: params.cdSep,
    cdWave: params.cdWave,
    inducedAlphaDeg: finiteWing.inducedAlpha_deg,
    downwashAngleDeg: finiteWing.downwashAngle_deg,
    equivalentCirculation: finiteWing.equivalentCirculation_m2_s,
    ellipticRootCirculation: finiteWing.ellipticRootCirculation_m2_s,
    kuttaTeDeltaCp: params.kuttaTeDeltaCp ?? 0,
    isStalled: params.isStalled,
    stallMarginDeg: params.stallMarginDeg,
    flowState: params.flowState,
  };
}
