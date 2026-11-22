export type ModelClass =
  | 'airliner'
  | 'delta_fighter'
  | 'glider'
  | 'uav'
  | 'car'
  | 'rocket'
  | 'bluff_body'
  | 'other';

export type AxisDir = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface BoundingBoxDims {
  x: number;
  y: number;
  z: number;
}

export interface AeroCalibration {
  modelClass: ModelClass;
  noseAxis: AxisDir;
  upAxis: AxisDir;
  scaleHint: number;
  cl0: number;
  cd0: number;
  liftSlope: number; // rad^-1
  oswaldEfficiency: number;
  stallAngleDeg: number;
  wingtipVortexStrength: number; // 0-1
  viscosity: number; // 0-1
  wakeTurbulenceOnset: number; // 0-1
  cruiseSpeedMs: number;
  aoaMinDeg: number;
  aoaMaxDeg: number;
  confidence: number; // 0-1
}

export const MODEL_CLASSES: readonly ModelClass[] = [
  'airliner',
  'delta_fighter',
  'glider',
  'uav',
  'car',
  'rocket',
  'bluff_body',
  'other',
];

export const AXIS_DIRS: readonly AxisDir[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

export const DEFAULT_CALIBRATION: AeroCalibration = {
  modelClass: 'other',
  noseAxis: '-X',
  upAxis: '+Y',
  scaleHint: 1.0,
  cl0: 0.15,
  cd0: 0.028,
  liftSlope: 4.8,
  oswaldEfficiency: 0.82,
  stallAngleDeg: 16,
  wingtipVortexStrength: 0.65,
  viscosity: 0.25,
  wakeTurbulenceOnset: 0.5,
  cruiseSpeedMs: 180,
  aoaMinDeg: -10,
  aoaMaxDeg: 24,
  confidence: 0,
};

function clamp(val: unknown, min: number, max: number, fallback: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeModelClass(val: unknown): ModelClass {
  if (typeof val === 'string') {
    const trimmed = val.trim().toLowerCase() as ModelClass;
    if ((MODEL_CLASSES as readonly string[]).includes(trimmed)) {
      return trimmed;
    }
  }
  return DEFAULT_CALIBRATION.modelClass;
}

function normalizeAxisDir(val: unknown, fallback: AxisDir): AxisDir {
  if (typeof val === 'string') {
    const upper = val.trim().toUpperCase() as AxisDir;
    if ((AXIS_DIRS as readonly string[]).includes(upper)) {
      return upper;
    }
  }
  return fallback;
}

export function axisToTuple(axis: AxisDir): [number, number, number] {
  switch (axis) {
    case '+X':
      return [1, 0, 0];
    case '-X':
      return [-1, 0, 0];
    case '+Y':
      return [0, 1, 0];
    case '-Y':
      return [0, -1, 0];
    case '+Z':
      return [0, 0, 1];
    case '-Z':
      return [0, 0, -1];
  }
}

export function flipAxisDir(axis: AxisDir): AxisDir {
  switch (axis) {
    case '+X':
      return '-X';
    case '-X':
      return '+X';
    case '+Y':
      return '-Y';
    case '-Y':
      return '+Y';
    case '+Z':
      return '-Z';
    case '-Z':
      return '+Z';
  }
}

function ensureOrthogonalAxes(noseAxis: AxisDir, upAxis: AxisDir): { noseAxis: AxisDir; upAxis: AxisDir } {
  const n = axisToTuple(noseAxis);
  const u = axisToTuple(upAxis);
  const dot = n[0] * u[0] + n[1] * u[1] + n[2] * u[2];
  if (Math.abs(dot) < 0.5) {
    return { noseAxis, upAxis };
  }
  // Pick a guaranteed orthogonal upAxis if AI returned parallel/anti-parallel axes
  const fallbackUp: AxisDir = Math.abs(n[1]) < 0.5 ? '+Y' : '+Z';
  return { noseAxis, upAxis: fallbackUp };
}

/**
 * Validates and clamps every AI calibration field into safe solver ranges.
 */
export function sanitizeCalibration(raw: unknown): AeroCalibration {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const modelClass = normalizeModelClass(obj.modelClass);
  const rawNose = normalizeAxisDir(obj.noseAxis, DEFAULT_CALIBRATION.noseAxis);
  const rawUp = normalizeAxisDir(obj.upAxis, DEFAULT_CALIBRATION.upAxis);
  const { noseAxis, upAxis } = ensureOrthogonalAxes(rawNose, rawUp);

  let aoaMinDeg = Math.round(clamp(obj.aoaMinDeg, -25, 0, DEFAULT_CALIBRATION.aoaMinDeg));
  let aoaMaxDeg = Math.round(clamp(obj.aoaMaxDeg, 5, 40, DEFAULT_CALIBRATION.aoaMaxDeg));
  if (aoaMaxDeg < aoaMinDeg + 6) {
    aoaMaxDeg = Math.min(40, aoaMinDeg + 12);
    if (aoaMaxDeg < aoaMinDeg + 6) {
      aoaMinDeg = Math.max(-25, aoaMaxDeg - 12);
    }
  }

  // Some models may occasionally output liftSlope in deg^-1 (~0.08) instead of rad^-1 (~4.8)
  let liftSlope = clamp(obj.liftSlope, 0.02, 7.2, DEFAULT_CALIBRATION.liftSlope);
  if (liftSlope > 0 && liftSlope < 0.35) {
    liftSlope = Math.min(7.2, liftSlope * (180 / Math.PI));
  }
  liftSlope = clamp(liftSlope, 0.5, 7.2, DEFAULT_CALIBRATION.liftSlope);

  return {
    modelClass,
    noseAxis,
    upAxis,
    scaleHint: Number(clamp(obj.scaleHint, 0.7, 1.35, DEFAULT_CALIBRATION.scaleHint).toFixed(3)),
    cl0: Number(clamp(obj.cl0, -0.5, 1.2, DEFAULT_CALIBRATION.cl0).toFixed(3)),
    cd0: Number(clamp(obj.cd0, 0.004, 1.5, DEFAULT_CALIBRATION.cd0).toFixed(4)),
    liftSlope: Number(liftSlope.toFixed(3)),
    oswaldEfficiency: Number(
      clamp(obj.oswaldEfficiency, 0.45, 0.98, DEFAULT_CALIBRATION.oswaldEfficiency).toFixed(3)
    ),
    stallAngleDeg: Number(
      clamp(obj.stallAngleDeg, 0, 42, DEFAULT_CALIBRATION.stallAngleDeg).toFixed(1)
    ),
    wingtipVortexStrength: Number(
      clamp(obj.wingtipVortexStrength, 0, 1, DEFAULT_CALIBRATION.wingtipVortexStrength).toFixed(3)
    ),
    viscosity: Number(clamp(obj.viscosity, 0, 1, DEFAULT_CALIBRATION.viscosity).toFixed(3)),
    wakeTurbulenceOnset: Number(
      clamp(obj.wakeTurbulenceOnset, 0, 1, DEFAULT_CALIBRATION.wakeTurbulenceOnset).toFixed(3)
    ),
    cruiseSpeedMs: Math.round(
      clamp(obj.cruiseSpeedMs, 15, 650, DEFAULT_CALIBRATION.cruiseSpeedMs)
    ),
    aoaMinDeg,
    aoaMaxDeg,
    confidence: Number(clamp(obj.confidence, 0, 1, DEFAULT_CALIBRATION.confidence).toFixed(3)),
  };
}

/**
 * Computes a column-major 4x4 rotation matrix array (compatible with THREE.Matrix4.fromArray)
 * that rotates model axes so `noseAxis -> -X` (facing oncoming airflow) and `upAxis -> +Y`.
 * When `flipNose` is true, applies an additional 180 deg yaw about +Y so `noseAxis -> +X`.
 */
export function computeOrientationMatrixArray(
  noseAxis: AxisDir,
  upAxis: AxisDir,
  flipNose = false
): number[] {
  const { noseAxis: nDir, upAxis: uDir } = ensureOrthogonalAxes(noseAxis, upAxis);
  const n = axisToTuple(nDir);
  const u = axisToTuple(uDir);
  // Right-handed third axis in source frame: s = n x u
  const s: [number, number, number] = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];

  // Target frame in Wind Tunnel coordinates:
  // If flipNose=false: targetNose = (-1, 0, 0), targetUp = (0, 1, 0), targetSide = targetNose x targetUp = (0, 0, -1)
  // If flipNose=true:  targetNose = (+1, 0, 0), targetUp = (0, 1, 0), targetSide = targetNose x targetUp = (0, 0, +1)
  const sign = flipNose ? 1 : -1;
  const tN: [number, number, number] = [sign, 0, 0];
  const tU: [number, number, number] = [0, 1, 0];
  const tS: [number, number, number] = [0, 0, sign];

  // Since R = T * S^T, row r col c of R is T[r][0]*n[c] + T[r][1]*u[c] + T[r][2]*s[c]
  const r00 = tN[0] * n[0] + tU[0] * u[0] + tS[0] * s[0];
  const r01 = tN[0] * n[1] + tU[0] * u[1] + tS[0] * s[1];
  const r02 = tN[0] * n[2] + tU[0] * u[2] + tS[0] * s[2];

  const r10 = tN[1] * n[0] + tU[1] * u[0] + tS[1] * s[0];
  const r11 = tN[1] * n[1] + tU[1] * u[1] + tS[1] * s[1];
  const r12 = tN[1] * n[2] + tU[1] * u[2] + tS[1] * s[2];

  const r20 = tN[2] * n[0] + tU[2] * u[0] + tS[2] * s[0];
  const r21 = tN[2] * n[1] + tU[2] * u[1] + tS[2] * s[1];
  const r22 = tN[2] * n[2] + tU[2] * u[2] + tS[2] * s[2];

  // Column-major 4x4 layout for Three.js Matrix4.fromArray
  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    0, 0, 0, 1,
  ];
}

export function formatModelClassLabel(modelClass: ModelClass): string {
  switch (modelClass) {
    case 'airliner':
      return 'Airliner';
    case 'delta_fighter':
      return 'Delta Fighter';
    case 'glider':
      return 'Glider';
    case 'uav':
      return 'UAV';
    case 'car':
      return 'Car';
    case 'rocket':
      return 'Rocket';
    case 'bluff_body':
      return 'Bluff Body';
    default:
      return 'Custom Body';
  }
}
