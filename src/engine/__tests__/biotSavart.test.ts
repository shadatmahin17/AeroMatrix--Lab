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

  it('builds geometry-calibrated smoke rake seeds, preserves unskewed centerline midplane, and captures stagnation & downwash', () => {
    const f22Mesh = getAircraft3DModel('f22', 0, 0, 350, 0);
    const sf = AircraftSurfaceField.fromProceduralMesh(f22Mesh);
    expect(sf).not.toBeNull();

    // Tall centerline vertical stabilizers should not skew the lifting-line yMid strongly upward
    const centerSec = { leX: 0, teX: 0, quarterChordX: 0, chord: 0, yMid: 0, thickness: 0 };
    expect(sf!.getSpanSection(0, centerSec)).toBe(true);
    expect(Math.abs(centerSec.yMid)).toBeLessThan(0.75);

    const fluidParams = {
      modelType: 'f22' as const,
      aoaDeg: 6.0,
      airspeed_kts: 350,
      mach: 0.55,
      altitude_ft: 9843,
      flapsDeg: 0,
      viscosity: 0.15,
      isStalled: false,
      cl: 0.85,
      cd: 0.055,
      surfaceField: sf,
      streamlineResolution: 1.0,
    };

    const seeds = FluidDynamics3D.buildSmokeRakeSeeds(sf, fluidParams, 1.0, 0.85);
    expect(seeds.length).toBeGreaterThan(8);
    expect(seeds.some((s) => s.role === 'centerline')).toBe(true);
    expect(seeds.some((s) => s.role === 'wing')).toBe(true);
    expect(seeds.some((s) => s.role === 'tip')).toBe(true);
    for (const seed of seeds) {
      expect(FluidDynamics3D.isValidEmitterSeed(seed.x, seed.y, seed.z, fluidParams)).toBe(true);
    }

    // Positive Cl lifting wing deflects trailing wake streamlines downward (Prandtl downwash)
    const wingSeed = seeds.find((s) => s.role === 'wing')!;
    const wakePts = FluidDynamics3D.traceStreamline(wingSeed, fluidParams, 130, 0.24);
    expect(wakePts.length).toBeGreaterThan(40);
    expect(wakePts[wakePts.length - 1].y).toBeLessThan(wingSeed.y);

    // Forward stagnation region on bluff cylinder should decelerate freely below 0.25 * vInf
    const cylParams = {
      modelType: 'cylinder' as const,
      aoaDeg: 0,
      airspeed_kts: 250,
      mach: 0.38,
      altitude_ft: 5000,
      flapsDeg: 0,
      viscosity: 0.2,
      isStalled: false,
      cl: 0,
      cd: 1.1,
    };
    const vStag = FluidDynamics3D.getVelocity({ x: -1.6, y: 0, z: 0.01 }, cylParams);
    const vFree = FluidDynamics3D.getVelocity({ x: -12, y: 0, z: 0.01 }, cylParams);
    expect(vStag.speed).toBeLessThan(vFree.speed * 0.4);
    expect(vStag.pressureCoeff).toBeGreaterThan(0.7);

    // Explicit streamline count control scales emitter seeds accurately
    const lowSeeds = FluidDynamics3D.buildSmokeRakeSeeds(sf, fluidParams, 1.0, 0.8, 6);
    const highSeeds = FluidDynamics3D.buildSmokeRakeSeeds(sf, fluidParams, 1.0, 0.8, 40);
    const cylSeeds = FluidDynamics3D.buildSmokeRakeSeeds(null, cylParams, 1.0, 0.8, 14);
    expect(lowSeeds.length).toBe(6);
    expect(highSeeds.length).toBe(40);
    expect(cylSeeds.length).toBe(14);
  });

  it('auto-analyzes model archetypes and prevents half-truncated airflow on validation_wing, custom_airfoil, cylinder, and custom GLBs', () => {
    // 1. Validation Wing (AR 6, compact chord = 1.667, full span = 10.0)
    const valMesh = getAircraft3DModel('validation_wing', 0, 0, 220, 0);
    const valSf = AircraftSurfaceField.fromProceduralMesh(valMesh);
    expect(valSf).not.toBeNull();

    const valParams = {
      modelType: 'validation_wing' as const,
      aoaDeg: 5.0,
      airspeed_kts: 220,
      mach: 0.35,
      altitude_ft: 19000,
      flapsDeg: 0,
      viscosity: 0.12,
      isStalled: false,
      cl: 0.45,
      cd: 0.02,
      surfaceField: valSf,
      streamlineResolution: 1.0,
    };

    const valProfile = FluidDynamics3D.analyzeModelFlowProfile(valSf, valParams, 1.0);
    expect(valProfile.archetype).toBe('extruded_2d_wing');
    expect(valProfile.taperRatio).toBeGreaterThan(0.85);
    expect(valProfile.vortexCoreScale).toBeLessThan(0.6);

    const valFrame = FluidDynamics3D.getDynamicEmitterFrame(valSf, 1.0, 1.0);
    expect(valFrame.xSpawn).toBeLessThanOrEqual(-9.0);
    expect(valFrame.xRecycle).toBeGreaterThanOrEqual(12.0);
    expect(valFrame.yHalf).toBeGreaterThanOrEqual(1.8);

    const valSeeds = FluidDynamics3D.buildSmokeRakeSeeds(valSf, valParams, 1.0, 0.8, 24);
    expect(valSeeds.length).toBe(24);
    const valMinZ = Math.min(...valSeeds.map((s) => s.z));
    const valMaxZ = Math.max(...valSeeds.map((s) => s.z));
    expect(valMinZ).toBeLessThan(-3.5);
    expect(valMaxZ).toBeGreaterThan(3.5);

    let valMaxY = -Infinity;
    let valMinY = Infinity;
    for (const seed of valSeeds) {
      const pts = FluidDynamics3D.traceStreamline(seed, valParams, 180, 0.22);
      expect(pts.length).toBeGreaterThan(60);
      expect(pts[pts.length - 1].x).toBeGreaterThan(10.0);
      for (const pt of pts) {
        if (pt.y > valMaxY) valMaxY = pt.y;
        if (pt.y < valMinY) valMinY = pt.y;
        expect(FluidDynamics3D.isInsideSolid(pt, valParams, 0.05)).toBe(false);
      }
    }
    expect(valMaxY).toBeGreaterThan(0.35);
    expect(valMinY).toBeLessThan(-0.35);

    // 2. Custom 2D Airfoil Wing at high lift AoA = 12 deg (tests upwash pre-compensation & upper/lower split)
    const customMesh = getAircraft3DModel('custom_airfoil', 0, 12, 220, 0);
    const customSf = AircraftSurfaceField.fromProceduralMesh(customMesh);
    expect(customSf).not.toBeNull();

    const customParams = {
      modelType: 'custom_airfoil' as const,
      aoaDeg: 12.0,
      airspeed_kts: 220,
      mach: 0.34,
      altitude_ft: 0,
      flapsDeg: 0,
      viscosity: 0.12,
      isStalled: false,
      cl: 1.25,
      cd: 0.054,
      surfaceField: customSf,
      streamlineResolution: 1.0,
    };
    const customProfile = FluidDynamics3D.analyzeModelFlowProfile(customSf, customParams, 1.0);
    expect(customProfile.archetype).toBe('extruded_2d_wing');
    expect(customProfile.xSpawn).toBeLessThanOrEqual(-9.0);
    expect(customProfile.xRecycle).toBeGreaterThanOrEqual(12.0);
    expect(customProfile.upwashPrecompY).toBeLessThan(0);

    const customSeeds = FluidDynamics3D.buildSmokeRakeSeeds(customSf, customParams, 1.0, 0.8, 18);
    expect(customSeeds.length).toBe(18);
    expect(Math.max(...customSeeds.map((s) => s.y))).toBeGreaterThan(0.5);
    expect(Math.min(...customSeeds.map((s) => s.y))).toBeLessThan(-0.5);

    // 3. Cylinder bluff body covers full tunnel horizon & height
    const cylMesh = getAircraft3DModel('cylinder', 0, 0, 220, 0);
    const cylSf = AircraftSurfaceField.fromProceduralMesh(cylMesh);
    const cylFrame = FluidDynamics3D.getDynamicEmitterFrame(cylSf, 1.0, 1.0);
    expect(cylFrame.xSpawn).toBeLessThanOrEqual(-9.0);
    expect(cylFrame.xRecycle).toBeGreaterThanOrEqual(12.0);
    expect(cylFrame.yHalf).toBeGreaterThan(4.0);

    // 4. Synthetic custom GLB airframe (fuselage + wing) auto-classified as winged_aircraft
    const glbGroup = new THREE.Group();
    const fuselage = new THREE.Mesh(new THREE.BoxGeometry(8.0, 1.4, 1.2));
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.25, 10.0));
    glbGroup.add(fuselage, wing);
    const glbSf = AircraftSurfaceField.fromThreeGroup(glbGroup);
    expect(glbSf).not.toBeNull();
    const glbProfile = FluidDynamics3D.analyzeModelFlowProfile(
      glbSf,
      { modelType: 'custom_glb', aoaDeg: 4, cl: 0.6, calibration: null },
      1.0
    );
    expect(glbProfile.archetype).toBe('winged_aircraft');
    expect(glbProfile.taperRatio).toBeLessThan(0.45);
    disposeThreeGroupResources(glbGroup, { disposeGeometries: true });
  }, 20000);

  it('generates unified Box3 boundary-clustered streamlines capped <= 200 with zero solid collisions across all modelTypes and sphere at layer_gap 0.6, 0.4, 0.3', async () => {
    const { MeshBvhCollider } = await import('../MeshBvhCollider');
    const allModelTypes = [
      'f22',
      'airliner',
      'naca2412',
      'naca0012',
      'validation_wing',
      'custom_airfoil',
      'custom_glb',
      'concorde',
      'cylinder',
    ] as const;
    const layerGaps = [0.6, 0.4, 0.3] as const;

    for (const modelType of allModelTypes) {
      const procData = getAircraft3DModel(modelType, 0, 5, 250, 0);
      const sf = AircraftSurfaceField.fromProceduralMesh(procData);

      // Build a matching MeshBvhCollider from procedural mesh faces
      const geo = new THREE.BufferGeometry();
      const verts: number[] = [];
      for (const face of procData.faces) {
        for (let i = 1; i < face.indices.length - 1; i++) {
          const v0 = procData.vertices[face.indices[0]];
          const v1 = procData.vertices[face.indices[i]];
          const v2 = procData.vertices[face.indices[i + 1]];
          verts.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        }
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const bvhCollider = MeshBvhCollider.fromGeometry(geo);

      const fluidParams = {
        modelType,
        aoaDeg: 5,
        airspeed_kts: 250,
        mach: 0.38,
        altitude_ft: 5000,
        flapsDeg: 0,
        viscosity: 0.15,
        isStalled: false,
        cl: modelType === 'cylinder' ? 0 : 0.45,
        cd: modelType === 'cylinder' ? 1.1 : 0.04,
        surfaceField: sf,
        bvhCollider,
        streamlineResolution: 1.0,
      };

      const bounds = FluidDynamics3D.getModelBoundingBox(sf, fluidParams);

      for (const layerGap of layerGaps) {
        const seeds = FluidDynamics3D.buildUnifiedRakeSeeds(bounds, fluidParams, {
          layerGap,
          rakeSpread: 1.0,
          maxFilaments: 200,
        });

        expect(seeds.length).toBeGreaterThan(0);
        expect(seeds.length).toBeLessThanOrEqual(200);

        // Verify upstream emitter plane at minX - 1.5 * lengthX
        const expectedXSpawn = bounds.minX - 1.5 * Math.max(0.8, bounds.lengthX);
        const yVals = new Set(seeds.map((s) => Number(s.y.toFixed(4))));
        expect(yVals.has(Number(bounds.center.y.toFixed(4)))).toBe(true);
        expect(yVals.has(Number((bounds.center.y + 0.92 * bounds.halfY).toFixed(4)))).toBe(true);
        expect(yVals.has(Number((bounds.center.y - 0.92 * bounds.halfY).toFixed(4)))).toBe(true);
        expect(yVals.has(Number((bounds.center.y + 0.99 * bounds.halfY).toFixed(4)))).toBe(true);
        expect(yVals.has(Number((bounds.center.y - 0.99 * bounds.halfY).toFixed(4)))).toBe(true);

        for (const seed of seeds) {
          expect(seed.x).toBeCloseTo(expectedXSpawn, 5);
          expect(FluidDynamics3D.isValidEmitterSeed(seed.x, seed.y, seed.z, fluidParams)).toBe(true);
        }
      }

      bvhCollider?.dispose();
      geo.dispose();
    }

    // Synthetic 3D Sphere test (Box3 + three-mesh-bvh no-penetration deflection)
    const sphereGeo = new THREE.SphereGeometry(2.0, 24, 18);
    const sphereBvh = MeshBvhCollider.fromGeometry(sphereGeo);
    expect(sphereBvh).not.toBeNull();
    sphereGeo.computeBoundingBox();
    const sBox = sphereGeo.boundingBox!;
    const sCenter = sBox.getCenter(new THREE.Vector3());
    const sSize = sBox.getSize(new THREE.Vector3());
    const sphereBounds = {
      center: { x: sCenter.x, y: sCenter.y, z: sCenter.z },
      minX: sBox.min.x,
      maxX: sBox.max.x,
      halfY: sSize.y * 0.5,
      halfZ: sSize.z * 0.5,
      lengthX: sSize.x,
    };
    const sphereParams = {
      modelType: 'custom_glb' as const,
      aoaDeg: 0,
      airspeed_kts: 250,
      mach: 0.38,
      altitude_ft: 5000,
      flapsDeg: 0,
      viscosity: 0.2,
      isStalled: false,
      cl: 0,
      cd: 0.47,
      bvhCollider: sphereBvh,
      streamlineResolution: 1.0,
    };

    for (const layerGap of layerGaps) {
      const seeds = FluidDynamics3D.buildUnifiedRakeSeeds(sphereBounds, sphereParams, {
        layerGap,
        rakeSpread: 1.0,
        maxFilaments: 200,
      });
      expect(seeds.length).toBeGreaterThan(0);
      expect(seeds.length).toBeLessThanOrEqual(200);
      for (const seed of seeds) {
        expect(FluidDynamics3D.isValidEmitterSeed(seed.x, seed.y, seed.z, sphereParams)).toBe(true);
      }
    }

    // Verify BVH deflection pushes near-surface particle outside clearance & projects out inward facet velocity
    const testPos = { x: -1.85, y: 0.3, z: 0.1 };
    const testVel = { u: 1.2, v: -0.1, w: 0.0 };
    const deflected = sphereBvh!.deflectWorldPointAndVelocity(testPos, testVel, 0, 0.15, null);
    expect(deflected).toBe(true);
    const radialDist = Math.hypot(testPos.x, testPos.y, testPos.z);
    expect(radialDist).toBeGreaterThanOrEqual(2.0 + 0.14);
    const closestAfter = sphereBvh!.bvh.closestPointToPoint(new THREE.Vector3(testPos.x, testPos.y, testPos.z));
    expect(closestAfter).not.toBeNull();
    expect(closestAfter!.distance).toBeGreaterThanOrEqual(0.14);
    const facetOut = new THREE.Vector3(
      testPos.x - closestAfter!.point.x,
      testPos.y - closestAfter!.point.y,
      testPos.z - closestAfter!.point.z
    ).normalize();
    const nDotV = facetOut.x * testVel.u + facetOut.y * testVel.v + facetOut.z * testVel.w;
    expect(nDotV).toBeGreaterThanOrEqual(-1e-5);

    sphereBvh!.dispose();
    sphereGeo.dispose();
  }, 25000);
});


