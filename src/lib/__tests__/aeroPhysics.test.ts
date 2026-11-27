import { describe, expect, it } from 'vitest';
import {
  alphaSweep,
  applyPrandtlGlauertCp,
  clampCpForColorMap,
  computeDimensionlessAndGuardrails,
  computeFiniteWingAerodynamics,
  computeFlatPlateSkinFriction,
  computeISA,
  computePrandtlGlauert,
  computeRawCp,
  computeTotalDrag,
  ISA_CONSTANTS,
} from '../aeroPhysics';
import {
  AIRCRAFT_MODELS,
  calculateAeroTelemetry,
  computeBenchmarkMatchConditions,
  getNominalPresetState,
  solveAeroStateSI,
} from '../../utils/airfoilGenerators';
import {
  buildEngineeringReportBundle,
  formatEngineeringReportMarkdown,
  generateEngineeringPdfBlob,
} from '../../utils/engineeringReport';
import type { SimulationParams } from '../../types/aerodynamics';

describe('International Standard Atmosphere (ISA, 0–20,000 m)', () => {
  it('computes exact sea-level (h = 0 m) properties', () => {
    const isa = computeISA(0);
    expect(isa.temperature_K).toBeCloseTo(288.15, 6);
    expect(isa.pressure_Pa).toBeCloseTo(101325, 2);
    expect(isa.density_kg_m3).toBeCloseTo(1.225, 3);
    expect(isa.speedOfSound_ms).toBeCloseTo(340.294, 2);
    expect(isa.dynamicViscosity_Pa_s).toBeCloseTo(1.7894e-5, 8);
  });

  it('computes tropopause (h = 11,000 m) properties accurately', () => {
    const isa = computeISA(11_000);
    expect(isa.temperature_K).toBeCloseTo(216.65, 4);
    expect(isa.pressure_Pa).toBeCloseTo(22632.65, 1);
    expect(isa.density_kg_m3).toBeCloseTo(0.363918, 4);
    expect(isa.speedOfSound_ms).toBeCloseTo(295.07, 2);
    expect(isa.dynamicViscosity_Pa_s).toBeCloseTo(1.4216e-5, 8);
  });

  it('computes isothermal lower stratosphere (h = 20,000 m) properties accurately', () => {
    const isa = computeISA(20_000);
    expect(isa.temperature_K).toBeCloseTo(216.65, 4);
    expect(isa.pressure_Pa).toBeCloseTo(5475.1, 0);
    expect(isa.density_kg_m3).toBeCloseTo(0.088035, 4);
    expect(isa.speedOfSound_ms).toBeCloseTo(295.07, 2);
  });

  it('throws RangeError for negative, > 20,000 m, NaN, or Infinity altitudes', () => {
    expect(() => computeISA(-1)).toThrow(RangeError);
    expect(() => computeISA(20_001)).toThrow(RangeError);
    expect(() => computeISA(Number.NaN)).toThrow(RangeError);
    expect(() => computeISA(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('Dimensionless Parameters & Regime Guardrails', () => {
  it('computes exact q_inf, Re, M_inf, Kn, continuum validity, and Reynolds indicator', () => {
    const isa = computeISA(0);
    const velocity_ms = 51.04; // M ≈ 0.15 at sea level
    const chord_m = 1.5;

    const res = computeDimensionlessAndGuardrails({
      density_kg_m3: isa.density_kg_m3,
      dynamicViscosity_Pa_s: isa.dynamicViscosity_Pa_s,
      speedOfSound_ms: isa.speedOfSound_ms,
      velocity_ms,
      chord_m,
    });

    const expectedQ = 0.5 * isa.density_kg_m3 * velocity_ms * velocity_ms;
    const expectedRe = (isa.density_kg_m3 * velocity_ms * chord_m) / isa.dynamicViscosity_Pa_s;
    const expectedM = velocity_ms / isa.speedOfSound_ms;
    const expectedKn = (expectedM / expectedRe) * Math.sqrt((ISA_CONSTANTS.GAMMA * Math.PI) / 2);

    expect(res.dynamicPressure_Pa).toBeCloseTo(expectedQ, 6);
    expect(res.reynolds).toBeCloseTo(expectedRe, 2);
    expect(res.mach).toBeCloseTo(expectedM, 6);
    expect(res.knudsen).toBeCloseTo(expectedKn, 10);
    expect(res.continuumValid).toBe(true);
    expect(res.compressibilityRegime).toBe('incompressible');
    expect(res.reynoldsRegime).toBe('turbulent-dominated');
    expect(res.reynoldsRegimeLabel).toContain('not a solved transition');
  });

  it('flags non-continuum Kn > 0.01 at ultra-low Re / high Mach', () => {
    const res = computeDimensionlessAndGuardrails({
      density_kg_m3: 0.0001,
      dynamicViscosity_Pa_s: 1.789e-5,
      speedOfSound_ms: 295,
      velocity_ms: 150,
      chord_m: 0.01,
    });
    expect(res.knudsen).toBeGreaterThan(0.01);
    expect(res.continuumValid).toBe(false);
    expect(res.regimeWarnings.some((w) => w.code === 'KNUDSEN_NON_CONTINUUM')).toBe(true);
  });

  it('throws RangeError on invalid physical inputs', () => {
    expect(() =>
      computeDimensionlessAndGuardrails({
        density_kg_m3: 0,
        dynamicViscosity_Pa_s: 1.8e-5,
        speedOfSound_ms: 340,
        velocity_ms: 50,
        chord_m: 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      computeDimensionlessAndGuardrails({
        density_kg_m3: 1.225,
        dynamicViscosity_Pa_s: -1,
        speedOfSound_ms: 340,
        velocity_ms: 50,
        chord_m: 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      computeDimensionlessAndGuardrails({
        density_kg_m3: 1.225,
        dynamicViscosity_Pa_s: 1.8e-5,
        speedOfSound_ms: 340,
        velocity_ms: -5,
        chord_m: 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      computeDimensionlessAndGuardrails({
        density_kg_m3: 1.225,
        dynamicViscosity_Pa_s: 1.8e-5,
        speedOfSound_ms: 340,
        velocity_ms: 50,
        chord_m: Number.NaN,
      })
    ).toThrow(RangeError);
  });
});

describe('Prandtl–Glauert Compressibility & Raw vs Clamped Cp', () => {
  it('applies exact 1/sqrt(1-M^2) scaling at M = 0.585 and falls back to 1.0 at M <= 0.3', () => {
    const low = computePrandtlGlauert(0.25);
    expect(low.regime).toBe('incompressible');
    expect(low.factor).toBe(1.0);
    expect(applyPrandtlGlauertCp(-1.2, 0.25)).toBeCloseTo(-1.2, 6);

    const mid = computePrandtlGlauert(0.585);
    const expectedFactor = 1 / Math.sqrt(1 - 0.585 * 0.585); // ≈ 1.23299
    expect(mid.regime).toBe('prandtl-glauert');
    expect(mid.factor).toBeCloseTo(expectedFactor, 5);
    expect(mid.factor).toBeCloseTo(1.233, 3);
    expect(applyPrandtlGlauertCp(-1.0, 0.585)).toBeCloseTo(-expectedFactor, 5);

    const high = computePrandtlGlauert(0.82);
    expect(high.regime).toBe('transonic-limit');
  });

  it('keeps raw physical Cp unclamped while color-map clamping isolates [-3.5, 1.0]', () => {
    const rawCp = computeRawCp(3.0, 1.0); // 1 - 9 = -8.0
    expect(rawCp).toBe(-8.0);
    const pgCp = applyPrandtlGlauertCp(rawCp, 0.585);
    expect(pgCp).toBeLessThan(-9.5);
    expect(clampCpForColorMap(pgCp)).toBe(-3.5);
    expect(clampCpForColorMap(1.4)).toBe(1.0);
  });
});

describe('Finite-Wing Lifting-Line, Exact Drag Sum, Presets & Flat-Plate Cf', () => {
  it('computes exact induced AoA, downwash epsilon = 2*alpha_i, CDi, and circulation distinction', () => {
    const res = computeFiniteWingAerodynamics({
      wingspan_m: 10,
      chord_m: 1.5,
      oswaldEfficiency: 0.82,
      cl: 0.8,
      velocity_ms: 60,
      density_kg_m3: 1.225,
    });

    const ar = 10 / 1.5;
    const expectedAlphaRad = 0.8 / (Math.PI * 0.82 * ar);
    expect(res.aspectRatio).toBeCloseTo(ar, 6);
    expect(res.inducedAlpha_rad).toBeCloseTo(expectedAlphaRad, 8);
    expect(res.downwashAngle_rad).toBeCloseTo(2 * expectedAlphaRad, 8);
    expect(res.downwashAngle_deg).toBeCloseTo(2 * res.inducedAlpha_deg, 8);
    expect(res.cdi).toBeCloseTo((0.8 * 0.8) / (Math.PI * 0.82 * ar), 8);
    expect(res.equivalentCirculation_m2_s).toBeCloseTo(0.5 * 60 * 1.5 * 0.8, 6);
    expect(res.ellipticRootCirculation_m2_s).toBeCloseTo((2 / Math.PI) * 60 * 1.5 * 0.8, 6);
  });

  it('uses exact preset cd0 (0.007 for NACA 0012, 0.008 for NACA 2412) and exact drag sum', () => {
    const t0012 = calculateAeroTelemetry('naca0012', 4, 150, 0, 0);
    expect(t0012.cd0).toBe(AIRCRAFT_MODELS.naca0012.cd0);
    expect(t0012.cd0).toBe(0.007);
    expect(t0012.cd).toBeCloseTo(t0012.cd0 + t0012.cdi + t0012.cdSep + t0012.cdWave, 4);

    const t2412 = calculateAeroTelemetry('naca2412', 4, 150, 0, 0);
    expect(t2412.cd0).toBe(AIRCRAFT_MODELS.naca2412.cd0);
    expect(t2412.cd0).toBe(0.008);
    expect(t2412.cd).toBeCloseTo(t2412.cd0 + t2412.cdi + t2412.cdSep + t2412.cdWave, 4);

    expect(computeTotalDrag({ cd0: 0.008, cdi: 0.012, cdSep: 0.004, cdWave: 0.001 })).toBeCloseTo(0.025, 8);
  });

  it('distinguishes local Cf(x) from plate-averaged Cf_bar in flat-plate skin friction', () => {
    const cf = computeFlatPlateSkinFriction(3_000_000, 1_500_000);
    expect(cf.isEmpiricalReference).toBe(true);
    expect(cf.laminarLocalCf).toBeCloseTo(0.664 / Math.sqrt(1_500_000), 8);
    expect(cf.laminarMeanCf).toBeCloseTo(1.328 / Math.sqrt(3_000_000), 8);
    expect(cf.turbulentLocalCf).toBeCloseTo(0.0592 / Math.pow(1_500_000, 0.2), 8);
    expect(cf.turbulentMeanCf).toBeCloseTo(0.074 / Math.pow(3_000_000, 0.2), 8);
  });

  it('solves matched Wind-Tunnel Benchmark Mode conditions (Re ≈ 3.0×10^6, M ≈ 0.15)', () => {
    const m0012 = computeBenchmarkMatchConditions('naca0012', 3_000_000, 0.15);
    expect(m0012.actualRe).toBeGreaterThan(2_950_000);
    expect(m0012.actualRe).toBeLessThan(3_050_000);
    expect(m0012.actualMach).toBeCloseTo(0.15, 2);

    const m2412 = computeBenchmarkMatchConditions('naca2412', 3_000_000, 0.15);
    expect(m2412.actualRe).toBeGreaterThan(2_950_000);
    expect(m2412.actualRe).toBeLessThan(3_050_000);
    expect(m2412.actualMach).toBeCloseTo(0.15, 2);
  });

  it('generates a valid binary PDF engineering report Blob via jsPDF', async () => {
    const params: SimulationParams = {
      modelType: 'naca0012',
      angle_of_attack: 5,
      airspeed_kts: 150,
      altitude_ft: 5000,
      flaps_deg: 0,
      viscosity: 0.00018,
      smoke_density: 0.8,
      show_streamlines: true,
      show_particles: true,
      show_heatmap: true,
      show_pressure_vectors: true,
      show_quiver: false,
      show_shockwaves: false,
      audio_enabled: false,
    };
    const telemetry = calculateAeroTelemetry('naca0012', 5, 150, 5000, 0);
    const { blob, fileName } = generateEngineeringPdfBlob('naca0012', params, telemetry);

    expect(fileName).toBe('aeromatrix_report_naca0012_aoa5.0deg.pdf');
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(1500);
    const header = await blob.slice(0, 5).text();
    expect(header).toBe('%PDF-');
  });

  it('validates Rectangular Validation Wing (AR = 6), F-22 nominal load factor, and modelValidity guardrails', () => {
    const valModel = AIRCRAFT_MODELS.validation_wing;
    expect(valModel.wingspan).toBe(9.0);
    expect(valModel.chord).toBe(1.5);
    expect(valModel.oswaldEfficiency).toBe(0.95);

    const valNom = getNominalPresetState('validation_wing');
    const valTel = calculateAeroTelemetry(
      'validation_wing',
      valNom.angle_of_attack,
      valNom.airspeed_kts,
      valNom.altitude_ft,
      valNom.flaps_deg
    );
    expect(valTel.aspectRatio).toBeCloseTo(6.0, 4);
    expect(valTel.cdi).toBeCloseTo((valTel.cl * valTel.cl) / (Math.PI * 0.95 * 6.0), 3);
    expect(valTel.modelValidity?.isValid).toBe(true);

    const f22Nom = getNominalPresetState('f22');
    const f22Tel = calculateAeroTelemetry(
      'f22',
      f22Nom.angle_of_attack,
      f22Nom.airspeed_kts,
      f22Nom.altitude_ft,
      f22Nom.flaps_deg
    );
    expect(f22Tel.loadFactor_nz).toBeDefined();
    expect(f22Tel.loadFactor_nz!).toBeGreaterThan(0.5);
    expect(f22Tel.loadFactor_nz!).toBeLessThan(3.0);
    expect(f22Tel.modelValidity?.isValid).toBe(true);

    // Transonic/Supersonic & stalled regimes trigger out-of-envelope modelValidity
    const concordeFast = calculateAeroTelemetry('concorde', 3, 1050, 45000, 0);
    expect(concordeFast.mach).toBeGreaterThan(0.7);
    expect(concordeFast.modelValidity?.isValid).toBe(false);

    const stalledFoil = calculateAeroTelemetry('naca0012', 20, 150, 0, 0);
    expect(stalledFoil.isStalled).toBe(true);
    expect(stalledFoil.modelValidity?.isValid).toBe(false);
  });
});

function expectWithinRelTolerance(actual: number, expected: number, relTol = 0.001): void {
  const relErr = Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected));
  expect(relErr).toBeLessThanOrEqual(relTol);
}

describe('F-22 Acceptance Test & 4-Page PDF Report Verification', () => {
  it('matches all F-22 reference SI operating point values within ±0.1% at α = 5°, V = 180.06 m/s, h = 3000.1 m', () => {
    const { telemetry } = solveAeroStateSI('f22', 5.0, 180.06, 3000.1, 0);
    const raw = telemetry.rawSI!;
    expect(raw).toBeDefined();

    // ISA state
    expectWithinRelTolerance(raw.temperature_K, 268.65, 0.001);
    expectWithinRelTolerance(raw.pressure_Pa, 70108, 0.001);
    expectWithinRelTolerance(raw.density_kg_m3, 0.9091, 0.001);
    expectWithinRelTolerance(raw.dynamicViscosity_Pa_s, 1.6937e-5, 0.001);
    expectWithinRelTolerance(raw.speedOfSound_ms, 328.58, 0.001);

    // Dimensionless parameters & planform geometry
    expectWithinRelTolerance(raw.dynamicPressure_Pa, 14737, 0.001);
    expectWithinRelTolerance(raw.mach, 0.548, 0.001);
    expectWithinRelTolerance(raw.prandtlGlauertFactor, 1.195, 0.001);
    expectWithinRelTolerance(raw.reynolds, 5.562e7, 0.001);
    expectWithinRelTolerance(raw.knudsen, 1.461e-8, 0.001);
    expectWithinRelTolerance(raw.aspectRatio, 2.36, 0.002); // 13.56^2 / 78.04 = 2.356145
    expectWithinRelTolerance(raw.meanChord_m, 5.76, 0.0015); // 78.04 / 13.56 = 5.755162

    // Helmbold/Raymer lift, induced drag, forces, circulation & flat-plate CD,f
    expectWithinRelTolerance(raw.clAlpha_per_rad, 2.837, 0.001);
    expectWithinRelTolerance(raw.cl, 0.248, 0.002); // 2.837 * (5*pi/180) = 0.2476
    expectWithinRelTolerance((raw.inducedAlpha_rad * 180) / Math.PI, 2.52, 0.002);
    expectWithinRelTolerance((raw.downwashAngle_rad * 180) / Math.PI, 5.04, 0.002);
    expectWithinRelTolerance(raw.cdi, 0.0109, 0.002);
    expectWithinRelTolerance(raw.cdTotal, 0.0299, 0.001);
    expectWithinRelTolerance(raw.lift_N, 284761, 0.001);
    expectWithinRelTolerance(raw.drag_N, 34385, 0.001);
    expectWithinRelTolerance(raw.ldRatio, 8.28, 0.001);
    expectWithinRelTolerance(telemetry.equivalentCirculation_m2_s, 128.29, 0.001);
    expectWithinRelTolerance(telemetry.ellipticRootCirculation_m2_s, 163.34, 0.001);
    expectWithinRelTolerance(telemetry.skinFrictionDrag_cdf, 0.00418, 0.001);
  });

  it('produces an attached 0°–15° alphaSweep (step 0.2°) consistent with F-22 telemetry at 5.0°', () => {
    const sweep = alphaSweep({
      modelType: 'f22',
      velocity_ms: 180.06,
      altitude_m: 3000.1,
    });
    expect(sweep.alphaDeg.length).toBe(76);
    expect(sweep.alphaDeg[0]).toBe(0);
    expect(sweep.alphaDeg[sweep.alphaDeg.length - 1]).toBe(15);

    const pt5 = sweep.points.find((p) => Math.abs(p.alphaDeg - 5.0) < 1e-6);
    expect(pt5).toBeDefined();
    expectWithinRelTolerance(pt5!.cl, 0.248, 0.002);
    expectWithinRelTolerance(pt5!.cd, 0.0299, 0.001);
    expectWithinRelTolerance(pt5!.cdi, 0.0109, 0.002);
    expectWithinRelTolerance(pt5!.ldRatio, 8.28, 0.001);
  });

  it('exports an exact 4-page F-22 PDF with verified <1e-9 residuals, <0.1% Cp quadrature, and clean wording', async () => {
    const airspeedKts = 180.06 / ISA_CONSTANTS.KTS_TO_MS;
    const altitudeFt = 3000.1 / ISA_CONSTANTS.FT_TO_M;
    const params: SimulationParams = {
      modelType: 'f22',
      angle_of_attack: 5.0,
      airspeed_kts: airspeedKts,
      altitude_ft: altitudeFt,
      flaps_deg: 0,
      viscosity: 0.25,
      smoke_density: 0.8,
      show_streamlines: true,
      show_particles: true,
      show_heatmap: false,
      show_pressure_vectors: true,
      show_quiver: false,
      show_shockwaves: false,
      audio_enabled: false,
    };
    const { telemetry } = solveAeroStateSI('f22', 5.0, 180.06, 3000.1, 0);
    const { blob, fileName, bundle } = generateEngineeringPdfBlob('f22', params, telemetry);

    expect(fileName).toBe('aeromatrix_report_f22_aoa5.0deg.pdf');
    expect(bundle.model.name).toBe('F-22 Raptor (Fighter)');
    expect(bundle.verificationDistinction.numericalVerification.status).toBe('verified');
    expect(bundle.verificationDistinction.numericalVerification.quadraturePassed).toBe(true);
    expect(bundle.verificationDistinction.numericalVerification.quadratureRelErrorPct).toBeLessThan(0.1);
    for (const check of bundle.verificationDistinction.numericalVerification.residuals) {
      expect(check.passed).toBe(true);
      expect(check.residual).toBeLessThan(1e-9);
    }
    expect(bundle.verificationDistinction.modelValidation.status).toBe('empirical-only');
    expect(bundle.verificationDistinction.operatingApplicability.status).toBe('within-envelope');
    expect(bundle.reproducibility.logoAssetPath).toBe('/public/logo-white-pdf.png');

    const md = formatEngineeringReportMarkdown(bundle);
    expect(md).not.toContain('80/20');
    expect(md).not.toContain('Kutta Residual');
    expect(md).not.toContain('REFERENCE LAYOUT');
    expect(md).not.toContain('Annex A');
    expect(md).not.toContain('(Fighter) (Fighter)');
    expect(md).toContain('Re > 3×10⁵');

    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const pdfAscii = new TextDecoder('latin1').decode(pdfBytes);
    expect(pdfAscii.startsWith('%PDF-')).toBe(true);
    // jsPDF writes /Count 4 in the root /Pages dictionary; verify exact 4-page layout
    expect(pdfAscii).toMatch(/\/Type\s*\/Pages[\s\S]*?\/Count\s+4\b/);
    expect(pdfAscii).not.toContain('REFERENCE LAYOUT');
    expect(pdfAscii).not.toContain('Annex A');

    // Also verify buildEngineeringReportBundle works equivalently
    const bundleCheck = buildEngineeringReportBundle('f22', params, telemetry);
    expect(bundleCheck.verificationDistinction.numericalVerification.status).toBe('verified');
  });
});

