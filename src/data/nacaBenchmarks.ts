import { AeroTelemetry, AircraftModelType } from '../types/aerodynamics';

export interface BenchmarkPolarPoint {
  aoa: number;
  cl2d: number;
  cd2d: number;
}

export interface BenchmarkCpStation {
  xc: number;
  cpUpper: number;
  cpLower: number;
}

export interface NacaBenchmarkDataset {
  id: 'naca0012' | 'naca2412';
  name: string;
  reference: string;
  reynoldsRef: number;
  machRef: number;
  alphaZeroLiftDeg: number;
  stallAngleDeg: number;
  clMax2d: number;
  cdMin2d: number;
  polar: BenchmarkPolarPoint[];
  cpProfiles: Array<{
    aoa: number;
    stations: BenchmarkCpStation[];
  }>;
}

/**
 * Reference experimental & XFOIL validation datasets at Re = 3.0 x 10^6 (smooth surface, M <= 0.15)
 * Sources: Abbott & von Doenhoff, "Theory of Wing Sections" (NACA TR-824) & XFOIL v6.99 (N_crit = 9).
 */
export const NACA_BENCHMARKS: Record<'naca0012' | 'naca2412', NacaBenchmarkDataset> = {
  naca0012: {
    id: 'naca0012',
    name: 'NACA 0012 (Symmetric 12%)',
    reference: 'Abbott & von Doenhoff (NACA TR-824) / XFOIL, Re = 3.0×10⁶',
    reynoldsRef: 3_000_000,
    machRef: 0.15,
    alphaZeroLiftDeg: 0.0,
    stallAngleDeg: 15.5,
    clMax2d: 1.54,
    cdMin2d: 0.0061,
    polar: [
      { aoa: -16, cl2d: -1.42, cd2d: 0.0480 },
      { aoa: -14, cl2d: -1.44, cd2d: 0.0255 },
      { aoa: -12, cl2d: -1.28, cd2d: 0.0182 },
      { aoa: -10, cl2d: -1.08, cd2d: 0.0140 },
      { aoa: -8, cl2d: -0.87, cd2d: 0.0110 },
      { aoa: -6, cl2d: -0.65, cd2d: 0.0089 },
      { aoa: -4, cl2d: -0.44, cd2d: 0.0074 },
      { aoa: -2, cl2d: -0.22, cd2d: 0.0065 },
      { aoa: 0, cl2d: 0.00, cd2d: 0.0061 },
      { aoa: 2, cl2d: 0.22, cd2d: 0.0065 },
      { aoa: 4, cl2d: 0.44, cd2d: 0.0074 },
      { aoa: 6, cl2d: 0.65, cd2d: 0.0089 },
      { aoa: 8, cl2d: 0.87, cd2d: 0.0110 },
      { aoa: 10, cl2d: 1.08, cd2d: 0.0140 },
      { aoa: 12, cl2d: 1.28, cd2d: 0.0182 },
      { aoa: 14, cl2d: 1.44, cd2d: 0.0255 },
      { aoa: 15.5, cl2d: 1.54, cd2d: 0.0375 },
      { aoa: 17, cl2d: 1.22, cd2d: 0.0920 },
      { aoa: 19, cl2d: 1.04, cd2d: 0.1650 },
      { aoa: 22, cl2d: 0.92, cd2d: 0.2850 },
    ],
    cpProfiles: [
      {
        aoa: 0,
        stations: [
          { xc: 0.0, cpUpper: 1.0, cpLower: 1.0 },
          { xc: 0.025, cpUpper: -0.22, cpLower: -0.22 },
          { xc: 0.075, cpUpper: -0.41, cpLower: -0.41 },
          { xc: 0.15, cpUpper: -0.43, cpLower: -0.43 },
          { xc: 0.30, cpUpper: -0.35, cpLower: -0.35 },
          { xc: 0.50, cpUpper: -0.23, cpLower: -0.23 },
          { xc: 0.70, cpUpper: -0.11, cpLower: -0.11 },
          { xc: 0.85, cpUpper: -0.01, cpLower: -0.01 },
          { xc: 1.0, cpUpper: 0.16, cpLower: 0.16 },
        ],
      },
      {
        aoa: 6,
        stations: [
          { xc: 0.0, cpUpper: 0.92, cpLower: 0.92 },
          { xc: 0.025, cpUpper: -2.05, cpLower: 0.56 },
          { xc: 0.075, cpUpper: -1.52, cpLower: 0.26 },
          { xc: 0.15, cpUpper: -1.18, cpLower: 0.12 },
          { xc: 0.30, cpUpper: -0.78, cpLower: 0.02 },
          { xc: 0.50, cpUpper: -0.47, cpLower: -0.03 },
          { xc: 0.70, cpUpper: -0.25, cpLower: 0.00 },
          { xc: 0.85, cpUpper: -0.10, cpLower: 0.06 },
          { xc: 1.0, cpUpper: 0.14, cpLower: 0.14 },
        ],
      },
      {
        aoa: 12,
        stations: [
          { xc: 0.0, cpUpper: 0.65, cpLower: 0.65 },
          { xc: 0.025, cpUpper: -3.65, cpLower: 0.86 },
          { xc: 0.075, cpUpper: -2.42, cpLower: 0.55 },
          { xc: 0.15, cpUpper: -1.78, cpLower: 0.36 },
          { xc: 0.30, cpUpper: -1.10, cpLower: 0.19 },
          { xc: 0.50, cpUpper: -0.64, cpLower: 0.08 },
          { xc: 0.70, cpUpper: -0.33, cpLower: 0.04 },
          { xc: 0.85, cpUpper: -0.14, cpLower: 0.06 },
          { xc: 1.0, cpUpper: 0.10, cpLower: 0.10 },
        ],
      },
    ],
  },
  naca2412: {
    id: 'naca2412',
    name: 'NACA 2412 (2% Camber, 12%)',
    reference: 'Abbott & von Doenhoff (NACA TR-824) / XFOIL, Re = 3.0×10⁶',
    reynoldsRef: 3_000_000,
    machRef: 0.15,
    alphaZeroLiftDeg: -2.1,
    stallAngleDeg: 16.0,
    clMax2d: 1.66,
    cdMin2d: 0.0063,
    polar: [
      { aoa: -14, cl2d: -1.18, cd2d: 0.0390 },
      { aoa: -12, cl2d: -1.06, cd2d: 0.0210 },
      { aoa: -10, cl2d: -0.85, cd2d: 0.0145 },
      { aoa: -8, cl2d: -0.64, cd2d: 0.0110 },
      { aoa: -6, cl2d: -0.43, cd2d: 0.0088 },
      { aoa: -4, cl2d: -0.21, cd2d: 0.0072 },
      { aoa: -2, cl2d: 0.01, cd2d: 0.0064 },
      { aoa: 0, cl2d: 0.24, cd2d: 0.0063 },
      { aoa: 2, cl2d: 0.46, cd2d: 0.0066 },
      { aoa: 4, cl2d: 0.67, cd2d: 0.0073 },
      { aoa: 6, cl2d: 0.88, cd2d: 0.0086 },
      { aoa: 8, cl2d: 1.09, cd2d: 0.0106 },
      { aoa: 10, cl2d: 1.29, cd2d: 0.0138 },
      { aoa: 12, cl2d: 1.46, cd2d: 0.0185 },
      { aoa: 14, cl2d: 1.59, cd2d: 0.0268 },
      { aoa: 16, cl2d: 1.65, cd2d: 0.0410 },
      { aoa: 18, cl2d: 1.38, cd2d: 0.0980 },
      { aoa: 20, cl2d: 1.15, cd2d: 0.1780 },
      { aoa: 22, cl2d: 0.98, cd2d: 0.2750 },
    ],
    cpProfiles: [
      {
        aoa: 0,
        stations: [
          { xc: 0.0, cpUpper: 0.99, cpLower: 0.99 },
          { xc: 0.025, cpUpper: -0.42, cpLower: 0.05 },
          { xc: 0.075, cpUpper: -0.62, cpLower: -0.18 },
          { xc: 0.15, cpUpper: -0.65, cpLower: -0.22 },
          { xc: 0.30, cpUpper: -0.58, cpLower: -0.15 },
          { xc: 0.50, cpUpper: -0.43, cpLower: -0.08 },
          { xc: 0.70, cpUpper: -0.26, cpLower: -0.02 },
          { xc: 0.85, cpUpper: -0.10, cpLower: 0.04 },
          { xc: 1.0, cpUpper: 0.15, cpLower: 0.15 },
        ],
      },
      {
        aoa: 6,
        stations: [
          { xc: 0.0, cpUpper: 0.88, cpLower: 0.88 },
          { xc: 0.025, cpUpper: -2.28, cpLower: 0.64 },
          { xc: 0.075, cpUpper: -1.74, cpLower: 0.36 },
          { xc: 0.15, cpUpper: -1.39, cpLower: 0.20 },
          { xc: 0.30, cpUpper: -1.01, cpLower: 0.11 },
          { xc: 0.50, cpUpper: -0.66, cpLower: 0.06 },
          { xc: 0.70, cpUpper: -0.39, cpLower: 0.07 },
          { xc: 0.85, cpUpper: -0.18, cpLower: 0.10 },
          { xc: 1.0, cpUpper: 0.13, cpLower: 0.13 },
        ],
      },
      {
        aoa: 12,
        stations: [
          { xc: 0.0, cpUpper: 0.58, cpLower: 0.58 },
          { xc: 0.025, cpUpper: -3.85, cpLower: 0.89 },
          { xc: 0.075, cpUpper: -2.61, cpLower: 0.60 },
          { xc: 0.15, cpUpper: -1.96, cpLower: 0.41 },
          { xc: 0.30, cpUpper: -1.29, cpLower: 0.25 },
          { xc: 0.50, cpUpper: -0.80, cpLower: 0.15 },
          { xc: 0.70, cpUpper: -0.45, cpLower: 0.11 },
          { xc: 0.85, cpUpper: -0.20, cpLower: 0.10 },
          { xc: 1.0, cpUpper: 0.09, cpLower: 0.09 },
        ],
      },
    ],
  },
};

export function hasNacaBenchmark(
  modelType: AircraftModelType
): modelType is 'naca0012' | 'naca2412' {
  return modelType === 'naca0012' || modelType === 'naca2412';
}

export function getNacaBenchmark(
  modelType: AircraftModelType
): NacaBenchmarkDataset | null {
  return hasNacaBenchmark(modelType) ? NACA_BENCHMARKS[modelType] : null;
}

/**
 * Converts a 2D Abbott & von Doenhoff wind-tunnel section point (cl2d, cd2d)
 * to an equivalent 3D finite-wing comparison point via Prandtl Lifting-Line:
 *   CL_3D = cl_2D / (1 + a0 / (pi * e * AR))  (applied at matched effective AoA)
 *   CD_3D = cd_2D + CL_3D^2 / (pi * e * AR)
 */
export function convert2DBenchmarkToFiniteWing(
  pt: BenchmarkPolarPoint,
  aspectRatio: number,
  oswaldEfficiency: number
): { aoa: number; cl3d: number; cd3d: number } {
  const ar = Math.max(1.5, aspectRatio);
  const e = Math.max(0.4, Math.min(1.0, oswaldEfficiency));
  const a0PerRad = 2 * Math.PI;
  const finiteFactor = ar / (ar + a0PerRad / (Math.PI * e));
  const cl3d = pt.cl2d * finiteFactor;
  const cd3d = pt.cd2d + (cl3d * cl3d) / (Math.PI * e * ar);
  return {
    aoa: pt.aoa,
    cl3d: Number(cl3d.toFixed(4)),
    cd3d: Number(cd3d.toFixed(4)),
  };
}

export function interpolateBenchmarkAtAoa(
  dataset: NacaBenchmarkDataset,
  aoaDeg: number
): { cl2d: number; cd2d: number } {
  const pts = dataset.polar;
  if (aoaDeg <= pts[0].aoa) return { cl2d: pts[0].cl2d, cd2d: pts[0].cd2d };
  const last = pts[pts.length - 1];
  if (aoaDeg >= last.aoa) return { cl2d: last.cl2d, cd2d: last.cd2d };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (aoaDeg >= a.aoa && aoaDeg <= b.aoa) {
      const t = (aoaDeg - a.aoa) / Math.max(1e-6, b.aoa - a.aoa);
      return {
        cl2d: a.cl2d + (b.cl2d - a.cl2d) * t,
        cd2d: a.cd2d + (b.cd2d - a.cd2d) * t,
      };
    }
  }
  return { cl2d: 0, cd2d: dataset.cdMin2d };
}

/**
 * Returns interpolated XFOIL/NACA reference Cp stations at the active AoA.
 * For negative AoA on symmetric NACA 0012, reflects upper/lower symmetry cleanly.
 */
export function getBenchmarkCpStations(
  dataset: NacaBenchmarkDataset,
  aoaDeg: number
): BenchmarkCpStation[] {
  const profiles = dataset.cpProfiles;
  const isSymmetric = dataset.id === 'naca0012';
  const targetAoa = isSymmetric ? Math.abs(aoaDeg) : Math.max(0, aoaDeg);
  const clamped = Math.max(profiles[0].aoa, Math.min(profiles[profiles.length - 1].aoa, targetAoa));

  let p0 = profiles[0];
  let p1 = profiles[profiles.length - 1];
  let t = 0;

  for (let i = 0; i < profiles.length - 1; i++) {
    if (clamped >= profiles[i].aoa && clamped <= profiles[i + 1].aoa) {
      p0 = profiles[i];
      p1 = profiles[i + 1];
      t = (clamped - p0.aoa) / Math.max(1e-6, p1.aoa - p0.aoa);
      break;
    }
  }

  return p0.stations.map((s0, idx) => {
    const s1 = p1.stations[idx] || s0;
    const cpU = s0.cpUpper + (s1.cpUpper - s0.cpUpper) * t;
    const cpL = s0.cpLower + (s1.cpLower - s0.cpLower) * t;
    if (isSymmetric && aoaDeg < 0) {
      return {
        xc: s0.xc,
        cpUpper: Number(cpL.toFixed(3)),
        cpLower: Number(cpU.toFixed(3)),
      };
    }
    return {
      xc: s0.xc,
      cpUpper: Number(cpU.toFixed(3)),
      cpLower: Number(cpL.toFixed(3)),
    };
  });
}

export interface BenchmarkDeviationMetrics {
  datasetName: string;
  reference: string;
  reynoldsRef: number;
  aoaClampedDeg: number;
  refCl2d: number;
  refCd2d: number;
  refCl3dFinite: number;
  refCd3dFinite: number;
  deltaClVs2d: number;
  deltaCdVs2d: number;
  deltaClVs3dFinite: number;
  deltaCdVs3dFinite: number;
  rmseClAttached: number;
  rmseCdAttached: number;
}

export function computeBenchmarkDeviation(
  modelType: AircraftModelType,
  telemetry: AeroTelemetry,
  aoaDeg: number,
  simSweep: Array<{ aoa: number; cl: number; cd: number }>
): BenchmarkDeviationMetrics | null {
  const dataset = getNacaBenchmark(modelType);
  if (!dataset) return null;

  const minAoa = dataset.polar[0].aoa;
  const maxAoa = dataset.polar[dataset.polar.length - 1].aoa;
  const aoaClamped = Math.max(minAoa, Math.min(maxAoa, aoaDeg));

  const pt2d = interpolateBenchmarkAtAoa(dataset, aoaClamped);
  const pt3d = convert2DBenchmarkToFiniteWing(
    { aoa: aoaClamped, cl2d: pt2d.cl2d, cd2d: pt2d.cd2d },
    telemetry.aspectRatio,
    telemetry.oswaldEfficiency
  );

  // Compute RMSE across attached/pre-stall envelope (-12 deg to stallAngle - 1 deg) against Prandtl finite-wing benchmark
  let sqErrCl = 0;
  let sqErrCd = 0;
  let count = 0;

  for (const simPt of simSweep) {
    if (simPt.aoa < -12 || simPt.aoa > dataset.stallAngleDeg - 1) continue;
    const ref2d = interpolateBenchmarkAtAoa(dataset, simPt.aoa);
    const ref3d = convert2DBenchmarkToFiniteWing(
      { aoa: simPt.aoa, cl2d: ref2d.cl2d, cd2d: ref2d.cd2d },
      telemetry.aspectRatio,
      telemetry.oswaldEfficiency
    );
    sqErrCl += Math.pow(simPt.cl - ref3d.cl3d, 2);
    sqErrCd += Math.pow(simPt.cd - ref3d.cd3d, 2);
    count++;
  }

  return {
    datasetName: dataset.name,
    reference: dataset.reference,
    reynoldsRef: dataset.reynoldsRef,
    aoaClampedDeg: aoaClamped,
    refCl2d: Number(pt2d.cl2d.toFixed(3)),
    refCd2d: Number(pt2d.cd2d.toFixed(4)),
    refCl3dFinite: Number(pt3d.cl3d.toFixed(3)),
    refCd3dFinite: Number(pt3d.cd3d.toFixed(4)),
    deltaClVs2d: Number((telemetry.cl - pt2d.cl2d).toFixed(3)),
    deltaCdVs2d: Number((telemetry.cd - pt2d.cd2d).toFixed(4)),
    deltaClVs3dFinite: Number((telemetry.cl - pt3d.cl3d).toFixed(3)),
    deltaCdVs3dFinite: Number((telemetry.cd - pt3d.cd3d).toFixed(4)),
    rmseClAttached: count > 0 ? Number(Math.sqrt(sqErrCl / count).toFixed(3)) : 0,
    rmseCdAttached: count > 0 ? Number(Math.sqrt(sqErrCd / count).toFixed(4)) : 0,
  };
}
