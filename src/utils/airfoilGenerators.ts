import { Point2D, PolygonSurfacePoint, AircraftModelType, AircraftModelConfig, AeroTelemetry, ChordwiseCpStation } from '../types/aerodynamics';
import { AeroCalibration, BoundingBoxDims, DEFAULT_CALIBRATION, formatModelClassLabel } from '../lib/calibration';
import {
  alphaSweep,
  type AlphaSweepResult,
  computeChordwiseCpAndLift,
  computeDimensionlessAndGuardrails,
  computeFiniteWingAerodynamics,
  computeFlatPlateSkinFriction,
  computeHelmboldLiftCurveSlopeRad,
  computeISA,
  computeSeparationOnset,
  computeTotalDrag,
  ISA_CONSTANTS,
  PRESET_PLANFORMS,
  SOLVER_LABEL_3D,
} from '../lib/aeroPhysics';

export const AIRCRAFT_MODELS: Record<AircraftModelType, AircraftModelConfig> = {
  f22: {
    id: 'f22',
    name: 'F-22 Raptor (Fighter)',
    category: 'Fighter',
    description: 'Stealth air dominance fighter with chined forebody, razor-thin diamond wing section, and vortex lift at high AoA.',
    wingspan: PRESET_PLANFORMS.f22.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.f22.wingArea_m2, // Published F-22 reference planform area (78.04 m^2)
    chord: PRESET_PLANFORMS.f22.wingArea_m2 / PRESET_PLANFORMS.f22.wingspan_m, // Mean geometric chord c_bar = S / b (5.76 m)
    sweepDeg: PRESET_PLANFORMS.f22.sweepDeg, // Assumed sweep Lambda at max-thickness line (30 deg)
    oswaldEfficiency: PRESET_PLANFORMS.f22.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.f22.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.f22.camberRatio,
    stallAngle: PRESET_PLANFORMS.f22.stallAngleDeg,
    cl0: PRESET_PLANFORMS.f22.cl0,
    alphaZeroLift: PRESET_PLANFORMS.f22.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.f22.clMax,
    cd0: PRESET_PLANFORMS.f22.cd0,
    flapCapable: PRESET_PLANFORMS.f22.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.f22.supersonicCapable,
    glbPath: '/models/f22_raptor.glb',
    hasGlbModel: true,
    referenceWeight_N: 294_000,
    nominalTestPoint: { aoaDeg: 5.0, airspeed_kts: 350, altitude_ft: 9843, flapsDeg: 0 },
  },
  airliner: {
    id: 'airliner',
    name: 'Boeing 787 (Transport)',
    category: 'Commercial',
    description: 'Transonic widebody airliner with supercritical high-lift cambered wing section and underslung high-bypass turbofan.',
    wingspan: PRESET_PLANFORMS.airliner.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.airliner.wingArea_m2, // Placeholder: published Boeing 787-8 reference wing area
    chord: PRESET_PLANFORMS.airliner.wingArea_m2 / PRESET_PLANFORMS.airliner.wingspan_m, // c_bar = S / b
    sweepDeg: PRESET_PLANFORMS.airliner.sweepDeg, // Placeholder: max-thickness line sweep
    oswaldEfficiency: PRESET_PLANFORMS.airliner.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.airliner.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.airliner.camberRatio,
    stallAngle: PRESET_PLANFORMS.airliner.stallAngleDeg,
    cl0: PRESET_PLANFORMS.airliner.cl0,
    alphaZeroLift: PRESET_PLANFORMS.airliner.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.airliner.clMax,
    cd0: PRESET_PLANFORMS.airliner.cd0,
    flapCapable: PRESET_PLANFORMS.airliner.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.airliner.supersonicCapable,
    glbPath: '/models/boeing_787.glb',
    hasGlbModel: true,
    referenceWeight_N: 2_230_000,
    nominalTestPoint: { aoaDeg: 2.5, airspeed_kts: 490, altitude_ft: 35000, flapsDeg: 0 },
  },
  naca2412: {
    id: 'naca2412',
    name: 'Airfoil Section (NACA 2412)',
    category: 'Airfoil',
    description: 'Classic cambered aviation airfoil (Cessna 172). 2% max camber at 40% chord with 12% thickness. Positive lift at 0° AoA.',
    wingspan: PRESET_PLANFORMS.naca2412.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.naca2412.wingArea_m2, // Placeholder: rectangular test wing (11.0 * 1.6 m^2)
    chord: PRESET_PLANFORMS.naca2412.wingArea_m2 / PRESET_PLANFORMS.naca2412.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.naca2412.sweepDeg, // Unswept rectangular section
    oswaldEfficiency: PRESET_PLANFORMS.naca2412.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.naca2412.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.naca2412.camberRatio,
    stallAngle: PRESET_PLANFORMS.naca2412.stallAngleDeg,
    cl0: PRESET_PLANFORMS.naca2412.cl0,
    alphaZeroLift: PRESET_PLANFORMS.naca2412.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.naca2412.clMax,
    cd0: PRESET_PLANFORMS.naca2412.cd0,
    flapCapable: PRESET_PLANFORMS.naca2412.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.naca2412.supersonicCapable,
    glbPath: '/models/airfoil.glb',
    hasGlbModel: true,
    nominalTestPoint: { aoaDeg: 4.0, airspeed_kts: 150, altitude_ft: 0, flapsDeg: 0 },
  },
  naca0012: {
    id: 'naca0012',
    name: 'NACA 0012 (Symmetric)',
    category: 'Airfoil',
    description: 'Zero camber symmetrical airfoil used on aerobatic aircraft and helicopter rotor blades. 0 lift at 0° AoA.',
    wingspan: PRESET_PLANFORMS.naca0012.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.naca0012.wingArea_m2, // Placeholder: rectangular test wing (10.0 * 1.5 m^2)
    chord: PRESET_PLANFORMS.naca0012.wingArea_m2 / PRESET_PLANFORMS.naca0012.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.naca0012.sweepDeg, // Unswept rectangular section
    oswaldEfficiency: PRESET_PLANFORMS.naca0012.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.naca0012.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.naca0012.camberRatio,
    stallAngle: PRESET_PLANFORMS.naca0012.stallAngleDeg,
    cl0: PRESET_PLANFORMS.naca0012.cl0,
    alphaZeroLift: PRESET_PLANFORMS.naca0012.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.naca0012.clMax,
    cd0: PRESET_PLANFORMS.naca0012.cd0,
    flapCapable: PRESET_PLANFORMS.naca0012.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.naca0012.supersonicCapable,
    glbPath: '/models/airfoil.glb',
    hasGlbModel: true,
    nominalTestPoint: { aoaDeg: 0.0, airspeed_kts: 150, altitude_ft: 0, flapsDeg: 0 },
  },
  validation_wing: {
    id: 'validation_wing',
    name: 'Validation Wing: Rectangular AR 6 (NACA 0012)',
    category: 'Airfoil',
    description: 'Unswept rectangular Prandtl lifting-line validation wing (b=9.0 m, c=1.5 m, AR=6.0 exact, e=0.95) at Re=3.0×10⁶, M=0.15.',
    wingspan: PRESET_PLANFORMS.validation_wing.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.validation_wing.wingArea_m2, // Exact rectangular AR = 6.0 planform
    chord: PRESET_PLANFORMS.validation_wing.wingArea_m2 / PRESET_PLANFORMS.validation_wing.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.validation_wing.sweepDeg, // Unswept rectangular wing
    oswaldEfficiency: PRESET_PLANFORMS.validation_wing.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.validation_wing.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.validation_wing.camberRatio,
    stallAngle: PRESET_PLANFORMS.validation_wing.stallAngleDeg,
    cl0: PRESET_PLANFORMS.validation_wing.cl0,
    alphaZeroLift: PRESET_PLANFORMS.validation_wing.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.validation_wing.clMax,
    cd0: PRESET_PLANFORMS.validation_wing.cd0,
    flapCapable: PRESET_PLANFORMS.validation_wing.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.validation_wing.supersonicCapable,
    nominalTestPoint: { aoaDeg: 6.0, airspeed_kts: 99, altitude_ft: 2750, flapsDeg: 0 },
  },
  custom_airfoil: {
    id: 'custom_airfoil',
    name: '2D Lab Airfoil (Custom Wing)',
    category: 'Airfoil',
    description: 'Extruded 3D finite wing built directly from your active 2D Airfoil Lab geometry, .dat upload, or Bézier shape edits.',
    wingspan: PRESET_PLANFORMS.custom_airfoil.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.custom_airfoil.wingArea_m2, // Placeholder: extruded rectangular wing
    chord: PRESET_PLANFORMS.custom_airfoil.wingArea_m2 / PRESET_PLANFORMS.custom_airfoil.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.custom_airfoil.sweepDeg,
    oswaldEfficiency: PRESET_PLANFORMS.custom_airfoil.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.custom_airfoil.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.custom_airfoil.camberRatio,
    stallAngle: PRESET_PLANFORMS.custom_airfoil.stallAngleDeg,
    cl0: PRESET_PLANFORMS.custom_airfoil.cl0,
    alphaZeroLift: PRESET_PLANFORMS.custom_airfoil.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.custom_airfoil.clMax,
    cd0: PRESET_PLANFORMS.custom_airfoil.cd0,
    flapCapable: PRESET_PLANFORMS.custom_airfoil.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.custom_airfoil.supersonicCapable,
    nominalTestPoint: { aoaDeg: 4.0, airspeed_kts: 150, altitude_ft: 0, flapsDeg: 0 },
  },
  custom_glb: {
    id: 'custom_glb',
    name: 'Custom .glb Model',
    category: 'Commercial',
    description: 'User-uploaded 3D GLB mesh analyzed and calibrated locally via 3D PCA and geometric surface analysis.',
    wingspan: PRESET_PLANFORMS.custom_glb.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.custom_glb.wingArea_m2, // Placeholder prior to user .glb upload
    chord: PRESET_PLANFORMS.custom_glb.wingArea_m2 / PRESET_PLANFORMS.custom_glb.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.custom_glb.sweepDeg, // Placeholder prior to user .glb calibration
    oswaldEfficiency: PRESET_PLANFORMS.custom_glb.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.custom_glb.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.custom_glb.camberRatio,
    stallAngle: PRESET_PLANFORMS.custom_glb.stallAngleDeg,
    cl0: PRESET_PLANFORMS.custom_glb.cl0,
    alphaZeroLift: PRESET_PLANFORMS.custom_glb.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.custom_glb.clMax,
    cd0: PRESET_PLANFORMS.custom_glb.cd0,
    flapCapable: PRESET_PLANFORMS.custom_glb.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.custom_glb.supersonicCapable,
    hasGlbModel: true,
    nominalTestPoint: { aoaDeg: 4.0, airspeed_kts: 250, altitude_ft: 5000, flapsDeg: 0 },
  },
  concorde: {
    id: 'concorde',
    name: 'Concorde (SST Cruiser)',
    category: 'Supersonic',
    description: 'Slender ogival delta wing optimized for Mach 2.04 cruise. Sharp leading edge producing sharp Mach shockwaves.',
    wingspan: PRESET_PLANFORMS.concorde.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.concorde.wingArea_m2, // Placeholder: published Concorde ogival delta area
    chord: PRESET_PLANFORMS.concorde.wingArea_m2 / PRESET_PLANFORMS.concorde.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.concorde.sweepDeg, // Placeholder: effective delta max-thickness sweep
    oswaldEfficiency: PRESET_PLANFORMS.concorde.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.concorde.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.concorde.camberRatio,
    stallAngle: PRESET_PLANFORMS.concorde.stallAngleDeg,
    cl0: PRESET_PLANFORMS.concorde.cl0,
    alphaZeroLift: PRESET_PLANFORMS.concorde.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.concorde.clMax,
    cd0: PRESET_PLANFORMS.concorde.cd0,
    flapCapable: PRESET_PLANFORMS.concorde.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.concorde.supersonicCapable,
    glbPath: '/models/concorde_free_with_interior.glb',
    hasGlbModel: true,
    referenceWeight_N: 1_815_000,
    nominalTestPoint: { aoaDeg: 3.0, airspeed_kts: 450, altitude_ft: 25000, flapsDeg: 0 },
  },
  cylinder: {
    id: 'cylinder',
    name: 'Circular Cylinder (Bluff Body)',
    category: 'Bluff Body',
    description: 'Classic fluid dynamics baseline object showcasing symmetric boundary layer separation and von Kármán vortex streets.',
    wingspan: PRESET_PLANFORMS.cylinder.wingspan_m,
    wingArea_m2: PRESET_PLANFORMS.cylinder.wingArea_m2, // Placeholder: projected cylinder area (b * D)
    chord: PRESET_PLANFORMS.cylinder.wingArea_m2 / PRESET_PLANFORMS.cylinder.wingspan_m,
    sweepDeg: PRESET_PLANFORMS.cylinder.sweepDeg,
    oswaldEfficiency: PRESET_PLANFORMS.cylinder.oswaldEfficiency,
    thicknessRatio: PRESET_PLANFORMS.cylinder.thicknessRatio,
    camberRatio: PRESET_PLANFORMS.cylinder.camberRatio,
    stallAngle: PRESET_PLANFORMS.cylinder.stallAngleDeg,
    cl0: PRESET_PLANFORMS.cylinder.cl0,
    alphaZeroLift: PRESET_PLANFORMS.cylinder.alphaZeroLiftDeg,
    clMax: PRESET_PLANFORMS.cylinder.clMax,
    cd0: PRESET_PLANFORMS.cylinder.cd0,
    flapCapable: PRESET_PLANFORMS.cylinder.flapCapable,
    supersonicCapable: PRESET_PLANFORMS.cylinder.supersonicCapable,
    nominalTestPoint: { aoaDeg: 0.0, airspeed_kts: 140, altitude_ft: 1000, flapsDeg: 0 },
  }
};

let activeCustomCoords: [number, number][] = [];

export function setCustom3DAirfoilConfig(cfg: {
  name: string;
  coords: [number, number][];
  cl0: number;
  alphaZeroLift: number;
  clMax: number;
  cd0: number;
  stallAngle: number;
}) {
  activeCustomCoords = cfg.coords.map(([x, y]) => [x, y]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of activeCustomCoords) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const estThickness = Number.isFinite(maxY - minY) ? Math.max(0.04, Math.min(0.28, maxY - minY)) : 0.12;
  const estCamber = Math.max(0, Math.min(0.08, Math.abs(cfg.cl0) / (2 * Math.PI * 1.8)));

  AIRCRAFT_MODELS.custom_airfoil.name = `${cfg.name} (2D Lab 3D Wing)`;
  AIRCRAFT_MODELS.custom_airfoil.cl0 = cfg.cl0;
  AIRCRAFT_MODELS.custom_airfoil.alphaZeroLift = cfg.alphaZeroLift;
  AIRCRAFT_MODELS.custom_airfoil.clMax = cfg.clMax;
  AIRCRAFT_MODELS.custom_airfoil.cd0 = cfg.cd0;
  AIRCRAFT_MODELS.custom_airfoil.stallAngle = cfg.stallAngle;
  AIRCRAFT_MODELS.custom_airfoil.thicknessRatio = Number(estThickness.toFixed(3));
  AIRCRAFT_MODELS.custom_airfoil.camberRatio = Number(estCamber.toFixed(4));
}

export function getCustom3DAirfoilCoords(): [number, number][] {
  return activeCustomCoords;
}

let activeCustomGlbCalibration: AeroCalibration = { ...DEFAULT_CALIBRATION };

export function setCustom3DGlbConfig(
  fileName: string,
  calibration: AeroCalibration,
  bounds?: BoundingBoxDims
) {
  activeCustomGlbCalibration = { ...calibration };
  const cleanName = fileName.replace(/\.glb$/i, '').trim() || 'Custom 3D Model';
  const classLabel = formatModelClassLabel(calibration.modelClass);

  // Derive realistic aspect geometry from unit-normalized oriented proportions
  const spanRatio = bounds ? Math.max(0.35, Math.min(2.4, bounds.z / Math.max(0.25, bounds.x))) : 1.0;
  const refChord = calibration.modelClass === 'glider' ? 1.8 : calibration.modelClass === 'car' || calibration.modelClass === 'bluff_body' ? 4.2 : 4.0;
  const refSpan =
    calibration.modelClass === 'glider'
      ? 18.0
      : calibration.modelClass === 'rocket' || calibration.modelClass === 'bluff_body'
        ? 2.6
        : calibration.modelClass === 'car'
          ? 2.2
          : Math.max(4.5, Math.min(36.0, refChord * spanRatio * 2.4));

  const slopePerRad = Math.max(0.5, calibration.liftSlope);
  const clMax =
    calibration.stallAngleDeg > 0
      ? Number(
          Math.max(
            0.3,
            Math.min(2.6, calibration.cl0 + slopePerRad * ((calibration.stallAngleDeg * Math.PI) / 180) * 0.88)
          ).toFixed(2)
        )
      : 0.25;

  const zeroLiftAlphaDeg =
    slopePerRad > 0.2
      ? Number((-(calibration.cl0 / slopePerRad) * (180 / Math.PI)).toFixed(2))
      : 0;

  const category: AircraftModelConfig['category'] =
    calibration.modelClass === 'delta_fighter'
      ? 'Fighter'
      : calibration.modelClass === 'bluff_body' || calibration.modelClass === 'car'
        ? 'Bluff Body'
        : calibration.modelClass === 'rocket'
          ? 'Supersonic'
          : 'Commercial';

  AIRCRAFT_MODELS.custom_glb.name = `${cleanName} (${classLabel})`;
  AIRCRAFT_MODELS.custom_glb.category = category;
  AIRCRAFT_MODELS.custom_glb.description = `Uploaded 3D .glb calibrated as ${classLabel}. Nose aligned to -X, Oswald e=${calibration.oswaldEfficiency.toFixed(2)}, CLα=${calibration.liftSlope.toFixed(2)} rad⁻¹.`;
  AIRCRAFT_MODELS.custom_glb.wingspan = Number(refSpan.toFixed(2));
  AIRCRAFT_MODELS.custom_glb.wingArea_m2 = Number((refSpan * refChord).toFixed(2));
  AIRCRAFT_MODELS.custom_glb.chord = Number(
    (AIRCRAFT_MODELS.custom_glb.wingArea_m2 / AIRCRAFT_MODELS.custom_glb.wingspan).toFixed(3)
  );
  AIRCRAFT_MODELS.custom_glb.sweepDeg = calibration.modelClass === 'delta_fighter' ? 48 : calibration.modelClass === 'airliner' ? 30 : 12;
  AIRCRAFT_MODELS.custom_glb.oswaldEfficiency = calibration.oswaldEfficiency;
  AIRCRAFT_MODELS.custom_glb.thicknessRatio =
    calibration.modelClass === 'delta_fighter' ? 0.06 : calibration.modelClass === 'glider' ? 0.14 : 0.10;
  AIRCRAFT_MODELS.custom_glb.camberRatio = Math.max(0, Math.min(0.05, Math.abs(calibration.cl0) * 0.08));
  AIRCRAFT_MODELS.custom_glb.stallAngle = calibration.stallAngleDeg;
  AIRCRAFT_MODELS.custom_glb.cl0 = calibration.cl0;
  AIRCRAFT_MODELS.custom_glb.alphaZeroLift = zeroLiftAlphaDeg;
  AIRCRAFT_MODELS.custom_glb.clMax = clMax;
  AIRCRAFT_MODELS.custom_glb.cd0 = calibration.cd0;
  AIRCRAFT_MODELS.custom_glb.supersonicCapable =
    calibration.modelClass === 'delta_fighter' ||
    calibration.modelClass === 'rocket' ||
    calibration.cruiseSpeedMs >= 300;
}

export function getCustom3DGlbCalibration(): AeroCalibration {
  return activeCustomGlbCalibration;
}

/**
 * International Standard Atmosphere (ISA) UI wrapper (valid 0–20,000 m / 0–65,617 ft),
 * clamping UI foot inputs cleanly to [0, 20,000 m] and delegating strictly to computeISA().
 */
export function getAtmosphere(altitude_ft: number) {
  const altM = Math.max(0, Math.min(ISA_CONSTANTS.MAX_ALTITUDE_M, altitude_ft * ISA_CONSTANTS.FT_TO_M));
  const isa = computeISA(altM);
  return {
    ...isa,
    speedOfSound_kts: isa.speedOfSound_ms / ISA_CONSTANTS.KTS_TO_MS,
  };
}

/**
 * Solves for ISA altitude (ft) and airspeed (kts) that match a target wind-tunnel
 * Reynolds number (default 3.0×10^6) and Mach number (default 0.15) for NACA 0012 / 2412 / AR-6 Validation Wing.
 */
export function computeBenchmarkMatchConditions(
  modelType: 'naca0012' | 'naca2412' | 'validation_wing',
  targetRe = 3_000_000,
  targetMach = 0.15
): { altitude_ft: number; airspeed_kts: number; actualRe: number; actualMach: number } {
  const chord = AIRCRAFT_MODELS[modelType].chord;
  let lo = 0;
  let hi: number = ISA_CONSTANTS.MAX_ALTITUDE_M;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    const isa = computeISA(mid);
    const v = targetMach * isa.speedOfSound_ms;
    const re = (isa.density_kg_m3 * v * chord) / isa.dynamicViscosity_Pa_s;
    if (re > targetRe) lo = mid;
    else hi = mid;
  }
  const bestM = 0.5 * (lo + hi);
  const isaBest = computeISA(bestM);
  const vBest = targetMach * isaBest.speedOfSound_ms;
  const altitude_ft = Math.round(bestM / ISA_CONSTANTS.FT_TO_M);
  const airspeed_kts = Number((vBest / ISA_CONSTANTS.KTS_TO_MS).toFixed(1));
  const clampedM = Math.max(0, Math.min(ISA_CONSTANTS.MAX_ALTITUDE_M, altitude_ft * ISA_CONSTANTS.FT_TO_M));
  const isaFinal = computeISA(clampedM);
  const vFinal = airspeed_kts * ISA_CONSTANTS.KTS_TO_MS;
  return {
    altitude_ft,
    airspeed_kts,
    actualRe: Math.round((isaFinal.density_kg_m3 * vFinal * chord) / isaFinal.dynamicViscosity_Pa_s),
    actualMach: Number((vFinal / isaFinal.speedOfSound_ms).toFixed(3)),
  };
}

/**
 * Returns the nominal flight test point (AoA, Airspeed, Altitude, Flaps) for a given aircraft preset,
 * preventing stale extreme speeds/altitudes from carrying over across model switches.
 */
export function getNominalPresetState(
  modelType: AircraftModelType,
  customCalibration?: AeroCalibration | null
): { angle_of_attack: number; airspeed_kts: number; altitude_ft: number; flaps_deg: number } {
  if (modelType === 'custom_glb' && customCalibration) {
    const suggestedKts = Math.max(20, Math.min(1200, Math.round(customCalibration.cruiseSpeedMs * 1.94384)));
    const suggestedAoa = Math.max(
      customCalibration.aoaMinDeg,
      Math.min(customCalibration.aoaMaxDeg, customCalibration.stallAngleDeg > 0 ? Math.min(4, customCalibration.aoaMaxDeg) : 0)
    );
    return {
      angle_of_attack: suggestedAoa,
      airspeed_kts: suggestedKts,
      altitude_ft: 5000,
      flaps_deg: 0,
    };
  }
  if (modelType === 'validation_wing') {
    const match = computeBenchmarkMatchConditions('validation_wing', 3_000_000, 0.15);
    return {
      angle_of_attack: 6.0,
      airspeed_kts: Math.round(match.airspeed_kts),
      altitude_ft: match.altitude_ft,
      flaps_deg: 0,
    };
  }
  const config = AIRCRAFT_MODELS[modelType];
  const nominal = config.nominalTestPoint ?? { aoaDeg: 4.0, airspeed_kts: 150, altitude_ft: 0, flapsDeg: 0 };
  return {
    angle_of_attack: nominal.aoaDeg,
    airspeed_kts: nominal.airspeed_kts,
    altitude_ft: nominal.altitude_ft,
    flaps_deg: config.flapCapable ? (nominal.flapsDeg ?? 0) : 0,
  };
}

/**
 * NACA 4-digit airfoil profile generator (normalized chord 0 to 1)
 */
function generateNaca4Digit(m: number, p: number, t: number, numPoints = 60, flapDeg = 0): Point2D[] {
  const upper: Point2D[] = [];
  const lower: Point2D[] = [];

  for (let i = 0; i <= numPoints; i++) {
    // Cosine spacing clustering points near leading edge
    const beta = (Math.PI * i) / numPoints;
    const x = 0.5 * (1 - Math.cos(beta));

    // Thickness distribution
    const yt = 5 * t * (
      0.2969 * Math.sqrt(Math.max(0.00001, x)) -
      0.1260 * x -
      0.3516 * Math.pow(x, 2) +
      0.2843 * Math.pow(x, 3) -
      0.1015 * Math.pow(x, 4)
    );

    // Camber and gradient
    let yc = 0;
    let dyc_dx = 0;

    if (p > 0 && m > 0) {
      if (x < p) {
        yc = (m / Math.pow(p, 2)) * (2 * p * x - Math.pow(x, 2));
        dyc_dx = ((2 * m) / Math.pow(p, 2)) * (p - x);
      } else {
        yc = (m / Math.pow(1 - p, 2)) * ((1 - 2 * p) + 2 * p * x - Math.pow(x, 2));
        dyc_dx = ((2 * m) / Math.pow(1 - p, 2)) * (p - x);
      }
    }

    // Apply trailing-edge flap deflection if active (> 70% chord)
    let flapYOffset = 0;
    if (flapDeg > 0 && x > 0.7) {
      const flapRad = (flapDeg * Math.PI) / 180;
      const flapHinge = 0.7;
      flapYOffset = -(x - flapHinge) * Math.sin(flapRad);
    }

    const theta = Math.atan(dyc_dx);
    const xu = x - yt * Math.sin(theta);
    const yu = yc + yt * Math.cos(theta) + flapYOffset;
    const xl = x + yt * Math.sin(theta);
    const yl = yc - yt * Math.cos(theta) + flapYOffset;

    upper.push({ x: xu, y: yu });
    lower.push({ x: xl, y: yl });
  }

  // Combine: from trailing edge along lower surface to leading edge, then along upper surface to trailing edge
  const polygon: Point2D[] = [];
  for (let i = lower.length - 1; i >= 0; i--) {
    polygon.push(lower[i]);
  }
  for (let i = 1; i < upper.length; i++) {
    polygon.push(upper[i]);
  }

  return polygon;
}

/**
 * F-22 Raptor Jet profile generator (normalized chord ~ -0.5 to 0.5)
 */
function generateF22Profile(): Point2D[] {
  // Authentic side cross-section coordinates with chined nose, canopy, dorsal spine, twin engines, afterburner nozzle
  const rawPoints: [number, number][] = [
    [-0.50, 0.00],   // Pitot nose tip
    [-0.44, 0.025],  // Chined forebody
    [-0.35, 0.05],   // Cockpit canopy start
    [-0.24, 0.09],   // Cockpit apex
    [-0.14, 0.075],  // Canopy aft blend
    [-0.05, 0.065],  // Dorsal fuselage
    [0.10, 0.055],   // Wing root blend
    [0.25, 0.045],   // Engine hump
    [0.40, 0.035],   // Tailcone
    [0.48, 0.030],   // 2D Thrust vectoring nozzle upper
    [0.50, 0.000],   // Nozzle center
    [0.48, -0.025],  // Nozzle lower
    [0.38, -0.035],  // Engine lower bay
    [0.18, -0.045],  // Main weapon bay belly
    [-0.02, -0.060], // Lower inlet duct
    [-0.15, -0.070], // Caret inlet lip
    [-0.28, -0.040], // Forward lower chine
    [-0.42, -0.015], // Lower radome
  ];

  return rawPoints.map(([x, y]) => ({ x: x + 0.5, y }));
}

/**
 * Boeing 787 Airliner profile generator with flap capability
 */
function generateAirlinerProfile(flapDeg = 0): Point2D[] {
  const flapRad = (Math.max(0, flapDeg) * Math.PI) / 180;
  const flapDY = flapDeg > 0 ? Math.sin(flapRad) * 0.08 : 0;
  const flapDX = flapDeg > 0 ? (1 - Math.cos(flapRad)) * 0.03 : 0;

  const rawPoints: [number, number][] = [
    [-0.50, 0.01],
    [-0.46, 0.04],
    [-0.38, 0.08],  // Flight deck cockpit
    [-0.28, 0.095], // Forward cabin roof
    [-0.10, 0.09],  // Mid fuselage
    [0.05, 0.12],   // Wing-to-body fairing / wing crest
    [0.22, 0.07],   // Aft wing fairing
    [0.35 - flapDX, 0.04 - flapDY], // Upper trailing edge / flap
    [0.48 - flapDX, 0.01 - flapDY], // Flap tip
    [0.44 - flapDX, -0.03 - flapDY],// Flap bottom
    [0.25, -0.04],  // Lower wing root
    [0.10, -0.12],  // Engine pylon / nacelle bottom
    [-0.02, -0.14], // Engine inlet bottom
    [-0.05, -0.09], // Engine cowl inside
    [-0.15, -0.05], // Forward belly
    [-0.32, -0.05], // Nose gear well
    [-0.45, -0.02], // Radome lower
  ];

  return rawPoints.map(([x, y]) => ({ x: x + 0.5, y }));
}

/**
 * Concorde Supersonic Ogive profile generator
 */
function generateConcordeProfile(): Point2D[] {
  const rawPoints: [number, number][] = [
    [-0.52, 0.00],  // Needle probe
    [-0.46, 0.015], // Droop nose cap
    [-0.34, 0.035], // Visor windshield
    [-0.18, 0.042], // Slender fuselage
    [0.02, 0.038],  // Ogival wing root
    [0.22, 0.030],  // Delta wing deck
    [0.42, 0.020],  // Elevon trailing edge
    [0.50, 0.015],  // Tail nozzle
    [0.48, -0.015], // Lower nozzle
    [0.26, -0.035], // Olympus engine box
    [0.08, -0.040], // Double engine intake ramp
    [-0.08, -0.025],// Lower fuselage
    [-0.26, -0.022],// Forward fuselage
    [-0.44, -0.012],// Lower nose
  ];

  return rawPoints.map(([x, y]) => ({ x: x + 0.5, y }));
}

/**
 * Circular Cylinder profile
 */
function generateCylinderProfile(numPoints = 36): Point2D[] {
  const pts: Point2D[] = [];
  const radius = 0.22;
  for (let i = 0; i < numPoints; i++) {
    const angle = (2 * Math.PI * i) / numPoints;
    pts.push({
      x: 0.5 + Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return pts;
}

/**
 * Get base polygon for model type
 */
export function getBasePolygon(type: AircraftModelType, flapDeg = 0): Point2D[] {
  switch (type) {
    case 'f22':
      return generateF22Profile();
    case 'airliner':
      return generateAirlinerProfile(flapDeg);
    case 'naca2412':
      return generateNaca4Digit(0.02, 0.4, 0.12, 60, flapDeg);
    case 'naca0012':
    case 'validation_wing':
      return generateNaca4Digit(0.0, 0.0, 0.12, 60, flapDeg);
    case 'custom_airfoil':
      if (activeCustomCoords.length >= 6) {
        const flapRad = (Math.max(0, flapDeg) * Math.PI) / 180;
        return activeCustomCoords.map(([x, y]) => {
          if (flapRad > 0 && x > 0.7) {
            return { x, y: y - (x - 0.7) * Math.sin(flapRad) };
          }
          return { x, y };
        });
      }
      return generateNaca4Digit(0.0, 0.0, 0.12, 60, flapDeg);
    case 'concorde':
      return generateConcordeProfile();
    case 'cylinder':
      return generateCylinderProfile();
    default:
      return generateNaca4Digit(0.02, 0.4, 0.12, 60, flapDeg);
  }
}

/**
 * Scale and rotate model polygon by Angle of Attack in canvas screen coordinates
 */
export function transformModelPolygon(
  basePolygon: Point2D[],
  cx: number,
  cy: number,
  chordLengthPx: number,
  aoaDeg: number
): Point2D[] {
  // In aerodynamics, positive AoA pitches the nose UP.
  // In canvas, screen Y is inverted (0 at top, height at bottom).
  const aoaRad = (aoaDeg * Math.PI) / 180;
  const cosA = Math.cos(aoaRad);
  const sinA = Math.sin(aoaRad);

  // Aerodynamic center / pivot is at 25% chord (x = 0.25)
  const pivotX = 0.25;
  const pivotY = 0.0;

  return basePolygon.map((p) => {
    // Relative to pivot (Cartesian: x right, y up)
    const rx = (p.x - pivotX) * chordLengthPx;
    const ry = (p.y - pivotY) * chordLengthPx;

    // Rotate pitch: AoA > 0 pitches nose up (rotY > 0)
    const rotX = rx * cosA + ry * sinA;
    const rotY = -rx * sinA + ry * cosA;

    return {
      x: cx + rotX,
      y: cy - rotY, // Canvas screen Y increases downwards
    };
  });
}

/**
 * Calculate outward surface normal vectors and chord fraction for pressure visualization
 */
export function getSurfacePointsWithNormals(polygon: Point2D[]): PolygonSurfacePoint[] {
  const result: PolygonSurfacePoint[] = [];
  const n = polygon.length;
  if (n < 3) return result;

  // Find min/max X to compute chord fraction
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const chord = Math.max(1, maxX - minX);

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    // Tangent vector
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;

    // Outward normal in screen space (pointing away from interior)
    const nx = dy / len;
    const ny = -dx / len;

    const chordFraction = Math.max(0, Math.min(1, (curr.x - minX) / chord));
    const isUpper = ny < 0; // Negative Y in canvas is UP

    result.push({
      x: curr.x,
      y: curr.y,
      nx,
      ny,
      isUpper,
      chordFraction,
    });
  }

  return result;
}

/**
 * Fast Point-in-Polygon test (Ray casting algorithm)
 */
export function isPointInPolygon(px: number, py: number, polygon: Point2D[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns positive and negative critical stall angles (as positive magnitudes in degrees).
 * Symmetric zero-camber sections (e.g. NACA 0012 with 0 flaps) have symmetric stall angles.
 */
export function getEffectiveStallAngles(
  type: AircraftModelType,
  flapDeg = 0
): { posStallAngle: number; negStallAngle: number } {
  const config = AIRCRAFT_MODELS[type];
  if (config.stallAngle <= 0) {
    return { posStallAngle: 0, negStallAngle: 0 };
  }
  const effectiveFlap = config.flapCapable ? flapDeg : 0;
  const posStallAngle = Math.max(4, config.stallAngle - (effectiveFlap > 15 ? 2.5 : 0));
  const isSymmetric = config.cl0 === 0 && effectiveFlap === 0;
  const negStallAngle = isSymmetric
    ? posStallAngle
    : Number((posStallAngle * 0.8).toFixed(1));
  return { posStallAngle, negStallAngle };
}

/**
 * Finite-wing lift curve slope CLα (per degree) incorporating aspect ratio,
 * max-thickness sweep Lambda, compressibility beta = sqrt(1 - M^2), and eta = 0.95.
 */
export function calculateFiniteWingLiftSlopePerDeg(
  aspectRatio: number,
  sweepDeg: number,
  mach: number
): number {
  return computeHelmboldLiftCurveSlopeRad(aspectRatio, sweepDeg, mach, 0.95) * (Math.PI / 180);
}

/**
 * Internal SI aerodynamic solver returning telemetry + chordwise Cp stations.
 * All internal variables are strictly SI (m, s, kg, Pa, K, rad).
 */
export function solveAeroStateSI(
  type: AircraftModelType,
  aoaDeg: number,
  airspeedMs: number,
  altitudeM: number,
  flapDeg: number
): { telemetry: AeroTelemetry; cpStations: ChordwiseCpStation[] } {
  const config = AIRCRAFT_MODELS[type];
  const clampedAltM = Math.max(0, Math.min(ISA_CONSTANTS.MAX_ALTITUDE_M, altitudeM));
  const safeAirspeedMs = Math.max(0.1, airspeedMs);

  const wingArea_m2 = config.wingArea_m2;
  const meanChord_m = wingArea_m2 / config.wingspan;
  const aspectRatio = (config.wingspan * config.wingspan) / Math.max(1e-4, wingArea_m2);

  const isa = computeISA(clampedAltM);
  const dim = computeDimensionlessAndGuardrails({
    density_kg_m3: isa.density_kg_m3,
    dynamicViscosity_Pa_s: isa.dynamicViscosity_Pa_s,
    speedOfSound_ms: isa.speedOfSound_ms,
    velocity_ms: safeAirspeedMs,
    chord_m: meanChord_m,
  });

  const mach = dim.mach;
  const rho = isa.density_kg_m3;
  const dynP = dim.dynamicPressure_Pa;
  const reynolds = dim.reynolds;

  const customCal = type === 'custom_glb' ? activeCustomGlbCalibration : null;
  const oswaldEfficiency = Math.max(
    0.1,
    Math.min(1.0, customCal ? customCal.oswaldEfficiency : config.oswaldEfficiency)
  );

  // Flap lift & profile drag increments
  const effectiveFlap = config.flapCapable ? Math.max(0, flapDeg) : 0;
  const flapLiftBonus = config.flapCapable ? (effectiveFlap / 40) * 0.45 : 0;
  const flapDragBonus = config.flapCapable ? Math.pow(effectiveFlap / 40, 2) * 0.08 : 0;

  const { posStallAngle, negStallAngle } = getEffectiveStallAngles(type, effectiveFlap);
  const isStalled =
    config.stallAngle > 0 &&
    (aoaDeg >= posStallAngle || aoaDeg <= -negStallAngle);
  const degPastStall = isStalled
    ? Math.max(0, aoaDeg >= 0 ? aoaDeg - posStallAngle : -aoaDeg - negStallAngle)
    : 0;
  const stallMargin =
    config.stallAngle > 0
      ? Math.min(posStallAngle - aoaDeg, aoaDeg - -negStallAngle)
      : 90;

  // Empirical/heuristic separation onset & Kirchhoff stall factor
  const sep = computeSeparationOnset({
    aoaDeg,
    posStallAngle,
    negStallAngle,
    reynolds,
    isBluffCylinder: type === 'cylinder',
  });

  let cl = 0;
  let clAlphaPerRad = 0;
  // Strictly use the exact preset cd0 defined in AIRCRAFT_MODELS (+ flap drag increment when flaps deflected)
  const cd0 = config.cd0 + flapDragBonus;
  let cdSep = 0;
  let cdWave = 0;

  if (type === 'cylinder') {
    cl = 0.05 * Math.sin((aoaDeg * Math.PI) / 180);
    cdSep = 0.1 * Math.sin(Math.abs(aoaDeg * 0.1));
  } else {
    clAlphaPerRad = customCal
      ? customCal.liftSlope
      : computeHelmboldLiftCurveSlopeRad(aspectRatio, config.sweepDeg, mach, 0.95);
    const liftSlopePerDeg = clAlphaPerRad * (Math.PI / 180);

    // 2D thin-airfoil incompressible slope ~ 2*pi rad^-1 = 0.10966 / deg
    const thinAirfoilSlopePerDeg = (2 * Math.PI * Math.PI) / 180;
    const alphaZeroLift =
      config.alphaZeroLift ?? -(config.cl0 / thinAirfoilSlopePerDeg);

    const linearCl = (aoa: number) =>
      liftSlopePerDeg * (aoa - alphaZeroLift) + flapLiftBonus;

    const clMaxEff = config.clMax + flapLiftBonus;
    const isSymmetric = config.cl0 === 0 && (config.alphaZeroLift ?? 0) === 0 && effectiveFlap === 0;
    const clMinEff = isSymmetric ? -config.clMax : -config.clMax * 0.85 + flapLiftBonus * 0.5;

    if (sep.xSeparationUpper >= 0.999) {
      cl = Math.max(clMinEff, Math.min(clMaxEff, linearCl(aoaDeg)));
    } else {
      const attachedCl = linearCl(aoaDeg);
      const kirchhoffCl = attachedCl * sep.kirchhoffLiftFactor;
      const aoaRad = (aoaDeg * Math.PI) / 180;
      const postStallPlateCl = 1.05 * Math.sin(2 * aoaRad);
      const plateBlend =
        sep.xSeparationUpper < 0.55
          ? Math.min(1, (0.55 - sep.xSeparationUpper) / 0.41)
          : 0;
      const blendedCl =
        kirchhoffCl * (1 - 0.55 * plateBlend) + postStallPlateCl * (0.55 * plateBlend);
      cl = Math.max(clMinEff, Math.min(clMaxEff, blendedCl));
    }

    const wakeGain = customCal ? 0.6 + customCal.wakeTurbulenceOnset * 0.8 : 1.0;
    cdSep =
      sep.separationIntensity > 0
        ? Math.min(0.98, Math.pow(sep.separationIntensity, 1.65) * 0.72 * wakeGain)
        : 0;

    // Empirical transonic / Ackeret supersonic wave drag (0 below M = 0.7)
    const mCrit = config.supersonicCapable ? 0.92 : 0.78;
    if (mach > 0.7 && mach > mCrit) {
      if (mach <= 1.05) {
        cdWave = 0.04 * Math.pow((mach - mCrit) / (1.05 - mCrit), 2);
      } else {
        cdWave = 0.035 / Math.sqrt(Math.max(0.01, Math.pow(mach, 2) - 1));
      }
    }
  }

  // Pure SI finite-wing lifting-line metrics (alpha_i, downwash epsilon = 2*alpha_i, CDi, Gamma_eq, Gamma_0, Lift)
  const finiteWing = computeFiniteWingAerodynamics({
    wingspan_m: config.wingspan,
    wingArea_m2,
    oswaldEfficiency,
    cl,
    velocity_ms: safeAirspeedMs,
    density_kg_m3: rho,
  });

  const cdTotalRaw = computeTotalDrag({
    cd0,
    cdi: finiteWing.cdi,
    cdSep,
    cdWave,
  });

  // Surrogate surface Cp & empirical boundary-layer reference estimates
  const cpResult = computeChordwiseCpAndLift({
    targetCl: cl,
    aoaDeg,
    mach,
    reynolds,
    thicknessRatio: config.thicknessRatio,
    camberRatio: config.camberRatio ?? 0.015,
    flapsDeg: effectiveFlap,
    xSeparationUpper: sep.xSeparationUpper,
    isStalled,
    degPastStall,
    isBluffCylinder: type === 'cylinder',
  });

  const flatPlateRef = computeFlatPlateSkinFriction(Math.max(1e3, reynolds));

  // Consistency check values (full float64 precision)
  const kuttaLift_N = rho * safeAirspeedMs * finiteWing.equivalentCirculation_m2_s * config.wingspan;
  const pressureLiftCheckRaw_N = dynP * wingArea_m2 * cpResult.clIntegratedRaw;

  const lift_N = finiteWing.lift_N;
  const drag_N = cdTotalRaw * dynP * wingArea_m2;
  const ldRatioRaw = cdTotalRaw > 1e-8 ? cl / cdTotalRaw : 0;

  const isPureAirfoil =
    type === 'naca0012' ||
    type === 'naca2412' ||
    type === 'validation_wing' ||
    type === 'custom_airfoil';

  const loadFactor_nz = config.referenceWeight_N
    ? Number((lift_N / config.referenceWeight_N).toFixed(2))
    : undefined;

  const outOfRangeMetrics: string[] = [];
  if (mach > 0.7) outOfRangeMetrics.push(`M = ${mach.toFixed(2)} > 0.70`);
  if (reynolds < 100_000) outOfRangeMetrics.push(`Re = ${Math.round(reynolds).toLocaleString()} < 1e5`);
  if (isStalled) outOfRangeMetrics.push('Post-Stall Separated AoA');
  if (type === 'cylinder') outOfRangeMetrics.push('Bluff-Body Vortex Street');
  const isModelValid = outOfRangeMetrics.length === 0;
  const modelValidity = {
    isValid: isModelValid,
    reason: isModelValid
      ? 'Within Subsonic Attached VLM Envelope (M ≤ 0.70, Re ≥ 1×10⁵)'
      : `Out of Subsonic Attached VLM Envelope (${outOfRangeMetrics.join(' · ')})`,
    outOfRangeMetrics,
  };

  let flowState: AeroTelemetry['flowState'] = 'Laminar';
  if (mach >= 1.2) {
    flowState = 'Supersonic Wave';
  } else if (mach >= 0.85) {
    flowState = 'Transonic Shock';
  } else if (isStalled && (degPastStall > 4 || sep.xSeparationUpper < 0.45)) {
    flowState = 'Deep Stall';
  } else if (isStalled || sep.xSeparationUpper < 0.92) {
    flowState = 'Incipient Stall';
  } else if (cpResult.boundaryLayerRegime !== 'Fully Laminar') {
    flowState = 'Attached Turbulent';
  } else {
    flowState = 'Laminar';
  }

  return {
    telemetry: {
      cl: Number(cl.toFixed(3)),
      cd: Number(cdTotalRaw.toFixed(4)),
      ldRatio: Number(ldRatioRaw.toFixed(2)),
      lift_N: Math.round(lift_N),
      drag_N: Math.round(drag_N),
      reynolds: Math.round(reynolds),
      reynoldsRegime: dim.reynoldsRegime,
      reynoldsRegimeLabel: dim.reynoldsRegimeLabel,
      mach: Number(mach.toFixed(3)),
      knudsen: dim.knudsen,
      dynamic_pressure_pa: Math.round(dynP),
      air_density_kg_m3: Number(rho.toFixed(4)),

      altitude_m: Number(isa.altitude_m.toFixed(1)),
      airspeed_ms: Number(safeAirspeedMs.toFixed(2)),
      temperature_K: Number(isa.temperature_K.toFixed(2)),
      pressure_Pa: Math.round(isa.pressure_Pa),
      dynamic_viscosity_Pa_s: isa.dynamicViscosity_Pa_s,
      speed_of_sound_ms: Number(isa.speedOfSound_ms.toFixed(2)),
      prandtlGlauertFactor: Number(dim.prandtlGlauertFactor.toFixed(3)),
      compressibilityRegime: dim.compressibilityRegime,
      continuumValid: dim.continuumValid,
      regimeWarnings: dim.regimeWarnings,

      clUpper: cpResult.clUpper,
      clLower: cpResult.clLower,
      suctionPercentage: cpResult.suctionPercentage,
      compressionPercentage: cpResult.compressionPercentage,
      surfacePressureSplitMode: isPureAirfoil ? 'integrated-surrogate-cp' : 'illustrative-split',
      kuttaTeDeltaCp: cpResult.kuttaTeDeltaCp,
      equivalentCirculation_m2_s: Number(finiteWing.equivalentCirculation_m2_s.toFixed(2)),
      ellipticRootCirculation_m2_s: Number(finiteWing.ellipticRootCirculation_m2_s.toFixed(2)),
      boundCirculation_m2_s: Number(finiteWing.equivalentCirculation_m2_s.toFixed(2)),
      kuttaLift_N: Math.round(kuttaLift_N),
      pressureLiftCheck_N: Math.round(pressureLiftCheckRaw_N),

      wingArea_m2,
      meanChord_m: Number(meanChord_m.toFixed(4)),
      sweepDeg: config.sweepDeg,
      liftCurveSlope_per_rad: Number(clAlphaPerRad.toFixed(4)),
      aspectRatio: Number(finiteWing.aspectRatio.toFixed(2)),
      oswaldEfficiency: Number(oswaldEfficiency.toFixed(3)),
      inducedAlpha_deg: Number(finiteWing.inducedAlpha_deg.toFixed(2)),
      downwashAngle_deg: Number(finiteWing.downwashAngle_deg.toFixed(2)),

      cd0: Number(cd0.toFixed(4)),
      cdi: Number(finiteWing.cdi.toFixed(4)),
      cdSep: Number(cdSep.toFixed(4)),
      cdWave: Number(cdWave.toFixed(4)),

      xTransitionUpper: cpResult.xTransitionUpper,
      xTransitionLower: cpResult.xTransitionLower,
      xSeparationUpper: cpResult.separationXc,
      stagnationXc: cpResult.stagnationXc,
      skinFrictionDrag_cdf: Number(flatPlateRef.turbulentWingCdf.toFixed(5)),
      laminarFlatPlateCfMean: Number(flatPlateRef.laminarMeanCf.toFixed(5)),
      turbulentFlatPlateCfMean: Number(flatPlateRef.turbulentMeanCf.toFixed(5)),
      maxAdversePressureGrad: cpResult.maxAdversePressureGrad,
      boundaryLayerRegime: cpResult.boundaryLayerRegime,

      isStalled,
      stallMargin: Number(stallMargin.toFixed(1)),
      flowState,
      solverModel: SOLVER_LABEL_3D,
      loadFactor_nz,
      modelValidity,
      rawSI: {
        temperature_K: isa.temperature_K,
        pressure_Pa: isa.pressure_Pa,
        density_kg_m3: rho,
        dynamicViscosity_Pa_s: isa.dynamicViscosity_Pa_s,
        speedOfSound_ms: isa.speedOfSound_ms,
        velocity_ms: safeAirspeedMs,
        dynamicPressure_Pa: dynP,
        reynolds,
        mach,
        knudsen: dim.knudsen,
        prandtlGlauertFactor: dim.prandtlGlauertFactor,
        wingArea_m2,
        meanChord_m,
        aspectRatio: finiteWing.aspectRatio,
        clAlpha_per_rad: clAlphaPerRad,
        cl,
        cd0,
        cdi: finiteWing.cdi,
        cdSep,
        cdWave,
        cdTotal: cdTotalRaw,
        inducedAlpha_rad: finiteWing.inducedAlpha_rad,
        downwashAngle_rad: finiteWing.downwashAngle_rad,
        lift_N,
        drag_N,
        ldRatio: ldRatioRaw,
        pressureLiftCheck_N: pressureLiftCheckRaw_N,
        cpIntegratedCl: cpResult.clIntegratedRaw,
      },
    },
    cpStations: cpResult.stations,
  };
}

/**
 * Calculate Aerodynamic Lift, Drag, ISA Atmosphere, Dimensionless Parameters & Kutta/Cp Telemetry
 */
export function calculateAeroTelemetry(
  type: AircraftModelType,
  aoaDeg: number,
  airspeedKts: number,
  altitudeFt: number,
  flapDeg: number
): AeroTelemetry {
  return solveAeroStateSI(
    type,
    aoaDeg,
    airspeedKts * ISA_CONSTANTS.KTS_TO_MS,
    altitudeFt * ISA_CONSTANTS.FT_TO_M,
    flapDeg
  ).telemetry;
}

/**
 * Returns first-principles chordwise Cp distribution along x/c in [0, 1]
 * with Prandtl-Glauert compressibility correction and trailing-edge Kutta closure.
 */
export function computeSectionCpProfile(
  type: AircraftModelType,
  aoaDeg: number,
  airspeedKts: number,
  altitudeFt: number,
  flapDeg: number
): ChordwiseCpStation[] {
  return solveAeroStateSI(
    type,
    aoaDeg,
    airspeedKts * ISA_CONSTANTS.KTS_TO_MS,
    altitudeFt * ISA_CONSTANTS.FT_TO_M,
    flapDeg
  ).cpStations;
}

/**
 * Evaluates a 0..15 deg alpha sweep (0.2 deg step) using the active preset or custom model planform.
 */
export function computeModelAlphaSweep(
  type: AircraftModelType,
  airspeedMs: number,
  altitudeM: number,
  flapDeg = 0
): AlphaSweepResult {
  const cfg = AIRCRAFT_MODELS[type];
  const customCal = type === 'custom_glb' ? activeCustomGlbCalibration : null;
  return alphaSweep({
    modelType: type,
    planform: {
      wingspan_m: cfg.wingspan,
      wingArea_m2: cfg.wingArea_m2,
      sweepDeg: cfg.sweepDeg,
      oswaldEfficiency: customCal ? customCal.oswaldEfficiency : cfg.oswaldEfficiency,
      cd0: cfg.cd0,
      thicknessRatio: cfg.thicknessRatio,
      camberRatio: cfg.camberRatio ?? 0.015,
      stallAngleDeg: cfg.stallAngle,
      cl0: cfg.cl0,
      alphaZeroLiftDeg: cfg.alphaZeroLift ?? 0,
      clMax: cfg.clMax,
      flapCapable: cfg.flapCapable,
      supersonicCapable: cfg.supersonicCapable,
    },
    velocity_ms: airspeedMs,
    altitude_m: altitudeM,
    flapsDeg: flapDeg,
    alphaMinDeg: 0,
    alphaMaxDeg: 15,
    stepDeg: 0.2,
    customLiftSlopeRad: customCal ? customCal.liftSlope : undefined,
  });
}
