import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { evaluateBiotSavartSegment, FluidDynamics3D, SOLVER_METADATA_3D } from '../FluidDynamics3D';
import { AircraftSurfaceField } from '../AircraftSurfaceField';
import { getAircraft3DModel } from '../../utils/aircraft3DGeometry';
import {
  createAeroForceVectorsGroup,
  disposeThreeGroupResources,
  normalizeAircraftGroupToTunnel,
  optimizeUploadedThreeGroup,
  updateAeroForceVectors,
} from '../../utils/aircraftGlbModels';

describe('Biot–Savart Vortex Filament Kernel', () => {
  it('follows the right-hand rule for a spanwise bound vortex segment along +Z', () => {
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
    const rFar = 40;
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
    const thickAirfoil = {
      ...baseAirfoil,
      vertices: baseAirfoil.vertices.map((v) => ({ x: v.x * 1.4, y: v.y * 2.6, z: v.z * 1.1 })),
    };
    const sf = AircraftSurfaceField.fromProceduralMesh(thickAirfoil);
    expect(sf).not.toBeNull();

    const sample = { dist: 0, nx: 0, ny: 1, nz: 0, inside: false };
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

    updateAeroForceVectors(group, 0, 200, 0, true, { cl: 0, cd: 0.007 });
    expect(liftArrow.visible).toBe(false);
    expect(resultantArrow.visible).toBe(false);
    expect(dragArrow.visible).toBe(true);

    updateAeroForceVectors(group, 20000, 2000, 5, true, { cl: 0.5, cd: 0.05 });
    expect(liftArrow.visible).toBe(true);
    expect(resultantArrow.visible).toBe(true);
    const lowLiftY = liftArrow.cone.position.y;

    updateAeroForceVectors(group, 180000, 12000, 10, true, { cl: 1.0, cd: 0.07 });
    const highLiftY = liftArrow.cone.position.y;
    expect(highLiftY).toBeGreaterThan(lowLiftY);

    updateAeroForceVectors(group, -40000, 3000, -6, true, { cl: -0.5, cd: 0.04 });
    expect(liftArrow.visible).toBe(true);
    const quatDir = new THREE.Vector3(0, 1, 0).applyQuaternion(liftArrow.quaternion);
    expect(quatDir.y).toBeLessThan(-0.9);
  });

  it('normalizes arbitrary 3D models to maxDim=10.0 with 35% aerodynamic center at origin', () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(20, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    mesh.position.set(14, -3, 7);
    group.add(mesh);

    const bounds = normalizeAircraftGroupToTunnel(group, 10.0, 0.35);
    const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
    expect(maxDim).toBeCloseTo(10.0, 4);
    expect(bounds.min.x).toBeCloseTo(-3.5, 4);
    expect(bounds.max.x).toBeCloseTo(6.5, 4);
    expect(0.5 * (bounds.min.y + bounds.max.y)).toBeCloseTo(0, 4);
    expect(0.5 * (bounds.min.z + bounds.max.z)).toBeCloseTo(0, 4);

    disposeThreeGroupResources(group, { disposeGeometries: true, disposeMaterials: true });
  });

  it('optimizes uploaded 3D groups by pruning empty nodes and computing normals/bounds', () => {
    const scene = new THREE.Group();
    const emptyNode = new THREE.Group();
    emptyNode.name = 'EmptyHelper';
    scene.add(emptyNode);

    const geo = new THREE.BoxGeometry(2, 1, 3);
    geo.deleteAttribute('normal');
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    scene.add(mesh);

    const stats = optimizeUploadedThreeGroup(scene);
    expect(stats.meshCount).toBe(1);
    expect(stats.triangleCount).toBe(12);
    expect(scene.getObjectByName('EmptyHelper')).toBeUndefined();
    expect(geo.attributes.normal).toBeDefined();
    expect(geo.boundingBox).not.toBeNull();
    expect(geo.boundingSphere).not.toBeNull();

    disposeThreeGroupResources(scene, { disposeGeometries: true, disposeMaterials: true });
  });

  it('dynamically sizes 84x48x84 SDF grid, exposes dMin = 2*cellSize, and cleanly integrates F-22 RK2 streamlines', () => {
    const f22Mesh = getAircraft3DModel('f22', 0, 0, 350, 0);
    const sf = AircraftSurfaceField.fromProceduralMesh(f22Mesh);
    expect(sf).not.toBeNull();
    expect(sf!.dMin).toBeCloseTo(2.0 * sf!.cellSize, 6);

    const frame = FluidDynamics3D.getDynamicEmitterFrame(sf, 1.0, 1.0);
    expect(frame.xSpawn).toBeLessThan(sf!.minX);
    expect(frame.xRecycle).toBeGreaterThan(sf!.maxX);
    expect(frame.dsMax).toBeLessThanOrEqual(0.03 * sf!.meanChord + 1e-6);

    const fluidParams = {
      modelType: 'f22' as const,
      aoaDeg: 5.0,
      airspeed_kts: 350,
      mach: 0.55,
      altitude_ft: 9843,
      flapsDeg: 0,
      viscosity: 0.15,
      isStalled: false,
      cl: 0.45,
      cd: 0.04,
      surfaceField: sf,
      streamlineResolution: 1.0,
    };

    const pts = FluidDynamics3D.traceStreamline(
      { x: frame.xSpawn, y: 0.05, z: 0.6 },
      fluidParams,
      110,
      0.24
    );
    expect(pts.length).toBeGreaterThan(20);
    for (const pt of pts) {
      expect(Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)).toBe(true);
      expect(FluidDynamics3D.isInsideSolid(pt, fluidParams, 0.02)).toBe(false);
    }

    // Verify stepParticleRK2 advances smoothly without NaN
    const outPos = { x: frame.xSpawn, y: 0.2, z: 1.0 };
    const outVel = {
      u: 1,
      v: 0,
      w: 0,
      speed: 1,
      cpIncompressible: 0,
      pressureCoeff: 0,
      pressureCoeffClamped: 0,
      vorticity: 0,
      isSeparated: false,
    };
    FluidDynamics3D.stepParticleRK2(
      frame.xSpawn,
      0.2,
      1.0,
      fluidParams,
      0.05,
      frame.dsMax,
      outPos,
      outVel
    );
    expect(outPos.x).toBeGreaterThan(frame.xSpawn);
    expect(Number.isFinite(outVel.speed)).toBe(true);

    // Verify SDF clear() resets buffer safely so sample() reports empty cleared space
    sf!.clear();
    const clearedSample = { dist: -99, nx: 0, ny: 1, nz: 0, inside: true };
    expect(sf!.sample(0, 0, 0, clearedSample)).toBe(false);
    expect(
      sf!.getSpanSection(0, {
        leX: 0,
        teX: 0,
        quarterChordX: 0,
        chord: 0,
        yMid: 0,
        thickness: 0,
      })
    ).toBe(false);
  });
});

