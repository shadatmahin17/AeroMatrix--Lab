import { AircraftModelType } from '../types/aerodynamics';
import { AeroCalibration } from '../lib/calibration';
import { Vertex3D } from '../utils/aircraft3DGeometry';
import { AircraftSurfaceField, SpanSectionInfo, SurfaceSample } from './AircraftSurfaceField';
import {
  applyPrandtlGlauertCp,
  clampCpForColorMap,
  computeRawCp,
  ISA_CONSTANTS,
  SOLVER_LABEL_3D,
} from '../lib/aeroPhysics';

export interface Fluid3DParams {
  modelType: AircraftModelType;
  aoaDeg: number;
  airspeed_kts: number;
  mach: number;
  altitude_ft: number;
  flapsDeg: number;
  /** Visual-only tuning parameter controlling Lamb-Oseen core diffusion & SDF boundary halo (NOT SI kinematic viscosity). */
  viscosity?: number;
  isStalled: boolean;
  cl: number;
  cd: number;
  timeSec?: number;
  streamlineResolution?: number;
  surfaceField?: AircraftSurfaceField | null;
  calibration?: AeroCalibration | null;
}

export interface DynamicEmitterFrame {
  xSpawn: number;
  xRecycle: number;
  yMid: number;
  yHalf: number;
  zHalf: number;
  halfLength: number;
  modelHeight: number;
  modelSpan: number;
  chordRef: number;
  dsMax: number;
}

export interface Velocity3DResult {
  u: number; // downstream (+X) in normalized tunnel coordinates
  v: number; // vertical (+Y) in normalized tunnel coordinates
  w: number; // spanwise (+Z) in normalized tunnel coordinates
  speed: number; // normalized tunnel flow speed
  cpIncompressible: number; // raw incompressible Cp,0 = 1 - (V / V_inf)^2 (unclamped)
  pressureCoeff: number; // raw physical Cp with optional Prandtl-Glauert scaling (unclamped)
  pressureCoeffClamped: number; // color-map clamped Cp in [-3.5, 1.0] for shaders/particles
  vorticity: number; // induced vortex magnitude
  isSeparated: boolean;
}

export const SOLVER_METADATA_3D = {
  label: SOLVER_LABEL_3D,
  isNavierStokes: false,
  vortexPanelCount: 6,
  spanwiseLoading: 'elliptic',
  sdfGridResolution: '84x48x84',
  velocityScaleNote:
    'Normalized visual tunnel scale (350 kts / 180.0554 m/s mapped to V_inf = 1.2 tunnel units/s).',
  viscosityNote:
    'Visual viscosity parameter controls Lamb-Oseen core radius and SDF cushion halo; SI Reynolds number is computed separately in src/lib/aeroPhysics.ts.',
} as const;

// Reusable scratch objects to prevent per-frame GC allocations in 60fps particle loops
const _surfSample: SurfaceSample = { dist: 0, nx: 0, ny: 1, nz: 0, inside: false };
const _spanInfo: SpanSectionInfo = { leX: 0, teX: 0, quarterChordX: 0, chord: 1, yMid: 0, thickness: 0.3 };
const _bsOut = { u: 0, v: 0, w: 0 };

const CYLINDER_RADIUS = 1.4;
const CYLINDER_HALF_HEIGHT = 3.8;

/**
 * Evaluates the analytical Biot-Savart induced velocity of a finite straight vortex filament A -> B
 * with Vatistas/Lamb-Oseen viscous core regularization (`coreRadius` prevents 1/r singularity at r = 0).
 *
 * Right-hand rule convention: for positive `gamma` and filament vector dl = B - A,
 * induced velocity follows dl x r1 / (|r1 x r2|^2 + coreRadius^2 |dl|^2) * (dot1 - dot2).
 */
export function addBiotSavartSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  gamma: number,
  coreRadius: number,
  out: { u: number; v: number; w: number }
): number {
  const r1x = px - ax;
  const r1y = py - ay;
  const r1z = pz - az;

  const r2x = px - bx;
  const r2y = py - by;
  const r2z = pz - bz;

  const r1 = Math.hypot(r1x, r1y, r1z);
  const r2 = Math.hypot(r2x, r2y, r2z);
  if (r1 < 1e-4 || r2 < 1e-4) return 0;

  const dlx = bx - ax;
  const dly = by - ay;
  const dlz = bz - az;
  const dlSq = dlx * dlx + dly * dly + dlz * dlz;
  if (dlSq < 1e-6) return 0;

  const cx = r1y * r2z - r1z * r2y;
  const cy = r1z * r2x - r1x * r2z;
  const cz = r1x * r2y - r1y * r2x;
  const crossSq = cx * cx + cy * cy + cz * cz;

  const safeCore = Math.max(0, coreRadius);
  const denom = crossSq + safeCore * safeCore * dlSq;
  if (denom < 1e-9) return 0;

  const dot1 = (dlx * r1x + dly * r1y + dlz * r1z) / r1;
  const dot2 = (dlx * r2x + dly * r2y + dlz * r2z) / r2;
  const factor = (gamma / (4 * Math.PI)) * ((dot1 - dot2) / denom);

  const du = cx * factor;
  const dv = cy * factor;
  const dw = cz * factor;

  out.u += du;
  out.v += dv;
  out.w += dw;

  return Math.hypot(du, dv, dw);
}

/**
 * Pure allocation-returning wrapper around `addBiotSavartSegment` for diagnostics & unit testing.
 */
export function evaluateBiotSavartSegment(params: {
  point: Vertex3D;
  start: Vertex3D;
  end: Vertex3D;
  gamma: number;
  coreRadius: number;
}): { u: number; v: number; w: number; speed: number } {
  const out = { u: 0, v: 0, w: 0 };
  const speed = addBiotSavartSegment(
    params.point.x,
    params.point.y,
    params.point.z,
    params.start.x,
    params.start.y,
    params.start.z,
    params.end.x,
    params.end.y,
    params.end.z,
    params.gamma,
    params.coreRadius,
    out
  );
  return { ...out, speed };
}

/**
 * 3D Reduced-Order Visual Flow Engine
 * Solver Classification: Reduced-Order Biot–Savart Vortex-Lattice & Approximate SDF Surface-Constraint Model
 * (Explicitly NOT a 3D Navier–Stokes RANS/LES solver.)
 *
 * Combines:
 *  1. 6-panel elliptical Biot–Savart 3D Horseshoe Vortex Filaments (normalized tunnel scale,
 *     elliptic peak circulation Gamma_0 = (2/pi) * V_inf * c * C_L), trailing vortex sheet,
 *     Lamb–Oseen diffused wingtip vortices, and delta leading-edge vortices.
 *  2. Approximate 84×48×84 Signed Distance Field (SDF) surface constraint (no-penetration tangential
 *     slip along grad(sdf) with exterior constraint projection).
 *  3. Visual wake shedding, Prandtl–Glauert Cp scaling (raw physical Cp separated from color-map
 *     clamping), and Mach cone deflection heuristics.
 */
export class FluidDynamics3D {
  public static readonly SOLVER_MODEL = SOLVER_LABEL_3D;
  public static readonly METADATA = SOLVER_METADATA_3D;

  /**
   * Computes dynamic smoke & streamline emitter bounds and adaptive sub-step limit
   * directly from the active normalized AircraftSurfaceField bounding box.
   */
  public static getDynamicEmitterFrame(
    sf?: AircraftSurfaceField | null,
    rakeSpread = 1.0,
    streamlineResolution = 1.0
  ): DynamicEmitterFrame {
    const spread = Math.max(0.4, Math.min(2.5, rakeSpread));
    const res = Math.max(0.5, Math.min(3.0, streamlineResolution));
    const halfLength = sf ? sf.halfLength : 5.0;
    const modelHeight = sf ? sf.height : 1.8;
    const modelSpan = sf ? 2 * sf.halfSpan : 10.0;
    const minX = sf ? sf.minX : -3.5;
    const maxX = sf ? sf.maxX : 6.5;
    const yMid = sf ? 0.5 * (sf.minY + sf.maxY) : 0;
    const chordRef = sf ? sf.meanChord : 2.5;

    return {
      xSpawn: Math.min(minX - 0.8, -1.4 * halfLength),
      xRecycle: maxX + 1.8 * halfLength,
      yMid,
      yHalf: Math.max(0.75, 0.5 * 1.25 * modelHeight * spread),
      zHalf: Math.max(1.25, 0.5 * 1.20 * modelSpan * spread),
      halfLength,
      modelHeight,
      modelSpan,
      chordRef,
      dsMax: Math.max(0.018, (0.03 * chordRef) / res),
    };
  }

  /**
   * Rejects or validates upstream emitter seeds against `dMin` surface clearance.
   */
  public static isValidEmitterSeed(
    x: number,
    y: number,
    z: number,
    params: Fluid3DParams
  ): boolean {
    const clearance = params.surfaceField ? params.surfaceField.dMin : 0.16;
    return !FluidDynamics3D.isInsideSolid({ x, y, z }, params, clearance);
  }

  /**
   * Returns true if world-space point `p` lies inside or closer than `clearance`
   * to the solid model geometry.
   */
  public static isInsideSolid(
    p: Vertex3D,
    params: Fluid3DParams,
    clearance = 0.04
  ): boolean {
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);
    const bx = p.x * cosA - p.y * sinA;
    const by = p.x * sinA + p.y * cosA;
    const bz = p.z;

    if (params.modelType === 'cylinder') {
      if (Math.abs(by) <= CYLINDER_HALF_HEIGHT + clearance) {
        return Math.hypot(bx, bz) < CYLINDER_RADIUS + clearance;
      }
      return false;
    }

    if (params.surfaceField && params.surfaceField.sample(bx, by, bz, _surfSample)) {
      return _surfSample.dist < clearance;
    }
    return false;
  }

  /**
   * Projects world-space point `p` strictly outside the approximate solid model surface
   * by at least `minClearance`, preventing discrete RK2 steps from entering the geometry.
   */
  public static constrainToExterior(
    p: Vertex3D,
    params: Fluid3DParams,
    minClearance = 0.08
  ): Vertex3D {
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    let bx = p.x * cosA - p.y * sinA;
    let by = p.x * sinA + p.y * cosA;
    let bz = p.z;

    if (params.modelType === 'cylinder') {
      const targetR = CYLINDER_RADIUS + minClearance;
      const capY = CYLINDER_HALF_HEIGHT + minClearance;
      if (Math.abs(by) < capY) {
        const rXZ = Math.hypot(bx, bz);
        if (rXZ < targetR) {
          const distToSide = targetR - rXZ;
          const distToCap = capY - Math.abs(by);
          if (distToCap < distToSide && distToCap < 0.25) {
            by = by >= 0 ? capY : -capY;
          } else if (rXZ > 1e-4) {
            const scale = targetR / rXZ;
            bx *= scale;
            bz *= scale;
          } else {
            bz = targetR;
          }
          return {
            x: bx * cosA + by * sinA,
            y: -bx * sinA + by * cosA,
            z: bz,
          };
        }
      }
      return p;
    }

    const sf = params.surfaceField;
    if (!sf) return p;

    let modified = false;
    for (let iter = 0; iter < 6; iter++) {
      if (!sf.sample(bx, by, bz, _surfSample)) break;
      if (_surfSample.dist >= minClearance) break;

      const push = Math.max(0.03, minClearance - _surfSample.dist + 0.02);
      bx += _surfSample.nx * push;
      by += _surfSample.ny * push;
      bz += _surfSample.nz * push;
      modified = true;
    }

    if (!modified) return p;

    return {
      x: bx * cosA + by * sinA,
      y: -bx * sinA + by * cosA,
      z: bz,
    };
  }

  public static getVelocity(
    p: Vertex3D,
    params: Fluid3DParams
  ): Velocity3DResult {
    const {
      modelType,
      aoaDeg,
      airspeed_kts,
      mach,
      viscosity = 0.1,
      isStalled,
      cl,
      timeSec = 0,
      surfaceField = null,
      calibration = null,
    } = params;

    // Visual viscosity controls Lamb-Oseen core radius & boundary halo (not SI mu/rho)
    const visualViscosity = calibration
      ? Math.max(0.01, Math.min(0.8, 0.55 * viscosity + 0.45 * calibration.viscosity))
      : viscosity;

    // Convert airspeed to SI (m/s), then scale to normalized 3D visual tunnel coordinates (180.0554 m/s = 350 kts -> 1.2)
    const airspeedMs = Math.max(0.5, airspeed_kts * ISA_CONSTANTS.KTS_TO_MS);
    const vInf = Math.max(0.4, (airspeedMs / 180.0554) * 1.2);
    const aoaRad = (aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    const bx = p.x * cosA - p.y * sinA;
    const by = p.x * sinA + p.y * cosA;
    const bz = p.z;

    let u = vInf;
    let v = 0;
    let w = 0;
    let vorticity = 0;
    let isSeparated = false;

    // -------------------------------------------------------------------------
    // 1. BLUFF BODY VERTICAL CYLINDER (Doublet in X-Z + von Kármán Vortex Street)
    // -------------------------------------------------------------------------
    if (modelType === 'cylinder') {
      const R = CYLINDER_RADIUS;
      const Reff = R * 1.07;
      const halfH = CYLINDER_HALF_HEIGHT;
      const rXZSq = bx * bx + bz * bz;
      const rXZ = Math.sqrt(rXZSq);

      const endMargin = Math.max(0, Math.abs(by) - halfH);
      const heightBlend = endMargin <= 0 ? 1.0 : Math.max(0, 1.0 - endMargin / 0.85);

      if (heightBlend > 0.001) {
        const freestreamUb = vInf * cosA;
        const freestreamVb = vInf * sinA;

        let ub = freestreamUb;
        let vb = freestreamVb;
        let wb = 0;

        if (rXZ > 0.02) {
          const factor = (Reff * Reff) / Math.max(Reff * Reff * 0.92, rXZSq);
          const cos2th = (bx * bx - bz * bz) / rXZSq;
          const sin2th = (2 * bx * bz) / rXZSq;

          ub = freestreamUb * (1 - factor * cos2th);
          wb = -freestreamUb * factor * sin2th;

          if (Math.abs(by) > halfH - 0.65 && rXZ < R * 1.45) {
            const capSign = by >= 0 ? 1 : -1;
            const capFactor = Math.max(0, 1 - Math.abs(Math.abs(by) - halfH) / 0.75);
            vb += capSign * 0.48 * vInf * capFactor * Math.max(0, 1 - rXZ / (R * 1.5));
          }
        }

        if (bx > R * 0.5 && Math.abs(by) <= halfH + 0.55) {
          const strouhal = 0.21 * (vInf / (2 * R));
          const wakeSpeed = vInf * 0.78;
          const spacing = wakeSpeed / Math.max(0.25, strouhal);
          const gammaKarman = vInf * R * (1.65 + viscosity * 1.1);
          const coreR = 0.42 + viscosity * 0.75 + Math.max(0, bx - R) * 0.03;

          _bsOut.u = 0;
          _bsOut.v = 0;
          _bsOut.w = 0;

          const phaseShift = (timeSec * wakeSpeed) % spacing;
          for (let k = 0; k < 5; k++) {
            const sign = k % 2 === 0 ? 1 : -1;
            const vxPos = R * 1.15 + k * (spacing * 0.5) + phaseShift;
            const vzPos = sign * 0.72;
            vorticity += addBiotSavartSegment(
              bx, by, bz,
              vxPos, -halfH, vzPos,
              vxPos, halfH, vzPos,
              sign * gammaKarman * 0.65,
              coreR,
              _bsOut
            );
          }

          ub += _bsOut.u;
          vb += _bsOut.v;
          wb += _bsOut.w;

          if (Math.abs(bz) < R * 1.35) {
            ub -= 0.24 * vInf * Math.exp(-Math.abs(bz) / (R * 0.85));
            isSeparated = true;
          }
        }

        if (Math.abs(by) <= halfH + 0.28 && rXZ < R + 0.45) {
          if (Math.abs(by) > halfH - 0.12 && rXZ < R * 0.92) {
            const capNy = by >= 0 ? 1 : -1;
            const vDotCap = vb * capNy;
            if (vDotCap < 0) vb -= vDotCap * capNy;
            if (Math.abs(by) < halfH + 0.14) {
              vb += capNy * 0.85 * vInf;
            }
          } else {
            const nx = rXZ > 1e-4 ? bx / rXZ : 0;
            const nz = rXZ > 1e-4 ? bz / rXZ : 1;
            const vDotN = ub * nx + wb * nz;
            if (vDotN < 0) {
              ub -= vDotN * nx;
              wb -= vDotN * nz;
            }
            const clearance = R + 0.22 - rXZ;
            if (clearance > 0) {
              const push = Math.min(2.0 * vInf, (clearance / 0.22) * 1.35 * vInf);
              ub += nx * push;
              wb += nz * push;
            }
            if (nx < -0.75 && Math.hypot(ub, wb) < 0.22 * vInf) {
              wb += (bz >= 0 ? 1 : -1) * 0.35 * vInf;
            }
          }
        }

        const wu = ub * cosA + vb * sinA;
        const wv = -ub * sinA + vb * cosA;
        const ww = wb;

        u = vInf * (1 - heightBlend) + wu * heightBlend;
        v = wv * heightBlend;
        w = ww * heightBlend;
      }
    } else {
      // -----------------------------------------------------------------------
      // 2. WINGED AIRCRAFT: 6-PANEL ELLIPTICAL BIOT-SAVART HORSESHOE + SDF
      // -----------------------------------------------------------------------
      let halfSpan = 6.8;
      let rootChord = 7.5;
      let sweepDeg = 35;
      let defaultLeX = -2.2;
      let defaultTeX = 4.6;

      if (modelType === 'f22') {
        halfSpan = surfaceField ? surfaceField.halfSpan : 5.4;
        rootChord = surfaceField ? surfaceField.meanChord : 7.8;
        sweepDeg = 42;
        defaultLeX = -2.0;
        defaultTeX = 4.8;
      } else if (modelType === 'airliner') {
        halfSpan = surfaceField ? surfaceField.halfSpan : 7.2;
        rootChord = surfaceField ? surfaceField.meanChord : 6.8;
        sweepDeg = 32;
        defaultLeX = -1.6;
        defaultTeX = 4.2;
      } else if (modelType === 'concorde') {
        halfSpan = surfaceField ? surfaceField.halfSpan : 4.2;
        rootChord = surfaceField ? surfaceField.meanChord : 10.5;
        sweepDeg = 64;
        defaultLeX = -5.5;
        defaultTeX = 5.5;
      } else if (modelType === 'custom_glb') {
        halfSpan = surfaceField ? surfaceField.halfSpan : 5.5;
        rootChord = surfaceField ? surfaceField.meanChord : 6.2;
        const customClass = calibration?.modelClass;
        sweepDeg =
          customClass === 'delta_fighter'
            ? 45
            : customClass === 'airliner'
              ? 30
              : customClass === 'glider'
                ? 5
                : customClass === 'uav'
                  ? 12
                  : 16;
        defaultLeX = surfaceField ? surfaceField.minX : -3.1;
        defaultTeX = surfaceField ? surfaceField.maxX : 3.1;
      } else {
        halfSpan = surfaceField ? surfaceField.halfSpan : 5.5;
        rootChord = surfaceField ? surfaceField.meanChord : 6.2;
        sweepDeg = 0;
        defaultLeX = -3.1;
        defaultTeX = 3.1;
      }

      const isNonLiftingCustom =
        modelType === 'custom_glb' &&
        (calibration?.modelClass === 'bluff_body' ||
          calibration?.modelClass === 'car' ||
          calibration?.modelClass === 'rocket' ||
          (calibration?.stallAngleDeg ?? 16) <= 0);

      // Elliptic Prandtl peak circulation in normalized tunnel units: Gamma_0 = (2/pi) * vInf * c * CL
      const effectiveCl = isNonLiftingCustom ? 0 : cl;
      const gamma0 = isNonLiftingCustom
        ? 0
        : (2 / Math.PI) * vInf * rootChord * effectiveCl;

      const baseCore = 0.38 + visualViscosity * 1.15;

      // --- A. 6-PANEL ELLIPTICAL BIOT-SAVART HORSESHOE VORTEX FILAMENTS ---
      _bsOut.u = 0;
      _bsOut.v = 0;
      _bsOut.w = 0;

      if (!isNonLiftingCustom && Math.abs(gamma0) > 1e-4) {
        const panels = SOLVER_METADATA_3D.vortexPanelCount;
        const panelWidth = (2 * halfSpan) / panels;

        for (let i = 0; i < panels; i++) {
          const z1 = -halfSpan + i * panelWidth;
          const z2 = z1 + panelWidth;
          const zMid = 0.5 * (z1 + z2);

          const zNorm = Math.min(0.96, Math.abs(zMid) / halfSpan);
          const panelGamma = gamma0 * Math.sqrt(Math.max(0.08, 1 - zNorm * zNorm));

          let qcX1: number, teX1: number, y1: number;
          let qcX2: number, teX2: number, y2: number;

          if (surfaceField && surfaceField.getSpanSection(z1 * 0.92, _spanInfo)) {
            qcX1 = _spanInfo.quarterChordX;
            teX1 = _spanInfo.teX;
            y1 = _spanInfo.yMid;
          } else {
            const sw1 = Math.tan((sweepDeg * Math.PI) / 180) * Math.abs(z1) * 0.52;
            qcX1 = defaultLeX + 0.25 * rootChord + sw1;
            teX1 = defaultTeX + sw1 * 0.35;
            y1 = 0;
          }

          if (surfaceField && surfaceField.getSpanSection(z2 * 0.92, _spanInfo)) {
            qcX2 = _spanInfo.quarterChordX;
            teX2 = _spanInfo.teX;
            y2 = _spanInfo.yMid;
          } else {
            const sw2 = Math.tan((sweepDeg * Math.PI) / 180) * Math.abs(z2) * 0.52;
            qcX2 = defaultLeX + 0.25 * rootChord + sw2;
            teX2 = defaultTeX + sw2 * 0.35;
            y2 = 0;
          }

          const wAx = qcX1 * cosA + y1 * sinA;
          const wAy = -qcX1 * sinA + y1 * cosA;
          const wBx = qcX2 * cosA + y2 * sinA;
          const wBy = -qcX2 * sinA + y2 * cosA;

          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wAx, wAy, z1,
            wBx, wBy, z2,
            -panelGamma,
            baseCore * 1.25,
            _bsOut
          );

          const dGammaFactor = 0.35 + 0.65 * zNorm;
          const wTe1x = teX1 * cosA + y1 * sinA;
          const wTe1y = -teX1 * sinA + y1 * cosA;
          const wTe2x = teX2 * cosA + y2 * sinA;
          const wTe2y = -teX2 * sinA + y2 * cosA;

          const dxDown = Math.max(0, p.x - 0.5 * (wTe1x + wTe2x));
          const wakeCore = baseCore * 0.8 + Math.sqrt(Math.max(0, 0.14 * viscosity * dxDown));

          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wAx, wAy, z1,
            wTe1x + 24.0, wTe1y - 1.4 * sinA, z1 * 0.96,
            panelGamma * dGammaFactor * 0.55,
            wakeCore,
            _bsOut
          );

          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wBx, wBy, z2,
            wTe2x + 24.0, wTe2y - 1.4 * sinA, z2 * 0.96,
            -panelGamma * dGammaFactor * 0.55,
            wakeCore,
            _bsOut
          );
        }
      }

      // --- B. LAMB-OSEEN COUNTER-ROTATING WINGTIP VORTEX PAIR ---
      const tipVortexMultiplier = isNonLiftingCustom
        ? 0
        : calibration
          ? 0.25 + calibration.wingtipVortexStrength * 1.5
          : 1.0;
      if (!isNonLiftingCustom && Math.abs(effectiveCl) > 0.05 && tipVortexMultiplier > 0.08) {
        const hasTipSec = surfaceField && surfaceField.getSpanSection(halfSpan * 0.9, _spanInfo);
        const tipStartX = hasTipSec ? _spanInfo.teX * 0.85 : defaultTeX * 0.85;
        const tipYMid = hasTipSec ? _spanInfo.yMid : 0;
        const wTipX = tipStartX * cosA + tipYMid * sinA;
        const wTipY = -tipStartX * sinA + tipYMid * cosA;
        const tipDx = Math.max(0, p.x - wTipX);
        const tipCore = 0.28 + visualViscosity * 0.85 + Math.sqrt(Math.max(0, 0.12 * visualViscosity * tipDx));
        const tipGamma = gamma0 * 1.15 * tipVortexMultiplier;

        for (const sign of [-1, 1]) {
          const tipZ = sign * halfSpan * 0.97;
          const endZ = sign * halfSpan * 0.92;
          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wTipX, wTipY, tipZ,
            wTipX + 26.0, wTipY - 1.6 * sinA, endZ,
            -sign * tipGamma,
            tipCore,
            _bsOut
          );
        }
      }

      // --- C. DELTA LEADING-EDGE & CHINE VORTEX FILAMENTS ---
      const isDeltaClass =
        modelType === 'concorde' ||
        modelType === 'f22' ||
        calibration?.modelClass === 'delta_fighter';
      if (isDeltaClass && aoaDeg > 2.0) {
        const levGamma =
          (aoaDeg / 18) *
          vInf *
          (modelType === 'concorde' ? 2.6 : calibration?.modelClass === 'delta_fighter' ? 2.2 : 1.7);
        const levCore = 0.28 + visualViscosity * 0.65;
        const apexX =
          modelType === 'concorde'
            ? -6.5
            : surfaceField
              ? surfaceField.minX * 0.85
              : -5.0;
        const apexZ = modelType === 'concorde' ? 0.35 : Math.min(0.85, halfSpan * 0.15);
        const rearX = surfaceField ? surfaceField.maxX * 0.82 : defaultTeX;
        const rearZ = halfSpan * 0.84;

        for (const sign of [-1, 1]) {
          const ax = apexX * cosA;
          const ay = -apexX * sinA + 0.22;
          const bxEnd = rearX * cosA;
          const byEnd = -rearX * sinA + 0.45 * Math.sin(aoaRad) + 0.22;
          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            ax, ay, sign * apexZ,
            bxEnd, byEnd, sign * rearZ,
            -sign * levGamma,
            levCore,
            _bsOut
          );
        }
      }

      const bsMag = Math.hypot(_bsOut.u, _bsOut.v, _bsOut.w);
      const maxBs = vInf * 1.5;
      if (bsMag > maxBs) {
        const s = maxBs / bsMag;
        u += _bsOut.u * s;
        v += _bsOut.v * s;
        w += _bsOut.w * s;
      } else {
        u += _bsOut.u;
        v += _bsOut.v;
        w += _bsOut.w;
      }

      // --- C2. SLENDER-BODY FUSELAGE & NACELLE RANKINE SOURCE-SINK + RADIAL DOUBLET ---
      const isPureAirfoil =
        modelType === 'naca0012' ||
        modelType === 'naca2412' ||
        modelType === 'validation_wing' ||
        modelType === 'custom_airfoil' ||
        (modelType === 'custom_glb' &&
          surfaceField !== null &&
          surfaceField.height / Math.max(0.5, 2 * surfaceField.halfLength) <= 0.08);
      if (!isPureAirfoil && surfaceField) {
        const bodyLen = Math.max(1.5, 2 * surfaceField.halfLength);
        const fineness = Math.min(0.45, surfaceField.height / bodyLen);
        const noseX = surfaceField.minX + 0.12 * bodyLen;
        const tailX = surfaceField.maxX - 0.16 * bodyLen;
        const bodyYMid = 0.5 * (surfaceField.minY + surfaceField.maxY);
        const qStrength = 0.55 * vInf * fineness * bodyLen * 0.25;
        const epsSq = Math.max(0.18, 0.22 * surfaceField.height * surfaceField.height);

        const dyB = by - bodyYMid;
        const rLateralSq = dyB * dyB + bz * bz;
        // Axisymmetric nose source - tail sink
        const dNoseX = bx - noseX;
        const dTailX = bx - tailX;
        const rNose3 = Math.pow(dNoseX * dNoseX + rLateralSq + epsSq, 1.5);
        const rTail3 = Math.pow(dTailX * dTailX + rLateralSq + epsSq, 1.5);

        let ubBody = qStrength * (dNoseX / rNose3 - dTailX / rTail3);
        let vbBody = qStrength * dyB * (1 / rNose3 - 1 / rTail3);
        let wbBody = qStrength * bz * (1 / rNose3 - 1 / rTail3);

        // Transverse radial doublet over fuselage spine for smooth nose/canopy parting
        if (bx >= surfaceField.minX - 0.8 && bx <= surfaceField.maxX + 0.6 && rLateralSq < (surfaceField.height * 2.5) ** 2 + 1.0) {
          const rBody = Math.max(0.28, 0.38 * surfaceField.height);
          const denomD = Math.pow(rLateralSq + epsSq * 0.85, 2);
          const doubletK = 0.35 * vInf * rBody * rBody;
          vbBody += (doubletK * dyB) / Math.max(0.08, denomD);
          wbBody += (doubletK * bz) / Math.max(0.08, denomD);
          ubBody -= (0.14 * vInf * fineness) / Math.sqrt(1 + rLateralSq / Math.max(0.2, epsSq));
        }

        const wuB = ubBody * cosA + vbBody * sinA;
        const wvB = -ubBody * sinA + vbBody * cosA;
        u += wuB;
        v += wvB;
        w += wbBody;
      }

      if (!isStalled && u < vInf * 0.25) {
        u = vInf * 0.25;
      }

      // --- D. VISUAL WAKE SHEDDING FOR STALLED / BLUFF BODIES ---
      const isBluffWake =
        calibration &&
        ((calibration.modelClass === 'bluff_body' && calibration.wakeTurbulenceOnset >= 0.25) ||
          (calibration.modelClass === 'car' && calibration.wakeTurbulenceOnset >= 0.35));
      const wakeOnsetFactor = calibration ? 0.55 + calibration.wakeTurbulenceOnset * 0.9 : 1.0;

      if ((isStalled || isBluffWake) && Math.abs(bz) <= halfSpan * 1.08) {
        const localChordStart = surfaceField && surfaceField.getSpanSection(bz, _spanInfo)
          ? _spanInfo.leX
          : defaultLeX;
        const stallStartX = isBluffWake ? (surfaceField ? surfaceField.maxX * 0.25 : 0.8) : localChordStart + 1.1;
        const wakeYMin = surfaceField ? surfaceField.minY - 0.3 : -0.65;
        const wakeYMax = surfaceField ? surfaceField.maxY + 1.8 : 3.6;

        if (bx > stallStartX && by > wakeYMin && by < wakeYMax) {
          const wakeRefY = surfaceField ? 0.5 * (surfaceField.minY + surfaceField.maxY) : 0;
          const wakeProx =
            Math.exp(-Math.max(0, by - wakeRefY) / (1.4 + visualViscosity * 1.5)) * wakeOnsetFactor;
          const shedSpacing = 2.4;
          const shedSpeed = vInf * 0.65;
          const phase = (timeSec * shedSpeed) % shedSpacing;

          _bsOut.u = 0;
          _bsOut.v = 0;
          _bsOut.w = 0;
          for (let s = 0; s < 3; s++) {
            const edX = stallStartX + 1.0 + s * shedSpacing + phase;
            const edY = wakeRefY + 0.5 + s * 0.22 + Math.sin(timeSec * 3.5 + s * 2.1 + Math.abs(bz)) * 0.35;
            const edSign = s % 2 === 0 ? 1 : -1;
            vorticity += addBiotSavartSegment(
              p.x, p.y, p.z,
              edX, edY, bz - 1.5,
              edX, edY, bz + 1.5,
              edSign * vInf * 1.25 * wakeOnsetFactor,
              0.52 + visualViscosity * 0.7,
              _bsOut
            );
          }

          u += _bsOut.u * wakeProx - 0.35 * vInf * wakeProx;
          v += _bsOut.v * wakeProx;
          w += Math.sin(timeSec * 5.0 + bx * 1.4 + bz) * 0.25 * vInf * wakeProx;
          isSeparated = true;
        }
      }

      // --- E. SUPERSONIC MACH CONE KINEMATIC DEFLECTION (Mach >= 1.0) ---
      if (mach >= 1.0) {
        const noseX = surfaceField ? surfaceField.minX : -6.5;
        const wNoseX = noseX * cosA;
        const wNoseY = -noseX * sinA;
        const dxNose = p.x - wNoseX;
        if (dxNose > 0) {
          const mu = Math.asin(1 / Math.max(1.001, mach));
          const coneR = dxNose * Math.tan(mu);
          const radial = Math.hypot(p.y - wNoseY, p.z);
          const distToShock = Math.abs(radial - coneR);
          if (distToShock < 0.7 && radial > 0.08) {
            const shockPulse = Math.exp(-distToShock / 0.3) * 0.4 * vInf;
            v += ((p.y - wNoseY) / radial) * shockPulse;
            w += (p.z / radial) * shockPulse;
            u *= 0.92;
          }
        }
      }

      // --- F. ENGINE EXHAUST JET MOMENTUM (F-22 & Boeing 787) ---
      if (modelType === 'f22' && bx > 5.0) {
        const jetPower = airspeed_kts >= 450 ? (airspeed_kts / 380) * 1.15 : 0.42;
        for (const nz of [-0.67, 0.67]) {
          const rJet = Math.hypot(bz - nz, by + 0.38);
          if (rJet < 1.35) {
            u += jetPower * vInf * Math.exp(-rJet / 0.55);
          }
        }
      } else if (modelType === 'airliner' && bx > -0.6) {
        for (const nz of [-3.6, 3.6]) {
          const rJet = Math.hypot(bz - nz, by + 1.45);
          const jetLen = bx + 0.6;
          const jetWidth = 0.8 + jetLen * 0.045;
          if (rJet < jetWidth * 1.7) {
            u += 0.8 * vInf * Math.exp(-rJet / jetWidth) * Math.exp(-jetLen / 18.0);
          }
        }
      }

      // --- G. APPROXIMATE 84x48x84 SDF SURFACE BOUNDARY CONSTRAINT ---
      if (surfaceField && surfaceField.sample(bx, by, bz, _surfSample)) {
        const dist = _surfSample.dist;
        const dMin = surfaceField.dMin;
        const bHalo = Math.max(dMin + 0.28, 0.56 + visualViscosity * 0.24);

        if (dist < bHalo) {
          const wnx = _surfSample.nx * cosA + _surfSample.ny * sinA;
          const wny = -_surfSample.nx * sinA + _surfSample.ny * cosA;
          const wnz = _surfSample.nz;

          let wBlend = 1.0;
          if (dist > dMin) {
            const denom = Math.max(0.05, bHalo - dMin);
            const t = Math.max(0, Math.min(1, (bHalo - dist) / denom));
            wBlend = t * t * (3 - 2 * t);
          }

          // Smooth tangential normal sliding: project out ONLY inward normal velocity
          const vDotN = u * wnx + v * wny + w * wnz;
          if (vDotN < 0) {
            u -= vDotN * wnx * wBlend;
            v -= vDotN * wny * wBlend;
            w -= vDotN * wnz * wBlend;
          }

          // Gentle outward normal recovery strictly inside 0.5 * dMin to eliminate grazing penetration
          const recoveryFloor = 0.5 * dMin;
          if (dist < recoveryFloor) {
            const pen = recoveryFloor - dist;
            const cushion = Math.min(1.6 * vInf, (pen / Math.max(0.05, recoveryFloor)) * 0.95 * vInf);
            u += wnx * cushion;
            v += wny * cushion;
            w += wnz * cushion;
          }

          // Smooth stagnation split near blunt noses
          if (wnx < -0.55) {
            const tangSpeed = Math.hypot(u, v, w);
            if (tangSpeed < 0.3 * vInf) {
              const bodyMidY = 0.5 * (surfaceField.minY + surfaceField.maxY);
              const splitDirY =
                Math.abs(_surfSample.ny) >= 0.02
                  ? (_surfSample.ny >= 0 ? 1 : -1)
                  : (by >= bodyMidY ? 1 : -1);
              v += splitDirY * 0.34 * vInf;
              if (Math.abs(_surfSample.ny) < 0.15 && Math.abs(_surfSample.nz) >= 0.05) {
                w += (_surfSample.nz >= 0 ? 1 : -1) * 0.22 * vInf;
              }
            }
          }
        }
      } else {
        const absZ = Math.abs(bz);
        if (absZ < halfSpan && bx > defaultLeX && bx < defaultTeX) {
          const distY = Math.abs(by);
          if (distY < 0.42) {
            const push = ((0.42 - distY) / 0.42) * 0.85 * vInf;
            v += (by >= 0 ? push : -push) * cosA;
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. RAW PHYSICAL Cp + PRANDTL-GLAUERT SCALING SEPARATED FROM COLOR CLAMPING
    // -------------------------------------------------------------------------
    const speed = Math.hypot(u, v, w);
    const cpIncompressible = computeRawCp(speed, vInf);
    const pressureCoeff = applyPrandtlGlauertCp(cpIncompressible, Math.max(0, mach));
    const pressureCoeffClamped = clampCpForColorMap(pressureCoeff, -3.5, 1.0);

    return {
      u,
      v,
      w,
      speed,
      cpIncompressible,
      pressureCoeff,
      pressureCoeffClamped,
      vorticity,
      isSeparated,
    };
  }

  /**
   * Zero-allocation 2-step RK2 (Midpoint) particle advection capped at displacement <= dsMax per sub-step
   * with smooth SDF tangential sliding and `dMin` exterior recovery.
   */
  public static stepParticleRK2(
    px: number,
    py: number,
    pz: number,
    params: Fluid3DParams,
    dtTotal: number,
    dsMax: number,
    outPos: Vertex3D,
    outVel: Velocity3DResult
  ): void {
    const sf = params.surfaceField;
    const minClearance = sf ? Math.max(0.08, sf.dMin * 0.65) : 0.12;
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    let cx = px;
    let cy = py;
    let cz = pz;

    const v0 = FluidDynamics3D.getVelocity({ x: cx, y: cy, z: cz }, params);
    const estDisp = Math.max(0.01, v0.speed * dtTotal);
    const subSteps = Math.max(1, Math.min(8, Math.ceil(estDisp / Math.max(0.018, dsMax))));
    const subDt = dtTotal / subSteps;

    let lastVel = v0;
    for (let s = 0; s < subSteps; s++) {
      const v1 = s === 0 ? v0 : FluidDynamics3D.getVelocity({ x: cx, y: cy, z: cz }, params);
      const midX = cx + v1.u * (0.5 * subDt);
      const midY = cy + v1.v * (0.5 * subDt);
      const midZ = cz + v1.w * (0.5 * subDt);

      const v2 = FluidDynamics3D.getVelocity({ x: midX, y: midY, z: midZ }, params);
      cx += v2.u * subDt;
      cy += v2.v * subDt;
      cz += v2.w * subDt;

      if (params.modelType === 'cylinder') {
        const constrained = FluidDynamics3D.constrainToExterior({ x: cx, y: cy, z: cz }, params, minClearance);
        cx = constrained.x;
        cy = constrained.y;
        cz = constrained.z;
      } else if (sf) {
        const bx = cx * cosA - cy * sinA;
        const by = cx * sinA + cy * cosA;
        if (sf.sample(bx, by, cz, _surfSample) && _surfSample.dist < minClearance) {
          const push = minClearance - _surfSample.dist + 0.01;
          const nbx = bx + _surfSample.nx * push;
          const nby = by + _surfSample.ny * push;
          const nbz = cz + _surfSample.nz * push;
          cx = nbx * cosA + nby * sinA;
          cy = -nbx * sinA + nby * cosA;
          cz = nbz;
        }
      }

      lastVel = v2;
    }

    outPos.x = cx;
    outPos.y = cy;
    outPos.z = cz;
    outVel.u = lastVel.u;
    outVel.v = lastVel.v;
    outVel.w = lastVel.w;
    outVel.speed = lastVel.speed;
    outVel.cpIncompressible = lastVel.cpIncompressible;
    outVel.pressureCoeff = lastVel.pressureCoeff;
    outVel.pressureCoeffClamped = lastVel.pressureCoeffClamped;
    outVel.vorticity = lastVel.vorticity;
    outVel.isSeparated = lastVel.isSeparated;
  }

  /**
   * Numerically integrates a 3D vortex streamline using 2nd-order Runge-Kutta (RK2 / Midpoint Method)
   * with exterior surface projection and adaptive sub-stepping capped at `dsMax <= 0.03 * c_tunnel / resolution`.
   */
  public static traceStreamline(
    start: Vertex3D,
    params: Fluid3DParams,
    steps = 165,
    ds = 0.22
  ): (Vertex3D & { speed: number; pressureCoeff: number; pressureCoeffClamped: number; vorticity: number; isSeparated: boolean })[] {
    const points: (Vertex3D & {
      speed: number;
      pressureCoeff: number;
      pressureCoeffClamped: number;
      vorticity: number;
      isSeparated: boolean;
    })[] = [];
    const sf = params.surfaceField;
    const clearance = sf ? Math.max(0.14, sf.dMin) : 0.16;
    const frame = FluidDynamics3D.getDynamicEmitterFrame(sf, 1.0, params.streamlineResolution ?? 1.0);
    const dsMax = frame.dsMax;
    const xExit = Math.max(22, frame.xRecycle + 4);
    const yLimit = Math.max(9, frame.yHalf * 4.5);
    const zLimit = Math.max(14, frame.zHalf * 2.2);

    let cur: Vertex3D = FluidDynamics3D.constrainToExterior({ ...start }, params, clearance);

    const advanceRK2 = (pt: Vertex3D, stepLen: number) => {
      const v1 = FluidDynamics3D.getVelocity(pt, params);
      const len1 = v1.speed || 1;
      const midRaw: Vertex3D = {
        x: pt.x + (v1.u / len1) * (stepLen * 0.5),
        y: pt.y + (v1.v / len1) * (stepLen * 0.5),
        z: pt.z + (v1.w / len1) * (stepLen * 0.5),
      };
      const mid = FluidDynamics3D.constrainToExterior(midRaw, params, clearance);
      const v2 = FluidDynamics3D.getVelocity(mid, params);
      const len2 = v2.speed || 1;
      const nextRaw: Vertex3D = {
        x: pt.x + (v2.u / len2) * stepLen,
        y: pt.y + (v2.v / len2) * stepLen,
        z: pt.z + (v2.w / len2) * stepLen,
      };
      return {
        next: FluidDynamics3D.constrainToExterior(nextRaw, params, clearance),
        vel: v1,
      };
    };

    const subSteps = Math.max(1, Math.min(8, Math.ceil(ds / dsMax)));
    const subLen = ds / subSteps;

    for (let i = 0; i < steps; i++) {
      if (cur.x > xExit || Math.abs(cur.y) > yLimit || Math.abs(cur.z) > zLimit) break;

      let firstVel: Velocity3DResult | null = null;
      for (let sub = 0; sub < subSteps; sub++) {
        const res = advanceRK2(cur, subLen);
        if (sub === 0) firstVel = res.vel;
        cur = res.next;
      }

      if (firstVel) {
        points.push({
          x: cur.x,
          y: cur.y,
          z: cur.z,
          speed: firstVel.speed,
          pressureCoeff: firstVel.pressureCoeff,
          pressureCoeffClamped: firstVel.pressureCoeffClamped,
          vorticity: firstVel.vorticity,
          isSeparated: firstVel.isSeparated,
        });
      }
    }

    return points;
  }
}
