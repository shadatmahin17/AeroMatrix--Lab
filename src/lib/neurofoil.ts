import { BZ } from "./lbm/bezierShape.js";
import type { NeutralReferenceData } from "./airfoilRepository.ts";

export interface NeuroFoilFeatures {
  camberPct: number;
  camberX: number;
  thicknessPct: number;
  thickX: number;
  leRadiusNorm: number;
  teAngleDeg: number;
  reflexPct: number;
}

export interface NeuroFoilPolarPoint {
  alpha: number;
  cl: number;
  cd: number;
  cm: number;
  ld: number;
  separationPct: number;
}

export interface NeuroFoilPrediction {
  airfoilName: string;
  reynolds: number;
  features: NeuroFoilFeatures;
  polar: NeuroFoilPolarPoint[];
  optimalAlpha: number;
  maxLd: number;
  stallAlpha: number;
  maxCl: number;
  zeroLiftAlpha: number;
  asReference: NeutralReferenceData;
}

export interface NeuroFoilLiveEvaluation {
  atAlpha: NeuroFoilPolarPoint;
  deltaCl: number | null;
  deltaCd: number | null;
  deltaLd: number | null;
  agreementPct: number | null;
  regime: "Pre-Stall Attached" | "Peak Efficiency Window" | "Near-Stall Transition" | "Post-Stall Separated";
  hint: string;
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-clamp(x, -20, 20)));

/**
 * Extracts a compact aerodynamic feature vector from Selig/Bezier airfoil coordinates.
 */
export function extractNeuroFoilFeatures(coords: number[][]): NeuroFoilFeatures {
  if (!coords || coords.length < 10) {
    return {
      camberPct: 0,
      camberX: 0.4,
      thicknessPct: 12,
      thickX: 0.3,
      leRadiusNorm: 0.015,
      teAngleDeg: 14,
      reflexPct: 0,
    };
  }

  try {
    const { shape } = BZ.fit(coords);
    const stats = BZ.stats(shape);
    const xg = BZ.cosGrid(101);
    const surf = BZ.surfaces(shape, xg);

    // Estimate leading-edge radius from thickness near x = 0.015 (t ~ sqrt(2 * rLE * x))
    let idxLe = 1;
    while (idxLe < xg.length - 1 && xg[idxLe] < 0.02) idxLe++;
    const xLe = Math.max(0.004, xg[idxLe]);
    const yHalf = Math.max(0.002, surf.t[idxLe] * 0.5);
    const leRadiusNorm = clamp((yHalf * yHalf) / (2 * xLe), 0.002, 0.06);

    // Estimate trailing-edge boat-tail included angle near x = 0.88..0.98
    let idxTe = xg.length - 1;
    while (idxTe > 1 && xg[idxTe] > 0.9) idxTe--;
    const dxTe = Math.max(0.02, 1 - xg[idxTe]);
    const dtTe = Math.max(0, surf.t[idxTe] - surf.t[xg.length - 1]);
    const teAngleDeg = clamp((2 * Math.atan2(dtTe * 0.5, dxTe) * 180) / Math.PI, 2, 35);

    // Measure aft reflex camber (camber curvature reversal near x = 0.75..0.95)
    let idxAft = 0;
    for (let i = 0; i < xg.length; i++) {
      if (xg[i] >= 0.82) {
        idxAft = i;
        break;
      }
    }
    const reflexPct = clamp(-surf.yc[idxAft] * 100, -5, 5);

    return {
      camberPct: Number(clamp(stats.camber * 100, -20, 20).toFixed(2)),
      camberX: Number(clamp(stats.camberX, 0.1, 0.85).toFixed(2)),
      thicknessPct: Number(clamp(stats.thick * 100, 1, 45).toFixed(2)),
      thickX: Number(clamp(stats.thickX, 0.12, 0.65).toFixed(2)),
      leRadiusNorm: Number(leRadiusNorm.toFixed(4)),
      teAngleDeg: Number(teAngleDeg.toFixed(1)),
      reflexPct: Number(reflexPct.toFixed(2)),
    };
  } catch {
    const ys = coords.map((p) => p[1]);
    const thicknessPct = ys.length ? clamp((Math.max(...ys) - Math.min(...ys)) * 100, 2, 40) : 12;
    return {
      camberPct: 0,
      camberX: 0.4,
      thicknessPct: Number(thicknessPct.toFixed(2)),
      thickX: 0.3,
      leRadiusNorm: 0.015,
      teAngleDeg: 14,
      reflexPct: 0,
    };
  }
}

/**
 * Physics-informed NeuroFoil surrogate predicting viscous polar across -8°..+20°.
 * Calibrated for incompressible 2D LBM Reynolds regimes (Re ~ 1,200 - 1,000,000).
 */
export function runNeuroFoilPrediction(
  airfoilName: string,
  coords: number[][],
  reynolds: number
): NeuroFoilPrediction {
  const features = extractNeuroFoilFeatures(coords);
  const re = clamp(reynolds || 2560, 500, 1_000_000);
  const logRe = Math.log10(re);

  const camber = features.camberPct / 100;
  const thick = features.thicknessPct / 100;

  // Thin-airfoil + viscous camber efficiency decay at low Re
  const reScale = clamp((logRe - 2.9) / 2.2, 0, 1);
  const zeroLiftAlpha = Number((-camber * (82 + 28 * reScale) * (0.7 + 0.6 * features.camberX)).toFixed(2));
  const liftSlopeDeg = (2 * Math.PI * (0.86 + 0.1 * reScale) * (1 + 0.55 * thick)) / (180 / Math.PI);

  // Stall onset increases with LE radius and Reynolds number, shifts slightly with camber
  const stallAlpha = Number(
    clamp(
      7.5 + 3.2 * reScale + 145 * features.leRadiusNorm + 18 * Math.max(0, camber) - 10 * Math.abs(thick - 0.12),
      6.5,
      19.5
    ).toFixed(1)
  );

  // Low-Re skin friction + pressure form drag baseline
  const cfBase = 0.088 / Math.pow(re, 0.22);
  const formFactor = 1 + 1.8 * thick + 45 * Math.pow(thick, 3.2);
  const cd0 = cfBase * formFactor + 0.008 * Math.abs(camber);

  const alphas = [-8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  const polar: NeuroFoilPolarPoint[] = alphas.map((alpha) => {
    const effDeg = alpha - zeroLiftAlpha;
    const stallDelta = Math.abs(alpha) - stallAlpha;
    const stallGate = sigmoid(stallDelta * 1.15);

    const clLinear = liftSlopeDeg * effDeg;
    const clPostStall = Math.sign(effDeg || 1) * (0.72 + 0.35 * Math.sin((Math.abs(alpha) * Math.PI) / 45));
    const cl = (1 - 0.62 * stallGate) * clLinear + 0.62 * stallGate * clPostStall;

    // Boundary-layer separation percentage rises sharply near/past stall
    const sepBase = 100 * sigmoid((Math.abs(alpha) - (stallAlpha - 1.2)) * 0.72);
    const tePenalty = Math.max(0, features.teAngleDeg - 16) * 0.6;
    const separationPct = Math.round(clamp(sepBase + tePenalty * sigmoid(Math.abs(alpha) - 4), 0, 96));

    // Induced/pressure drag + separation drag
    const cdViscous = cd0 * (1 + 0.0045 * effDeg * effDeg);
    const cdSep = (0.042 + 0.015 * thick) * Math.pow(Math.max(0, Math.abs(alpha) - (stallAlpha - 3)) / 5, 1.85);
    const cd = Math.max(0.008, cdViscous + 0.028 * cl * cl + cdSep);

    const ld = cd > 0.001 ? cl / cd : 0;
    const cm = -0.25 * camber * (1 - 0.35 * stallGate) - 0.012 * features.reflexPct;

    return {
      alpha,
      cl: Number(cl.toFixed(4)),
      cd: Number(cd.toFixed(4)),
      cm: Number(cm.toFixed(4)),
      ld: Number(ld.toFixed(3)),
      separationPct,
    };
  });

  // Search 0.5° grid for crisp peak L/D optimal AoA
  let optimalAlpha = 6;
  let maxLd = -Infinity;
  let maxCl = -Infinity;
  for (let a = -6; a <= 18; a += 0.5) {
    const pt = interpolateNeuroPolar(polar, a);
    if (pt.ld > maxLd) {
      maxLd = pt.ld;
      optimalAlpha = a;
    }
    if (pt.cl > maxCl) maxCl = pt.cl;
  }

  return {
    airfoilName,
    reynolds: re,
    features,
    polar,
    optimalAlpha: Number(optimalAlpha.toFixed(1)),
    maxLd: Number(maxLd.toFixed(2)),
    stallAlpha,
    maxCl: Number(maxCl.toFixed(3)),
    zeroLiftAlpha,
    asReference: {
      label: `NeuroFoil Surrogate (${airfoilName})`,
      sourceType: "airfoil",
      airfoilName: `NeuroFoil · ${airfoilName}`,
      rows: polar.map((p) => ({
        alpha: p.alpha,
        cl: p.cl,
        cd: p.cd,
        ld: p.ld,
        separationPct: p.separationPct,
      })),
    },
  };
}

export function interpolateNeuroPolar(polar: NeuroFoilPolarPoint[], alpha: number): NeuroFoilPolarPoint {
  if (!polar.length) {
    return { alpha, cl: 0, cd: 0.05, cm: 0, ld: 0, separationPct: 0 };
  }
  if (alpha <= polar[0].alpha) return polar[0];
  if (alpha >= polar[polar.length - 1].alpha) return polar[polar.length - 1];
  for (let i = 0; i < polar.length - 1; i++) {
    const a = polar[i];
    const b = polar[i + 1];
    if (alpha >= a.alpha && alpha <= b.alpha) {
      const t = (alpha - a.alpha) / (b.alpha - a.alpha || 1);
      const cl = a.cl + (b.cl - a.cl) * t;
      const cd = a.cd + (b.cd - a.cd) * t;
      const cm = a.cm + (b.cm - a.cm) * t;
      const separationPct = Math.round(a.separationPct + (b.separationPct - a.separationPct) * t);
      return {
        alpha,
        cl: Number(cl.toFixed(4)),
        cd: Number(cd.toFixed(4)),
        cm: Number(cm.toFixed(4)),
        ld: Number((cd > 0.001 ? cl / cd : 0).toFixed(3)),
        separationPct,
      };
    }
  }
  return polar[0];
}

export function evaluateLiveAgainstNeuroFoil(
  prediction: NeuroFoilPrediction,
  alpha: number,
  liveCl: number | null,
  liveCd: number | null
): NeuroFoilLiveEvaluation {
  const atAlpha = interpolateNeuroPolar(prediction.polar, alpha);
  const liveLd = liveCl !== null && liveCd !== null && liveCd > 0.001 ? liveCl / liveCd : null;

  const deltaCl = liveCl !== null ? liveCl - atAlpha.cl : null;
  const deltaCd = liveCd !== null ? liveCd - atAlpha.cd : null;
  const deltaLd = liveLd !== null ? liveLd - atAlpha.ld : null;

  let agreementPct: number | null = null;
  if (liveCl !== null && liveCd !== null) {
    const clErr = Math.abs(liveCl - atAlpha.cl) / Math.max(0.35, Math.abs(atAlpha.cl));
    const cdErr = Math.abs(liveCd - atAlpha.cd) / Math.max(0.03, Math.abs(atAlpha.cd));
    agreementPct = Math.round(clamp(100 * (1 - 0.55 * clErr - 0.45 * cdErr), 15, 99));
  }

  let regime: NeuroFoilLiveEvaluation["regime"] = "Pre-Stall Attached";
  let hint = `Peak L/D predicted near α* = ${prediction.optimalAlpha.toFixed(1)}°.`;

  if (Math.abs(alpha) >= prediction.stallAlpha) {
    regime = "Post-Stall Separated";
    hint = `Above predicted α_stall (${prediction.stallAlpha.toFixed(1)}°). Reduce incidence toward ${prediction.optimalAlpha.toFixed(1)}° to recover attached lift.`;
  } else if (Math.abs(alpha) >= prediction.stallAlpha - 2.5) {
    regime = "Near-Stall Transition";
    hint = `Approaching stall boundary (${prediction.stallAlpha.toFixed(1)}°). Upper-surface shear layer is thickening.`;
  } else if (Math.abs(alpha - prediction.optimalAlpha) <= 1.5) {
    regime = "Peak Efficiency Window";
    hint = `Operating inside NeuroFoil's optimal L/D band (${prediction.maxLd.toFixed(2)} est. peak).`;
  }

  return {
    atAlpha,
    deltaCl,
    deltaCd,
    deltaLd,
    agreementPct,
    regime,
    hint,
  };
}
