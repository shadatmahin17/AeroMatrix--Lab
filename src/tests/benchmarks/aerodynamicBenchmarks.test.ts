import { describe, expect, it } from 'vitest';
import { computeFlatPlateSkinFriction, computeISA } from '../../lib/aeroPhysics';
import { calculateAeroTelemetry } from '../../utils/airfoilGenerators';
import { computeBenchmarkDeviation } from '../../data/nacaBenchmarks';
import { evaluateLbmDiagnostics } from '../../lib/lbm/lbmDiagnostics';
import {
  buildEngineeringReportBundle,
  formatEngineeringReportMarkdown,
  generateEngineeringPdfBlob,
} from '../../utils/engineeringReport';
import type { SimulationParams } from '../../types/aerodynamics';

const TEST_PARAMS: SimulationParams = {
  modelType: 'naca2412',
  angle_of_attack: 4,
  airspeed_kts: 120,
  altitude_ft: 0,
  flaps_deg: 0,
  viscosity: 0.25,
  smoke_density: 0.8,
  show_streamlines: true,
  show_particles: true,
  show_heatmap: false,
  show_pressure_vectors: true,
  show_quiver: false,
  show_shockwaves: true,
  audio_enabled: false,
};

describe('Level 4 & 5: Aerodynamic Benchmarks, LBM Stability & 3-Tier Report Verification', () => {
  it('matches International Standard Atmosphere checkpoints at 0 m, 11 km, and 20 km', () => {
    const sea = computeISA(0);
    expect(sea.temperature_K).toBeCloseTo(288.15, 2);
    expect(sea.pressure_Pa).toBeCloseTo(101325, 0);
    expect(sea.density_kg_m3).toBeCloseTo(1.225, 3);

    const trop = computeISA(11000);
    expect(trop.temperature_K).toBeCloseTo(216.65, 2);
    expect(trop.pressure_Pa).toBeCloseTo(22632, -1);

    const strat = computeISA(20000);
    expect(strat.temperature_K).toBeCloseTo(216.65, 2);
    expect(strat.density_kg_m3).toBeCloseTo(0.0880, 3);
  });

  it('validates NACA 2412 polar against NACA TR-824 experimental data within attached RMSE tolerance', () => {
    const telemetry = calculateAeroTelemetry('naca2412', 4, 120, 0, 0);
    const sweep = [];
    for (let a = -8; a <= 14; a += 2) {
      const pt = calculateAeroTelemetry('naca2412', a, 120, 0, 0);
      sweep.push({ aoa: a, cl: pt.cl, cd: pt.cd });
    }
    const dev = computeBenchmarkDeviation('naca2412', telemetry, 4, sweep);
    expect(dev).not.toBeNull();
    expect(dev!.rmseClAttached).toBeLessThan(0.25);
    expect(dev!.rmseCdAttached).toBeLessThan(0.025);
  });

  it('validates Blasius and Schlichting flat-plate skin friction reference equations', () => {
    const re = 1_000_000;
    const cf = computeFlatPlateSkinFriction(re);
    expect(cf.laminarMeanCf).toBeCloseTo(1.328 / Math.sqrt(re), 8);
    expect(cf.turbulentMeanCf).toBeCloseTo(0.074 / Math.pow(re, 0.2), 8);
  });

  it('flags D2Q9 LBM incompressible Mach limit and BGK tau0 stability violations', () => {
    const unstable = evaluateLbmDiagnostics({ u0: 0.2, tau0: 0.502, nx: 640, ny: 320 });
    expect(unstable.machValid).toBe(false); // 0.2 * sqrt(3) = 0.346 > 0.30
    expect(unstable.bgkStable).toBe(false); // 0.502 <= 0.505
    expect(unstable.validationStatus).toBe('failed');
    expect(unstable.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('separates Numerical Verification, Model Validation, and Operating Applicability in reports & PDFs', async () => {
    const telemetry = calculateAeroTelemetry('naca2412', 4, 120, 0, 0);
    const bundle = buildEngineeringReportBundle('naca2412', TEST_PARAMS, telemetry);

    expect(bundle.verificationDistinction.numericalVerification.status).toBe('verified');
    expect(bundle.verificationDistinction.modelValidation.status).toBe('verified');
    expect(bundle.verificationDistinction.operatingApplicability.status).toBe('within-envelope');
    expect(bundle.reproducibility.geometryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.reproducibility.inputHash).toMatch(/^[0-9a-f]{16}$/);

    const md = formatEngineeringReportMarkdown(bundle);
    expect(md).toContain('Numerical Verification');
    expect(md).toContain('Model Validation');
    expect(md).toContain('Operating Applicability');
    expect(md).toContain(bundle.reproducibility.inputHash);

    const pdf = generateEngineeringPdfBlob('naca2412', TEST_PARAMS, telemetry);
    expect(pdf.blob.size).toBeGreaterThan(2000);
    const header = new TextDecoder().decode(new Uint8Array(await pdf.blob.slice(0, 5).arrayBuffer()));
    expect(header).toBe('%PDF-');
  });
});
