import { AircraftModelType } from '../types/aerodynamics';
import { AeroCalibration } from '../lib/calibration';
import { Vertex3D } from '../utils/aircraft3DGeometry';
import { AircraftSurfaceField, SpanSectionInfo, SurfaceSample } from './AircraftSurfaceField';
import type { MeshBvhCollider } from './MeshBvhCollider';
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
  bvhCollider?: MeshBvhCollider | null;
  calibration?: AeroCalibration | null;
}

export interface ModelBoundingBox {
  center: Vertex3D;
  minX: number;
  maxX: number;
  halfY: number;
  halfZ: number;
  lengthX: number;
}

export const DEFAULT_LAYER_GAP = 0.55;
export const MAX_UNIFIED_FILAMENTS = 200;
export const UNIFIED_Z_FRACTIONS = [
  -1.45, -1.15, -0.95, -0.65, -0.35, 0, 0.35, 0.65, 0.95, 1.15, 1.45,
] as const;

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

export type ModelFlowArchetype =
  | 'extruded_2d_wing'
  | 'winged_aircraft'
  | 'slender_delta'
  | 'bluff_body';

export interface ModelFlowProfile {
  archetype: ModelFlowArchetype;
  label: string;
  detail: string;
  halfSpan: number;
  meanChord: number;
  aspectRatio: number;
  taperRatio: number;
  thicknessRatio: number;
  vortexCoreScale: number;
  boundaryLayerScale: number;
  centerRakeShare: number;
  upwashPrecompY: number;
  wingVerticalSpan: number;
  centerVerticalSpan: number;
  pivInnerYFrac: number;
  pivOuterYFrac: number;
  pivInnerZFrac: number;
  xSpawn: number;
  xRecycle: number;
}

export interface SmokeRakeSeed {
  x: number;
  y: number;
  z: number;
  role: 'centerline' | 'wing' | 'tip' | 'wake';
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
  if (crossSq < 1e-14) return 0;

  const safeCore = Math.max(0, coreRadius);
  // Scully / Vatistas viscous core damping factor: h^2 / (h^2 + r_c^2)
  const hSq = crossSq / dlSq;
  const scullyDamping = safeCore > 0 ? hSq / (hSq + safeCore * safeCore) : 1;

  const dot1 = (dlx * r1x + dly * r1y + dlz * r1z) / r1;
  const dot2 = (dlx * r2x + dly * r2y + dlz * r2z) / r2;
  const factor = (gamma / (4 * Math.PI)) * ((dot1 - dot2) / crossSq) * scullyDamping;

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
   * directly from the active normalized AircraftSurfaceField bounding box so both
   * full-length aircraft and compact validation wings/cylinders show a complete
   * upstream approach and downstream wake across the wind tunnel chamber.
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

    const tunnelRef = Math.max(halfLength, 0.52 * (0.5 * modelSpan), 4.8);
    const xSpawn = Math.min(
      minX - Math.max(4.5, 1.25 * halfLength),
      -Math.max(9.5, 1.55 * tunnelRef)
    );
    const xRecycle = Math.max(
      maxX + Math.max(7.5, 2.1 * halfLength),
      Math.max(12.5, 2.25 * tunnelRef)
    );

    return {
      xSpawn,
      xRecycle,
      yMid,
      yHalf: Math.max(
        1.85 * spread,
        0.5 * 1.45 * modelHeight * spread,
        0.34 * Math.min(6.5, chordRef) * spread
      ),
      zHalf: Math.max(2.4 * spread, 0.5 * 1.22 * modelSpan * spread),
      halfLength,
      modelHeight,
      modelSpan,
      chordRef,
      dsMax: Math.max(0.018, (0.03 * chordRef) / res),
    };
  }

  /**
   * Automatically inspects any loaded or modified 3D geometry (procedural wings,
   * 2D-to-3D extruded airfoils, cylinders, or custom uploaded GLBs) and derives
   * optimized Biot–Savart core scaling, boundary-layer thickness, upwash rake
   * compensation, and PIV volumetric distribution parameters.
   */
  public static analyzeModelFlowProfile(
    sf: AircraftSurfaceField | null | undefined,
    params: Pick<Fluid3DParams, 'modelType' | 'aoaDeg' | 'cl' | 'calibration'>,
    rakeSpread = 1.0
  ): ModelFlowProfile {
    const spread = Math.max(0.4, Math.min(2.5, rakeSpread));
    const frame = FluidDynamics3D.getDynamicEmitterFrame(sf, spread, 1.0);
    const metrics = sf ? sf.analyzeSpanDistribution() : null;

    const halfSpan = sf ? sf.halfSpan : params.modelType === 'cylinder' ? CYLINDER_RADIUS : 5.2;
    const meanChord = metrics
      ? metrics.meanChord
      : params.modelType === 'validation_wing'
        ? 10.0 / 6.0
        : params.modelType === 'concorde'
          ? 10.5
          : 5.5;
    const taperRatio = metrics ? metrics.taperRatio : 0.65;
    const fuselageToWingRatio = metrics ? metrics.fuselageToWingRatio : 1.2;
    const modelHeight = sf ? sf.height : params.modelType === 'cylinder' ? 2 * CYLINDER_HALF_HEIGHT : 1.8;
    const aspectRatio = Math.max(0.4, (2 * halfSpan) / Math.max(0.4, meanChord));
    const thicknessRatio = modelHeight / Math.max(0.5, meanChord);

    const calClass = params.calibration?.modelClass;
    const isExplicitWing =
      params.modelType === 'naca0012' ||
      params.modelType === 'naca2412' ||
      params.modelType === 'validation_wing' ||
      params.modelType === 'custom_airfoil';
    const isBluffModel =
      params.modelType === 'cylinder' ||
      calClass === 'bluff_body' ||
      calClass === 'car' ||
      calClass === 'rocket' ||
      (sf !== null &&
        sf !== undefined &&
        ((sf.halfSpan < 1.8 && modelHeight > sf.halfSpan * 0.95) ||
          (taperRatio > 0.7 && thicknessRatio > 0.65)));

    let archetype: ModelFlowArchetype;
    if (isBluffModel) {
      archetype = 'bluff_body';
    } else if (
      isExplicitWing ||
      (params.modelType === 'custom_glb' &&
        metrics !== null &&
        taperRatio >= 0.72 &&
        fuselageToWingRatio <= 1.38 &&
        modelHeight / Math.max(0.5, halfSpan) <= 0.34)
    ) {
      archetype = 'extruded_2d_wing';
    } else if (
      params.modelType === 'concorde' ||
      params.modelType === 'f22' ||
      calClass === 'delta_fighter' ||
      (metrics !== null && taperRatio < 0.42 && frame.halfLength > halfSpan * 0.85)
    ) {
      archetype = 'slender_delta';
    } else {
      archetype = 'winged_aircraft';
    }

    const vortexCoreScale = Math.max(0.35, Math.min(1.25, meanChord / 5.5));
    const wingThick = metrics ? metrics.wingMeanThickness : Math.max(0.22, modelHeight * 0.25);
    const boundaryLayerScale = Math.max(
      0.48,
      Math.min(1.15, (0.38 * meanChord + 0.75 * wingThick) / 3.2)
    );

    const effectiveCl = archetype === 'bluff_body' ? 0 : params.cl;
    // Compensate upstream Biot-Savart upwash so streamlines seeded at xSpawn straddle
    // both the upper suction surface and lower pressure side across AoA changes.
    const upwashPrecompY =
      archetype === 'bluff_body'
        ? 0
        : -Math.max(-0.45, Math.min(0.45, 0.065 * Math.min(5.5, meanChord) * effectiveCl));

    const aoaPitchHeight = Math.abs(Math.sin((params.aoaDeg * Math.PI) / 180)) * Math.min(4.8, 0.48 * meanChord);
    const wingVerticalSpan =
      archetype === 'extruded_2d_wing'
        ? Math.max(1.25, 0.22 * meanChord + 0.65 * aoaPitchHeight + 0.45 * wingThick) * Math.min(1.45, spread)
        : Math.max(0.95, 0.55 * wingThick + 0.32 * Math.min(4.0, meanChord) + 0.45 * aoaPitchHeight) *
          Math.min(1.35, spread);

    const centerVerticalSpan =
      archetype === 'extruded_2d_wing'
        ? wingVerticalSpan
        : archetype === 'bluff_body'
          ? Math.max(1.5, 0.46 * modelHeight) * Math.min(1.4, spread)
          : Math.max(1.45, 0.58 * modelHeight + 0.4 * aoaPitchHeight) * Math.min(1.35, spread);

    const label =
      archetype === 'extruded_2d_wing'
        ? '2D Extruded Wing'
        : archetype === 'bluff_body'
          ? 'Bluff Wake Body'
          : archetype === 'slender_delta'
            ? 'Slender Delta Airframe'
            : '3D Winged Airframe';

    const detail =
      archetype === 'extruded_2d_wing'
        ? `AR ${aspectRatio.toFixed(1)} · Full-span upper/lower rakes · x[${frame.xSpawn.toFixed(1)}..+${frame.xRecycle.toFixed(1)}]`
        : archetype === 'bluff_body'
          ? `Full-silhouette wake grid · x[${frame.xSpawn.toFixed(1)}..+${frame.xRecycle.toFixed(1)}]`
          : `Taper ${taperRatio.toFixed(2)} · Adaptive span/tail rakes · x[${frame.xSpawn.toFixed(1)}..+${frame.xRecycle.toFixed(1)}]`;

    return {
      archetype,
      label,
      detail,
      halfSpan,
      meanChord,
      aspectRatio,
      taperRatio,
      thicknessRatio,
      vortexCoreScale,
      boundaryLayerScale,
      centerRakeShare: archetype === 'extruded_2d_wing' ? 0.22 : 0.34,
      upwashPrecompY,
      wingVerticalSpan,
      centerVerticalSpan,
      pivInnerYFrac: archetype === 'extruded_2d_wing' ? 0.78 : archetype === 'bluff_body' ? 0.84 : 0.68,
      pivOuterYFrac: archetype === 'extruded_2d_wing' ? 1.24 : 1.08,
      pivInnerZFrac: archetype === 'extruded_2d_wing' ? 0.88 : 0.74,
      xSpawn: frame.xSpawn,
      xRecycle: frame.xRecycle,
    };
  }

  /**
   * Rejects or validates upstream emitter seeds against `dMin` surface clearance
   * using both the SDF/analytical guard and the active `MeshBvhCollider`.
   */
  public static isValidEmitterSeed(
    x: number,
    y: number,
    z: number,
    params: Fluid3DParams
  ): boolean {
    const clearance = params.surfaceField ? params.surfaceField.dMin : 0.16;
    if (FluidDynamics3D.isInsideSolid({ x, y, z }, params, clearance)) {
      return false;
    }
    if (params.bvhCollider) {
      const aoaRad = (params.aoaDeg * Math.PI) / 180;
      const sinA = Math.sin(aoaRad);
      const cosA = Math.cos(aoaRad);
      const bx = x * cosA - y * sinA;
      const by = x * sinA + y * cosA;
      if (params.bvhCollider.isPointInsideOrNear(bx, by, z, clearance, params.surfaceField)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Derives a world-space `ModelBoundingBox` from an `AircraftSurfaceField`, `MeshBvhCollider`,
   * or analytical model defaults when a Three.js `Box3` is not directly supplied.
   */
  public static getModelBoundingBox(
    sf: AircraftSurfaceField | null | undefined,
    params: Pick<Fluid3DParams, 'modelType' | 'aoaDeg' | 'bvhCollider'>
  ): ModelBoundingBox {
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    let bMinX = -3.1;
    let bMaxX = 3.1;
    let bMinY = -0.6;
    let bMaxY = 0.6;
    let bMinZ = -5.0;
    let bMaxZ = 5.0;

    if (params.modelType === 'cylinder') {
      bMinX = -CYLINDER_RADIUS;
      bMaxX = CYLINDER_RADIUS;
      bMinY = -CYLINDER_HALF_HEIGHT;
      bMaxY = CYLINDER_HALF_HEIGHT;
      bMinZ = -CYLINDER_RADIUS;
      bMaxZ = CYLINDER_RADIUS;
    } else if (params.bvhCollider) {
      const bb = params.bvhCollider.boundingBox;
      bMinX = bb.min.x;
      bMaxX = bb.max.x;
      bMinY = bb.min.y;
      bMaxY = bb.max.y;
      bMinZ = bb.min.z;
      bMaxZ = bb.max.z;
    } else if (sf) {
      bMinX = sf.minX;
      bMaxX = sf.maxX;
      bMinY = sf.minY;
      bMaxY = sf.maxY;
      bMinZ = -sf.halfSpan;
      bMaxZ = sf.halfSpan;
    } else if (params.modelType === 'f22') {
      bMinX = -3.5;
      bMaxX = 6.5;
      bMinY = -1.2;
      bMaxY = 1.2;
      bMinZ = -5.4;
      bMaxZ = 5.4;
    } else if (params.modelType === 'airliner') {
      bMinX = -3.5;
      bMaxX = 6.5;
      bMinY = -1.4;
      bMaxY = 1.4;
      bMinZ = -7.2;
      bMaxZ = 7.2;
    } else if (params.modelType === 'concorde') {
      bMinX = -5.5;
      bMaxX = 5.5;
      bMinY = -1.1;
      bMaxY = 1.1;
      bMinZ = -4.2;
      bMaxZ = 4.2;
    }

    let wMinX = Infinity;
    let wMaxX = -Infinity;
    let wMinY = Infinity;
    let wMaxY = -Infinity;
    for (const bx of [bMinX, bMaxX]) {
      for (const by of [bMinY, bMaxY]) {
        const wx = bx * cosA + by * sinA;
        const wy = -bx * sinA + by * cosA;
        if (wx < wMinX) wMinX = wx;
        if (wx > wMaxX) wMaxX = wx;
        if (wy < wMinY) wMinY = wy;
        if (wy > wMaxY) wMaxY = wy;
      }
    }

    const centerX = 0.5 * (wMinX + wMaxX);
    const centerY = 0.5 * (wMinY + wMaxY);
    const centerZ = 0.5 * (bMinZ + bMaxZ);
    return {
      center: { x: centerX, y: centerY, z: centerZ },
      minX: wMinX,
      maxX: wMaxX,
      halfY: Math.max(0.25, 0.5 * (wMaxY - wMinY)),
      halfZ: Math.max(0.35, 0.5 * (bMaxZ - bMinZ)),
      lengthX: Math.max(0.8, wMaxX - wMinX),
    };
  }

  /**
   * Unified bounding-box and boundary-clustered upstream emitter rake across all models
   * (`cylinder`, airfoils/wings, spheres, aircraft, and custom `.glb` assets).
   * - Spawns at `minX - 1.5 * lengthX` upstream.
   * - Generates symmetric interior Y-layers spaced by `layerGap` plus pinned boundary
   *   layers near tips/end-caps (`±0.92 * halfY` and `±0.99 * halfY`).
   * - Clusters lateral Z-seeds at stagnation centerline (`0`) and edges/wingtips
   *   (`±0.35, ±0.65, ±0.95, ±1.15, ±1.45 × halfZ × rakeSpread`).
   * - Enforces `maxFilaments <= 200` by symmetrically thinning interior Y-layers while
   *   always preserving `center.y` and the pinned boundary layers.
   */
  public static buildUnifiedRakeSeeds(
    bounds: ModelBoundingBox,
    params: Fluid3DParams,
    options?: {
      layerGap?: number;
      rakeSpread?: number;
      maxFilaments?: number;
    }
  ): SmokeRakeSeed[] {
    const gap = Math.max(0.25, Math.min(1.2, options?.layerGap ?? DEFAULT_LAYER_GAP));
    const spread = Math.max(0.4, Math.min(2.5, options?.rakeSpread ?? 1.0));
    const maxFilaments = Math.max(1, Math.min(MAX_UNIFIED_FILAMENTS, options?.maxFilaments ?? MAX_UNIFIED_FILAMENTS));

    const safeHalfY = Math.max(0.25, bounds.halfY);
    const safeHalfZ = Math.max(0.35, bounds.halfZ);
    const safeLengthX = Math.max(0.8, bounds.lengthX);
    const xSpawn = bounds.minX - 1.5 * safeLengthX;

    const zSeeds = UNIFIED_Z_FRACTIONS.map((frac) => ({
      frac,
      z: bounds.center.z + frac * safeHalfZ * spread,
    }));

    // Symmetric interior positive offsets spaced by `layerGap`
    const interiorLimit =
      spread > 1.02
        ? Math.max(safeHalfY * spread, safeHalfY + (spread - 1.0) * 1.35)
        : safeHalfY * 0.89 * spread;
    const pinned92 = 0.92 * safeHalfY;
    const pinned99 = 0.99 * safeHalfY;

    const interiorPosOffsets: number[] = [];
    for (let k = 1; ; k++) {
      const yOff = k * gap;
      if (yOff > interiorLimit) break;
      // Avoid near-duplicate collision with the pinned 0.92 / 0.99 boundary layers
      if (Math.abs(yOff - pinned92) < 0.04 || Math.abs(yOff - pinned99) < 0.04) {
        continue;
      }
      if (yOff < pinned92 || spread > 1.02) {
        if (yOff < pinned92 || yOff > pinned99 + 0.04) {
          interiorPosOffsets.push(yOff);
        }
      }
    }

    // Symmetrically thin interior Y-layers if (layers * zSeeds.length) > maxFilaments,
    // while ALWAYS preserving center.y (0) and pinned boundary layers (±0.92, ±0.99 * halfY).
    const maxLayers = Math.max(5, Math.floor(maxFilaments / zSeeds.length));
    const maxInteriorPairs = Math.max(0, Math.floor((maxLayers - 5) / 2));

    let selectedInteriorPos = interiorPosOffsets;
    if (interiorPosOffsets.length > maxInteriorPairs) {
      selectedInteriorPos = [];
      for (let i = 0; i < maxInteriorPairs; i++) {
        const idx = Math.min(
          interiorPosOffsets.length - 1,
          Math.round(((i + 0.5) * interiorPosOffsets.length) / maxInteriorPairs - 0.5)
        );
        const val = interiorPosOffsets[idx];
        if (
          selectedInteriorPos.length === 0 ||
          Math.abs(selectedInteriorPos[selectedInteriorPos.length - 1] - val) > 1e-6
        ) {
          selectedInteriorPos.push(val);
        }
      }
    }

    const posWithPinned = [...selectedInteriorPos, pinned92, pinned99].sort((a, b) => a - b);
    const yLayers: { y: number; isBoundary: boolean }[] = [
      ...posWithPinned
        .slice()
        .reverse()
        .map((d) => ({
          y: bounds.center.y - d,
          isBoundary: Math.abs(d - pinned92) < 1e-5 || Math.abs(d - pinned99) < 1e-5,
        })),
      { y: bounds.center.y, isBoundary: false },
      ...posWithPinned.map((d) => ({
        y: bounds.center.y + d,
        isBoundary: Math.abs(d - pinned92) < 1e-5 || Math.abs(d - pinned99) < 1e-5,
      })),
    ];

    const isBluff =
      params.modelType === 'cylinder' ||
      params.calibration?.modelClass === 'bluff_body' ||
      params.calibration?.modelClass === 'car' ||
      params.calibration?.modelClass === 'rocket';

    const seeds: SmokeRakeSeed[] = [];
    for (const layer of yLayers) {
      for (const zSeed of zSeeds) {
        if (seeds.length >= maxFilaments) break;
        if (!FluidDynamics3D.isValidEmitterSeed(xSpawn, layer.y, zSeed.z, params)) {
          continue;
        }
        const absFrac = Math.abs(zSeed.frac);
        let role: SmokeRakeSeed['role'];
        if (absFrac < 0.01) {
          role = 'centerline';
        } else if (layer.isBoundary || Math.abs(absFrac - 0.95) < 0.08 || Math.abs(absFrac - 1.15) < 0.08) {
          role = 'tip';
        } else if (isBluff) {
          role = 'wake';
        } else {
          role = 'wing';
        }
        seeds.push({ x: xSpawn, y: layer.y, z: zSeed.z, role });
      }
    }

    return seeds;
  }

  /**
   * Generates physics-calibrated upstream smoke rake nozzle coordinates tailored
   * to the active auto-analyzed model profile (uniform-span 2D airfoil upper/lower
   * envelopes, nose/canopy/tail centerline + local-dihedral wing stations, or
   * full-height bluff-body wake capture grids).
   */
  public static buildSmokeRakeSeeds(
    sf: AircraftSurfaceField | null | undefined,
    params: Fluid3DParams,
    rakeSpread = 1.0,
    smokeDensity = 0.8,
    targetLineCount?: number
  ): SmokeRakeSeed[] {
    const frame = FluidDynamics3D.getDynamicEmitterFrame(sf, rakeSpread, params.streamlineResolution ?? 1.0);
    const profile = FluidDynamics3D.analyzeModelFlowProfile(sf, params, rakeSpread);
    const spread = Math.max(0.4, Math.min(2.5, rakeSpread));
    const density = Math.max(0.25, Math.min(1.5, smokeDensity));
    const desiredCount = Math.max(
      2,
      Math.min(48, Math.round(targetLineCount ?? (14 + Math.round(density * 6))))
    );
    const seeds: SmokeRakeSeed[] = [];
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    const pushIfValid = (x: number, y: number, z: number, role: SmokeRakeSeed['role']): boolean => {
      if (seeds.length >= desiredCount) return false;
      if (FluidDynamics3D.isValidEmitterSeed(x, y, z, params)) {
        seeds.push({ x, y, z, role });
        return true;
      }
      return false;
    };

    if (profile.archetype === 'bluff_body') {
      const rowCount = desiredCount <= 6 ? 2 : desiredCount <= 16 ? 3 : desiredCount <= 30 ? 4 : 5;
      const ySpan = profile.centerVerticalSpan;
      const colCount = Math.max(2, Math.ceil(desiredCount / rowCount));
      const maxZ = Math.max(2.35, profile.halfSpan * 1.25) * Math.min(1.35, spread);

      for (let r = 0; r < rowCount && seeds.length < desiredCount; r++) {
        const yFrac = rowCount <= 1 ? 0 : (r / (rowCount - 1)) * 2 - 1;
        const yOff = frame.yMid + yFrac * ySpan;
        for (let c = 0; c < colCount && seeds.length < desiredCount; c++) {
          const zFrac = colCount === 1 ? 0 : (c / (colCount - 1)) * 2 - 1;
          const zOff = zFrac * maxZ;
          pushIfValid(frame.xSpawn, yOff, zOff, Math.abs(zOff) <= profile.halfSpan * 1.15 ? 'wake' : 'wing');
        }
      }
      return seeds;
    }

    const halfSpan = profile.halfSpan;
    const isExtrudedWing = profile.archetype === 'extruded_2d_wing';

    const worldSectionY = (bz: number): number => {
      if (sf && sf.getSpanSection(bz, _spanInfo)) {
        return -_spanInfo.quarterChordX * sinA + _spanInfo.yMid * cosA;
      }
      return frame.yMid;
    };

    // Reserve budget cleanly across tip cores, centerline rake, and spanwise wing sections
    const tipBudget = desiredCount >= 14 ? 4 : desiredCount >= 6 ? 2 : 0;
    const remainingAfterTip = Math.max(0, desiredCount - tipBudget);
    let centerBudget = Math.max(
      desiredCount >= 3 ? 2 : 1,
      Math.min(12, Math.round(remainingAfterTip * profile.centerRakeShare))
    );
    let wingBudget = Math.max(0, remainingAfterTip - centerBudget);
    if (wingBudget % 2 === 1) {
      wingBudget -= 1;
      centerBudget += 1;
    }

    // 1. Centerline / Fuselage & Canopy vertical smoke rake (with upwash pre-compensation)
    const centerBaseY = worldSectionY(0) + profile.upwashPrecompY * (isExtrudedWing ? 1.0 : 0.5);
    const dyCenterSpan = profile.centerVerticalSpan;
    for (let i = 0; i < centerBudget && seeds.length < desiredCount; i++) {
      const frac = centerBudget === 1 ? 0.5 : i / (centerBudget - 1);
      const dy = (-1.0 + frac * (isExtrudedWing ? 2.0 : 2.15)) * dyCenterSpan;
      pushIfValid(frame.xSpawn, centerBaseY + dy, 0, 'centerline');
    }

    // 2. Symmetric Spanwise Wing Section Rakes
    // Guarantee at least 2 vertical levels (lower pressure + upper suction) per span station when pairCount >= 2.
    if (wingBudget >= 2) {
      const pairCount = Math.floor(wingBudget / 2);
      const spanStations =
        pairCount === 1 ? 1 : Math.max(1, Math.min(isExtrudedWing ? 6 : 5, Math.floor(pairCount / 2)));
      const fracStart = isExtrudedWing ? 0.22 : 0.24;
      const fracEnd = isExtrudedWing ? 0.86 : 0.80;

      // Distribute pairs across stations while guaranteeing >= 2 vertical levels per station when possible
      const baseLevels = Math.floor(pairCount / spanStations);
      const extraPairs = pairCount % spanStations;

      for (let st = 0; st < spanStations && seeds.length < desiredCount; st++) {
        const spanFrac =
          spanStations === 1
            ? (fracStart + fracEnd) * 0.5
            : fracStart + (st / (spanStations - 1)) * (fracEnd - fracStart);
        const levelsHere = baseLevels + (st < extraPairs ? 1 : 0);

        for (let lv = 0; lv < levelsHere && seeds.length < desiredCount; lv++) {
          const vertNorm = levelsHere === 1 ? 0.25 : -1.0 + (2.0 * lv) / (levelsHere - 1);
          const dy = vertNorm * profile.wingVerticalSpan;

          for (const side of [-1, 1]) {
            const bz = side * halfSpan * spanFrac * Math.min(1.18, spread);
            const wY = worldSectionY(bz) + profile.upwashPrecompY;
            pushIfValid(frame.xSpawn, wY + dy, bz, 'wing');
          }
        }
      }
    }

    // 3. Outboard Wingtip Vortex Rakes
    if (tipBudget > 0 && seeds.length < desiredCount) {
      const tipZ = halfSpan * 0.95 * Math.min(1.12, spread);
      for (const side of [-1, 1]) {
        const bz = side * tipZ;
        const tipY = worldSectionY(bz) + profile.upwashPrecompY * 0.5;
        if (tipBudget >= 4) {
          pushIfValid(frame.xSpawn, tipY - 0.22, bz * 0.96, 'tip');
          pushIfValid(frame.xSpawn, tipY + 0.22, bz * 1.03, 'tip');
        } else {
          pushIfValid(frame.xSpawn, tipY, bz * 0.98, 'tip');
        }
      }
    }

    return seeds;
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
    let pressureSpeedOverride = -1;

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

      const coreScale = Math.max(0.35, Math.min(1.25, rootChord / 5.5));
      const baseCore = (0.38 + visualViscosity * 1.15) * coreScale;

      const aspectRatioVis = Math.max(2.0, (2 * halfSpan) / Math.max(0.5, rootChord));
      const downwashSlope = Math.max(
        -0.38,
        Math.min(0.38, (2 * effectiveCl) / (Math.PI * 0.85 * aspectRatioVis))
      );

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
            baseCore * 1.2,
            _bsOut
          );

          const dGammaFactor = 0.35 + 0.65 * zNorm;
          const wTe1x = teX1 * cosA + y1 * sinA;
          const wTe1y = -teX1 * sinA + y1 * cosA;
          const wTe2x = teX2 * cosA + y2 * sinA;
          const wTe2y = -teX2 * sinA + y2 * cosA;

          const dxDown = Math.max(0, p.x - 0.5 * (wTe1x + wTe2x));
          const wakeCore = Math.sqrt(
            baseCore * baseCore * 0.64 + Math.max(0, 0.16 * (0.04 + visualViscosity) * dxDown)
          );
          const wakeLen = 24.0;
          const wakeDrop = downwashSlope * wakeLen;

          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wAx, wAy, z1,
            wTe1x + wakeLen, wTe1y - wakeDrop, z1 * 0.95,
            panelGamma * dGammaFactor * 0.55,
            wakeCore,
            _bsOut
          );

          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wBx, wBy, z2,
            wTe2x + wakeLen, wTe2y - wakeDrop, z2 * 0.95,
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
        const tipR0 = (0.26 + visualViscosity * 0.75) * Math.max(0.45, coreScale);
        const tipCore = Math.sqrt(tipR0 * tipR0 + Math.max(0, 0.18 * (0.03 + visualViscosity) * tipDx));
        const tipGamma = gamma0 * 1.2 * tipVortexMultiplier;
        const tipWakeLen = 26.0;
        const tipWakeDrop = downwashSlope * tipWakeLen;

        for (const sign of [-1, 1]) {
          const tipZ = sign * halfSpan * 0.97;
          const endZ = sign * halfSpan * 0.90;
          vorticity += addBiotSavartSegment(
            p.x, p.y, p.z,
            wTipX, wTipY, tipZ,
            wTipX + tipWakeLen, wTipY - tipWakeDrop, endZ,
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
      // Clamp induced velocity to <= 35% of freestream speed to prevent vortex spikes near surfaces
      const maxBs = vInf * 0.35;
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
          // Radial parting integrates to zero along the body (opens at nose, closes cleanly behind tail)
          const xi = (bx - surfaceField.minX) / bodyLen;
          const radialWindow = xi >= 0 && xi <= 1 ? Math.cos(Math.PI * xi) : 0;
          vbBody += (radialWindow * doubletK * dyB) / Math.max(0.08, denomD);
          wbBody += (radialWindow * doubletK * bz) / Math.max(0.08, denomD);
        }

        const wuB = ubBody * cosA + vbBody * sinA;
        const wvB = -ubBody * sinA + vbBody * cosA;
        u += wuB;
        v += wvB;
        w += wbBody;
      }

      // --- D. COHERENT WAKE DEFICIT & STROUHAL VORTEX SHEDDING (STALL / BLUFF) ---
      const isBluffWake =
        calibration &&
        ((calibration.modelClass === 'bluff_body' && calibration.wakeTurbulenceOnset >= 0.25) ||
          (calibration.modelClass === 'car' && calibration.wakeTurbulenceOnset >= 0.35));
      const wakeOnsetFactor = calibration ? 0.55 + calibration.wakeTurbulenceOnset * 0.9 : 1.0;

      if ((isStalled || isBluffWake) && Math.abs(bz) <= halfSpan * 1.08) {
        const hasSpan = surfaceField && surfaceField.getSpanSection(bz, _spanInfo);
        const localChordStart = hasSpan ? _spanInfo.leX : defaultLeX;
        const localChord = hasSpan ? _spanInfo.chord : rootChord;
        const stallStartX = isBluffWake
          ? (surfaceField ? surfaceField.maxX * 0.2 : 0.6)
          : localChordStart + 0.35 * localChord;
        const wakeYMin = surfaceField ? surfaceField.minY - 0.6 : -0.9;
        const wakeYMax = surfaceField ? surfaceField.maxY + 2.2 : 3.8;

        if (bx > stallStartX && by > wakeYMin && by < wakeYMax) {
          const wakeRefY = hasSpan ? _spanInfo.yMid : (surfaceField ? 0.5 * (surfaceField.minY + surfaceField.maxY) : 0);
          const dxWake = Math.max(0, bx - stallStartX);
          const sigmaY = 0.55 + 0.32 * Math.sqrt(dxWake) + visualViscosity * 0.8;
          const yWakeCenter = wakeRefY + 0.35 * Math.sin(aoaRad) * Math.min(2.0, dxWake * 0.25);
          const dyWake = by - yWakeCenter;
          const wakeEnvelope =
            Math.exp(-(dyWake * dyWake) / (2 * sigmaY * sigmaY)) *
            (1 - Math.exp(-dxWake / 0.85)) *
            wakeOnsetFactor;

          const shedSpacing = 2.6;
          const shedSpeed = vInf * 0.72;
          const phase = (timeSec * shedSpeed) % shedSpacing;

          _bsOut.u = 0;
          _bsOut.v = 0;
          _bsOut.w = 0;
          for (let s = 0; s < 4; s++) {
            const edX = stallStartX + 0.9 + s * shedSpacing + phase;
            const edY =
              yWakeCenter +
              0.25 * (s % 2 === 0 ? 1 : -1) +
              Math.sin(timeSec * 3.2 + s * 2.0 + Math.abs(bz) * 0.4) * 0.38;
            const edSign = s % 2 === 0 ? 1 : -1;
            const edCore = 0.48 + visualViscosity * 0.65 + s * 0.08;
            vorticity += addBiotSavartSegment(
              p.x, p.y, p.z,
              edX, edY, bz - 1.6,
              edX, edY, bz + 1.6,
              edSign * vInf * 1.15 * wakeOnsetFactor,
              edCore,
              _bsOut
            );
          }

          u += _bsOut.u * wakeEnvelope - 0.38 * vInf * wakeEnvelope;
          v += _bsOut.v * wakeEnvelope;
          w += Math.sin(timeSec * 4.4 + bx * 1.2 + bz) * 0.16 * vInf * wakeEnvelope;
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

      // --- G. OPENFOAM-INSPIRED SDF WALL IMPERMEABILITY & PRANDTL BOUNDARY LAYER ---
      if (surfaceField && surfaceField.sample(bx, by, bz, _surfSample)) {
        const dist = _surfSample.dist;
        const dMin = surfaceField.dMin;
        const blScale = Math.max(
          0.48,
          Math.min(1.15, (0.38 * rootChord + 0.75 * surfaceField.height) / 3.2)
        );
        const clearanceFloor = Math.max(0.06, dMin * 0.35);
        const blThickness = (0.10 + visualViscosity * 0.42) * blScale;
        const bHalo = Math.max(dMin + 0.14 * blScale, clearanceFloor + blThickness + 0.12 * blScale);

        if (dist < bHalo) {
          const wnx = _surfSample.nx * cosA + _surfSample.ny * sinA;
          const wny = -_surfSample.nx * sinA + _surfSample.ny * cosA;
          const wnz = _surfSample.nz;

          const denom = Math.max(0.05, bHalo - clearanceFloor);
          const tWall = Math.max(0, Math.min(1, (bHalo - dist) / denom));
          const wBlend = tWall * tWall * (3 - 2 * tWall);

          // 1. Impermeability condition (u · n = 0 smoothly enforced near solid wall)
          const vDotN = u * wnx + v * wny + w * wnz;
          if (vDotN < 0) {
            u -= vDotN * wnx * wBlend;
            v -= vDotN * wny * wBlend;
            w -= vDotN * wnz * wBlend;
          }

          // 2. Smooth continuous stagnation-line splitting near forward-facing noses
          if (wnx < -0.45) {
            const tangSpeed = Math.hypot(u, v, w);
            const stagThresh = 0.35 * vInf;
            if (tangSpeed < stagThresh) {
              const splitGain = (1 - tangSpeed / stagThresh) * wBlend;
              const bodyMidY = 0.5 * (surfaceField.minY + surfaceField.maxY);
              const splitDirY =
                Math.abs(_surfSample.ny) >= 0.02
                  ? (_surfSample.ny >= 0 ? 1 : -1)
                  : (by >= bodyMidY ? 1 : -1);
              v += splitDirY * 0.32 * vInf * splitGain;
              if (Math.abs(_surfSample.ny) < 0.2 && Math.abs(_surfSample.nz) >= 0.04) {
                w += (_surfSample.nz >= 0 ? 1 : -1) * 0.22 * vInf * splitGain;
              }
            }
          }

          // 3. Outer potential speed preserved for Cp (dp/dn ≈ 0 across thin boundary layer)
          pressureSpeedOverride = Math.hypot(u, v, w);

          // 4. Viscous no-slip boundary-layer shear damping inside delta
          const blEdge = clearanceFloor + blThickness;
          if (dist < blEdge) {
            const yNorm = Math.max(0, Math.min(1, (dist - clearanceFloor) / Math.max(0.04, blThickness)));
            const blFactor = 0.42 + 0.58 * (1 - Math.exp(-3.2 * yNorm * yNorm));
            u *= blFactor;
            v *= blFactor;
            w *= blFactor;
          }

          // 5. Gentle outward normal recovery strictly inside clearanceFloor
          if (dist < clearanceFloor) {
            const pen = clearanceFloor - dist;
            const cushion = Math.min(1.35 * vInf, (pen / Math.max(0.04, clearanceFloor)) * 0.85 * vInf);
            u += wnx * cushion;
            v += wny * cushion;
            w += wnz * cushion;
          }
        }
      } else {
        const absZ = Math.abs(bz);
        if (absZ < halfSpan && bx > defaultLeX && bx < defaultTeX) {
          const distY = Math.abs(by);
          if (distY < 0.32) {
            const push = ((0.32 - distY) / 0.32) * 0.75 * vInf;
            v += (by >= 0 ? push : -push) * cosA;
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. RAW PHYSICAL Cp + PRANDTL-GLAUERT SCALING SEPARATED FROM COLOR CLAMPING
    // -------------------------------------------------------------------------
    const speed = Math.hypot(u, v, w);
    const cpRefSpeed = pressureSpeedOverride >= 0 ? pressureSpeedOverride : speed;
    const cpIncompressible = computeRawCp(cpRefSpeed, vInf);
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
   * Zero-allocation RK2 (Midpoint) particle advection running 4–6 sub-steps per frame (`dt / N`)
   * with `three-mesh-bvh` closest-point no-penetration deflection (`V_tan = V - (V · n)n`)
   * and SDF exterior recovery.
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
    const bvh = params.bvhCollider;
    const minClearance = sf ? Math.max(0.068, sf.dMin * 0.36) : 0.10;
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    let cx = px;
    let cy = py;
    let cz = pz;

    const v0 = FluidDynamics3D.getVelocity({ x: cx, y: cy, z: cz }, params);
    const estDisp = Math.max(0.01, v0.speed * dtTotal);
    const subSteps = Math.max(4, Math.min(6, Math.ceil(estDisp / Math.max(0.018, dsMax))));
    const subDt = dtTotal / subSteps;

    const scratchPt = { x: cx, y: cy, z: cz };
    const scratchVel = { u: v0.u, v: v0.v, w: v0.w };

    let lastVel = v0;
    for (let s = 0; s < subSteps; s++) {
      const v1 = s === 0 ? v0 : FluidDynamics3D.getVelocity({ x: cx, y: cy, z: cz }, params);
      const midX = cx + v1.u * (0.5 * subDt);
      const midY = cy + v1.v * (0.5 * subDt);
      const midZ = cz + v1.w * (0.5 * subDt);

      const v2 = FluidDynamics3D.getVelocity({ x: midX, y: midY, z: midZ }, params);
      scratchVel.u = v2.u;
      scratchVel.v = v2.v;
      scratchVel.w = v2.w;

      scratchPt.x = cx + scratchVel.u * subDt;
      scratchPt.y = cy + scratchVel.v * subDt;
      scratchPt.z = cz + scratchVel.w * subDt;

      let deflectedByBvh = false;
      if (bvh) {
        deflectedByBvh = bvh.deflectWorldPointAndVelocity(
          scratchPt,
          scratchVel,
          params.aoaDeg,
          minClearance,
          sf
        );
      }

      if (!deflectedByBvh) {
        if (params.modelType === 'cylinder') {
          const constrained = FluidDynamics3D.constrainToExterior(scratchPt, params, minClearance);
          scratchPt.x = constrained.x;
          scratchPt.y = constrained.y;
          scratchPt.z = constrained.z;
        } else if (sf) {
          const bx = scratchPt.x * cosA - scratchPt.y * sinA;
          const by = scratchPt.x * sinA + scratchPt.y * cosA;
          if (sf.sample(bx, by, scratchPt.z, _surfSample) && _surfSample.dist < minClearance) {
            const push = minClearance - _surfSample.dist + 0.012;
            const nbx = bx + _surfSample.nx * push;
            const nby = by + _surfSample.ny * push;
            const nbz = scratchPt.z + _surfSample.nz * push;
            scratchPt.x = nbx * cosA + nby * sinA;
            scratchPt.y = -nbx * sinA + nby * cosA;
            scratchPt.z = nbz;

            const wnx = _surfSample.nx * cosA + _surfSample.ny * sinA;
            const wny = -_surfSample.nx * sinA + _surfSample.ny * cosA;
            const wnz = _surfSample.nz;
            const vDotN = scratchVel.u * wnx + scratchVel.v * wny + scratchVel.w * wnz;
            if (vDotN < 0) {
              scratchVel.u -= vDotN * wnx;
              scratchVel.v -= vDotN * wny;
              scratchVel.w -= vDotN * wnz;
            }
          }
        }
      }

      cx = scratchPt.x;
      cy = scratchPt.y;
      cz = scratchPt.z;
      lastVel = v2;
    }

    outPos.x = cx;
    outPos.y = cy;
    outPos.z = cz;
    outVel.u = scratchVel.u;
    outVel.v = scratchVel.v;
    outVel.w = scratchVel.w;
    outVel.speed = Math.hypot(scratchVel.u, scratchVel.v, scratchVel.w);
    outVel.cpIncompressible = lastVel.cpIncompressible;
    outVel.pressureCoeff = lastVel.pressureCoeff;
    outVel.pressureCoeffClamped = lastVel.pressureCoeffClamped;
    outVel.vorticity = lastVel.vorticity;
    outVel.isSeparated = lastVel.isSeparated;
  }

  /**
   * Numerically integrates a 3D vortex streamline using 2nd-order Runge-Kutta (RK2 / Midpoint Method)
   * with 4–6+ sub-steps, BVH surface deflection (`V_tan = V - (V · n)n`), and exterior constraint.
   */
  public static traceStreamline(
    start: Vertex3D,
    params: Fluid3DParams,
    steps = 200,
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
    const bvh = params.bvhCollider;
    const clearance = sf ? Math.max(0.075, sf.dMin * 0.36) : 0.12;
    const frame = FluidDynamics3D.getDynamicEmitterFrame(sf, 1.0, params.streamlineResolution ?? 1.0);
    const dsMax = frame.dsMax;
    const xExit = Math.max(22, frame.xRecycle + Math.max(4.5, frame.halfLength * 0.5));
    const yLimit = Math.max(9, frame.yHalf * 4.5);
    const zLimit = Math.max(14, frame.zHalf * 2.5);
    const aoaRad = (params.aoaDeg * Math.PI) / 180;
    const sinA = Math.sin(aoaRad);
    const cosA = Math.cos(aoaRad);

    const enforceExteriorInPlace = (
      pt: Vertex3D,
      vel: { u: number; v: number; w: number } | null
    ): void => {
      let bvhHandled = false;
      if (bvh) {
        bvhHandled = bvh.deflectWorldPointAndVelocity(pt, vel, params.aoaDeg, clearance, sf);
      }
      if (!bvhHandled) {
        if (params.modelType === 'cylinder') {
          const out = FluidDynamics3D.constrainToExterior(pt, params, clearance);
          pt.x = out.x;
          pt.y = out.y;
          pt.z = out.z;
        } else if (sf) {
          const bx = pt.x * cosA - pt.y * sinA;
          const by = pt.x * sinA + pt.y * cosA;
          if (sf.sample(bx, by, pt.z, _surfSample) && _surfSample.dist < clearance) {
            const out = FluidDynamics3D.constrainToExterior(pt, params, clearance);
            pt.x = out.x;
            pt.y = out.y;
            pt.z = out.z;
          }
        }
      }
    };

    const cur: Vertex3D = { x: start.x, y: start.y, z: start.z };
    enforceExteriorInPlace(cur, null);

    const midPt: Vertex3D = { x: 0, y: 0, z: 0 };
    const midVel = { u: 0, v: 0, w: 0 };
    const stepVel = { u: 0, v: 0, w: 0 };

    const subSteps = Math.max(4, Math.min(6, Math.ceil(ds / dsMax)));
    const subLen = ds / subSteps;

    for (let i = 0; i < steps; i++) {
      if (cur.x > xExit || Math.abs(cur.y) > yLimit || Math.abs(cur.z) > zLimit) break;

      let firstVel: Velocity3DResult | null = null;
      for (let sub = 0; sub < subSteps; sub++) {
        const v1 = FluidDynamics3D.getVelocity(cur, params);
        if (sub === 0) firstVel = v1;

        let dx1: number, dy1: number, dz1: number;
        if (v1.speed > 0.03) {
          dx1 = v1.u / v1.speed;
          dy1 = v1.v / v1.speed;
          dz1 = v1.w / v1.speed;
        } else {
          const yBias = cur.y >= frame.yMid ? 0.55 : -0.55;
          const len = Math.hypot(0.65, yBias);
          dx1 = 0.65 / len;
          dy1 = yBias / len;
          dz1 = 0;
        }

        midPt.x = cur.x + dx1 * (subLen * 0.5);
        midPt.y = cur.y + dy1 * (subLen * 0.5);
        midPt.z = cur.z + dz1 * (subLen * 0.5);
        midVel.u = v1.u;
        midVel.v = v1.v;
        midVel.w = v1.w;
        enforceExteriorInPlace(midPt, midVel);

        const v2 = FluidDynamics3D.getVelocity(midPt, params);
        stepVel.u = v2.u;
        stepVel.v = v2.v;
        stepVel.w = v2.w;
        if (bvh) {
          bvh.deflectWorldPointAndVelocity(midPt, stepVel, params.aoaDeg, clearance, sf);
        }

        const spd2 = Math.hypot(stepVel.u, stepVel.v, stepVel.w);
        let dx2: number, dy2: number, dz2: number;
        if (spd2 > 0.03) {
          dx2 = stepVel.u / spd2;
          dy2 = stepVel.v / spd2;
          dz2 = stepVel.w / spd2;
        } else {
          const yBias = midPt.y >= frame.yMid ? 0.55 : -0.55;
          const len = Math.hypot(0.65, yBias);
          dx2 = 0.65 / len;
          dy2 = yBias / len;
          dz2 = 0;
        }

        cur.x += dx2 * subLen;
        cur.y += dy2 * subLen;
        cur.z += dz2 * subLen;
        enforceExteriorInPlace(cur, stepVel);
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
