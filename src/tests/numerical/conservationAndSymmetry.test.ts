import { describe, expect, it } from 'vitest';
import {
  applyPrandtlGlauertCp,
  computeFiniteWingAerodynamics,
  computeTotalDrag,
} from '../../lib/aeroPhysics';
import { calculateAeroTelemetry, AIRCRAFT_MODELS } from '../../utils/airfoilGenerators';
import { evaluateBiotSavartSegment } from '../../engine/FluidDynamics3D';
import { deriveFlowConditions } from '../../simulation/contracts/ScientificContracts';

describe('Level 2: Numerical Conservation, Symmetry & Dimensional Consistency', () => {
  it('enforces exact +/- AoA lift antisymmetry and drag symmetry on symmetric NACA 0012', () => {
    const pos = calculateAeroTelemetry('naca0012', 6, 150, 0, 0);
    const neg = calculateAeroTelemetry('naca0012', -6, 150, 0, 0);
    expect(pos.cl).toBeGreaterThan(0.2);
    expect(neg.cl).toBeCloseTo(-pos.cl, 3);
    expect(neg.cd).toBeCloseTo(pos.cd, 4);
    expect(neg.cdi).toBeCloseTo(pos.cdi, 5);
  });

  it('satisfies Prandtl-Glauert factor 1/sqrt(1 - M^2) in subsonic compressible regime', () => {
    const cp0 = -0.8;
    const mach = 0.6;
    const expected = cp0 / Math.sqrt(1 - mach * mach); // -0.8 / 0.8 = -1.0
    expect(applyPrandtlGlauertCp(cp0, mach)).toBeCloseTo(expected, 8);
    expect(applyPrandtlGlauertCp(cp0, 0.2)).toBeCloseTo(cp0, 8);
  });

  it('satisfies Prandtl lifting-line identities (CDi = CL^2/(pi*e*AR), eps = 2*alpha_i) and exact drag sum', () => {
    const res = computeFiniteWingAerodynamics({
      wingspan_m: 12,
      chord_m: 2,
      oswaldEfficiency: 0.95,
      cl: 0.55,
      velocity_ms: 80,
      density_kg_m3: 1.225,
    });
    expect(res.aspectRatio).toBeCloseTo(6.0, 6);
    expect(res.downwashAngle_deg).toBeCloseTo(2 * res.inducedAlpha_deg, 8);
    expect(res.cdi).toBeCloseTo((0.55 * 0.55) / (Math.PI * 0.95 * 6.0), 8);

    const totalCd = computeTotalDrag({ cd0: 0.012, cdi: res.cdi, cdSep: 0.002, cdWave: 0.0 });
    expect(totalCd).toBeCloseTo(0.012 + res.cdi + 0.002, 10);
  });

  it('derives single-source-of-truth FlowConditions consistently with aeroPhysics.ts', () => {
    const cfg = AIRCRAFT_MODELS.validation_wing;
    const flow = deriveFlowConditions({
      altitude_m: 3000,
      velocity_ms: 150,
      chord_m: cfg.chord,
      angleOfAttackDeg: 5,
    });
    expect(flow.reynolds).toBeCloseTo((flow.density * flow.velocity * flow.chord) / flow.dynamicViscosity, 6);
    expect(flow.mach).toBeCloseTo(flow.velocity / flow.speedOfSound, 8);
    expect(flow.dynamicPressure).toBeCloseTo(0.5 * flow.density * flow.velocity * flow.velocity, 6);
  });

  it('maintains Biot-Savart segment directional reversal and regularizes at zero distance', () => {
    const fwd = evaluateBiotSavartSegment({
      point: { x: 0, y: 1.2, z: 0 },
      start: { x: 0, y: 0, z: -3 },
      end: { x: 0, y: 0, z: 3 },
      gamma: 4.0,
      coreRadius: 0.2,
    });
    const rev = evaluateBiotSavartSegment({
      point: { x: 0, y: 1.2, z: 0 },
      start: { x: 0, y: 0, z: 3 },
      end: { x: 0, y: 0, z: -3 },
      gamma: 4.0,
      coreRadius: 0.2,
    });
    expect(fwd.u).toBeCloseTo(-rev.u, 8);
    expect(fwd.v).toBeCloseTo(-rev.v, 8);
    expect(fwd.w).toBeCloseTo(-rev.w, 8);

    const singular = evaluateBiotSavartSegment({
      point: { x: 0, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -3 },
      end: { x: 0, y: 0, z: 3 },
      gamma: 4.0,
      coreRadius: 0.25,
    });
    expect(Number.isFinite(singular.speed)).toBe(true);
    expect(singular.speed).toBeLessThan(1e-6);
  });
});
