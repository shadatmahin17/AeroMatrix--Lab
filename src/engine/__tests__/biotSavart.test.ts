import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { evaluateBiotSavartSegment, FluidDynamics3D, SOLVER_METADATA_3D } from '../FluidDynamics3D';
import { AircraftSurfaceField } from '../AircraftSurfaceField';
import { getAircraft3DModel } from '../../utils/aircraft3DGeometry';
import { createAeroForceVectorsGroup, updateAeroForceVectors } from '../../utils/aircraftGlbModels';

describe('Biot–Savart Vortex Filament Kernel', () => {
  it('follows the right-hand rule for a spanwise bound vortex segment along +Z', () => {
    // Filament along Z from (0,0,-1) to (0,0,1) with positive circulation gamma > 0.
    // Downstream (+X) of the filament: dl = (0,0,2), r1 = (2,0,1) => dl x r1 = (-2*0, 2*2, 0) => +Y (upwash/downwash depending on sign convention).
    const downstream = evaluateBiotSavartSegment({
      point: { x: 2, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -1 },
      end: { x: 0, y: 0, z: 1 },
      gamma: 4,
      coreRadius: 0.1,
    });

    const upstream = evaluateBiotSavartSegment({
      point: { x: -2, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -1 },
      end: { x: 0, y: 0, z: 1 },
      gamma: 4,
      coreRadius: 0.1,
    });

    expect(downstream.u).toBeCloseTo(0, 6);
    expect(downstream.w).toBeCloseTo(0, 6);
    expect(downstream.v).toBeGreaterThan(0);
    expect(upstream.v).toBeCloseTo(-downstream.v, 6);

    // Reversing circulation reverses induced velocity direction
    const reversed = evaluateBiotSavartSegment({
      point: { x: 2, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -1 },
      end: { x: 0, y: 0, z: 1 },
      gamma: -4,
      coreRadius: 0.1,
    });
    expect(reversed.v).toBeCloseTo(-downstream.v, 6);
  });

  it('regularizes the 1/r singularity cleanly at r = 0 (midpoint & endpoints) without NaN/Infinity', () => {
    const atMidpoint = evaluateBiotSavartSegment({
      point: { x: 0, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -2 },
      end: { x: 0, y: 0, z: 2 },
      gamma: 10,
      coreRadius: 0.25,
    });
    expect(Number.isFinite(atMidpoint.speed)).toBe(true);
    expect(atMidpoint.speed).toBe(0);

    const nearCore = evaluateBiotSavartSegment({
      point: { x: 1e-6, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -2 },
      end: { x: 0, y: 0, z: 2 },
      gamma: 10,
      coreRadius: 0.25,
    });
    expect(Number.isFinite(nearCore.speed)).toBe(true);
    expect(nearCore.speed).toBeLessThan(0.1);

    const atEndpoint = evaluateBiotSavartSegment({
      point: { x: 0, y: 0, z: -2 },
      start: { x: 0, y: 0, z: -2 },
      end: { x: 0, y: 0, z: 2 },
      gamma: 10,
      coreRadius: 0.25,
    });
    expect(Number.isFinite(atEndpoint.speed)).toBe(true);
    expect(atEndpoint.speed).toBe(0);
  });

  it('decays as 1/r^2 in the far field (r >> filament length)', () => {
    const rNear = 20;
    const rFar = 40; // 2x distance => ~1/4x induced speed
    const v1 = evaluateBiotSavartSegment({
      point: { x: rNear, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -1 },
      end: { x: 0, y: 0, z: 1 },
      gamma: 8,
      coreRadius: 0.1,
    });
    const v2 = evaluateBiotSavartSegment({
      point: { x: rFar, y: 0, z: 0 },
      start: { x: 0, y: 0, z: -1 },
      end: { x: 0, y: 0, z: 1 },
      gamma: 8,
      coreRadius: 0.1,
    });

    const ratio = v1.speed / v2.speed;
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.1);
  });

  it('exposes explicit reduced-order solver metadata (not Navier-Stokes RANS/LES)', () => {
    expect(SOLVER_METADATA_3D.isNavierStokes).toBe(false);
    expect(SOLVER_METADATA_3D.vortexPanelCount).toBe(6);
    expect(FluidDynamics3D.SOLVER_MODEL).toContain('Reduced-Order');
  });

  it('keeps SDF watertight inside thick extruded airfoil wings and prevents streamline nose penetration', () => {
    const baseAirfoil = getAircraft3DModel('naca2412', 0, 0, 250, 0);
    // Scale vertically to mimic thick Airfoil Section 3D CAD geometry with high-aspect span triangles
    const thickAirfoil = {
      ...baseAirfoil,
      vertices: baseAirfoil.vertices.map((v) => ({ x: v.x * 1.4, y: v.y * 2.6, z: v.z * 1.1 })),
    };
    const sf = AircraftSurfaceField.fromProceduralMesh(thickAirfoil);
    expect(sf).not.toBeNull();

    const sample = { dist: 0, nx: 0, ny: 1, nz: 0, inside: false };
    // Interior core of the thick airfoil near quarter-chord must remain strictly inside (dist < 0)
    expect(sf!.sample(0, 0, 0, sample)).toBe(true);
    expect(sample.dist).toBeLessThan(0);

    const fluidParams = {
      modelType: 'naca2412' as const,
      aoaDeg: 0,
      airspeed_kts: 250,
      mach: 0.38,
      altitude_ft: 5000,
      flapsDeg: 0,
      viscosity: 0.1,
      isStalled: false,
      cl: 0.25,
      cd: 0.015,
      surfaceField: sf,
    };

    for (const ySeed of [-0.35, -0.1, 0.0, 0.1, 0.35]) {
      const pts = FluidDynamics3D.traceStreamline({ x: -12, y: ySeed, z: 0 }, fluidParams, 120, 0.21);
      expect(pts.length).toBeGreaterThan(15);
      for (const pt of pts) {
        expect(FluidDynamics3D.isInsideSolid(pt, fluidParams, 0.05)).toBe(false);
      }
    }
  });

  it('hides zero-lift arrow, inverts negative lift, and scales 3D force arrows proportionally', () => {
    const group = createAeroForceVectorsGroup();
    const liftArrow = group.getObjectByName('liftArrow') as THREE.ArrowHelper;
    const dragArrow = group.getObjectByName('dragArrow') as THREE.ArrowHelper;
    const resultantArrow = group.getObjectByName('resultantArrow') as THREE.ArrowHelper;

    // 1. Symmetric NACA 0012 at AoA = 0 (L = 0, D = 200 N)
    updateAeroForceVectors(group, 0, 200, 0, true, { cl: 0, cd: 0.007 });
    expect(liftArrow.visible).toBe(false);
    expect(resultantArrow.visible).toBe(false);
    expect(dragArrow.visible).toBe(true);

    // 2. Positive lift: check proportional growth when force increases
    updateAeroForceVectors(group, 20000, 2000, 5, true, { cl: 0.5, cd: 0.05 });
    expect(liftArrow.visible).toBe(true);
    expect(resultantArrow.visible).toBe(true);
    const lowLiftY = liftArrow.cone.position.y;

    updateAeroForceVectors(group, 180000, 12000, 10, true, { cl: 1.0, cd: 0.07 });
    const highLiftY = liftArrow.cone.position.y;
    expect(highLiftY).toBeGreaterThan(lowLiftY);

    // 3. Negative AoA lift: arrow flips downward (-Y)
    updateAeroForceVectors(group, -40000, 3000, -6, true, { cl: -0.5, cd: 0.04 });
    expect(liftArrow.visible).toBe(true);
    const quatDir = new THREE.Vector3(0, 1, 0).applyQuaternion(liftArrow.quaternion);
    expect(quatDir.y).toBeLessThan(-0.9);
  });
});
