import { describe, expect, it } from 'vitest';
import { SimulationManager } from '../../simulation/core/SimulationManager';
import { LocalSimulationRepository } from '../../data/repositories/SimulationRepository';
import { validateRawTriangleSoup } from '../../geometry/validation/meshValidator';
import { lbmNaca4 } from '../../lib/lbm/tunnel2d.js';
import type {
  Fluid3DFlowOutput,
  LbmDiagnosticsReport,
  NeuroFoilSurrogateOutput,
  SiPhysicsOutput,
} from '../../simulation/contracts/SimulationOutput';

describe('Level 3: Orchestrator, Engines, Geometry Validation & Persistence Integration', () => {
  it('runs all 4 registered engines through SimulationManager and caches repeated runs deterministically', async () => {
    const manager = new SimulationManager();
    const repo = new LocalSimulationRepository();
    manager.setRepository(repo);

    // 1. SI Physics Engine + Persistence + Cache Check
    const run1 = await manager.execute<
      {
        modelType: 'validation_wing';
        angleOfAttackDeg: number;
        airspeedKts: number;
        altitudeFt: number;
        flapsDeg: number;
        includePolarSweep: boolean;
      },
      SiPhysicsOutput
    >(
      'si-physics',
      {
        modelType: 'validation_wing',
        angleOfAttackDeg: 5,
        airspeedKts: 100,
        altitudeFt: 0,
        flapsDeg: 0,
        includePolarSweep: true,
      },
      {
        projectId: 'test-suite',
        persistRecord: true,
        modelName: 'Validation Wing AR 6',
      }
    );

    expect(run1.fromCache).toBe(false);
    expect(run1.result.telemetry.aspectRatio).toBeCloseTo(6.0, 2);
    expect(run1.metadata.engine).toBe('si-physics');
    expect(run1.metadata.inputHash).toMatch(/^[0-9a-f]{16}$/);

    const run1Cached = await manager.execute(
      'si-physics',
      {
        modelType: 'validation_wing',
        angleOfAttackDeg: 5,
        airspeedKts: 100,
        altitudeFt: 0,
        flapsDeg: 0,
        includePolarSweep: true,
      },
      { projectId: 'test-suite' }
    );
    expect(run1Cached.fromCache).toBe(true);
    expect(run1Cached.metadata.inputHash).toBe(run1.metadata.inputHash);

    // Verify record persistence
    const saved = await repo.getById(run1.runId);
    expect(saved).not.toBeNull();
    expect(saved!.metadata.inputHash).toBe(run1.metadata.inputHash);
    const list = await repo.listByProject('test-suite');
    expect(list.some((r) => r.metadata.id === run1.runId)).toBe(true);

    // 2. Fluid3D Engine (84x48x84 SDF + RK2 streamlines)
    const run3d = await manager.execute<
      {
        modelType: 'validation_wing';
        aoaDeg: number;
        airspeedKts: number;
        mach: number;
        altitudeFt: number;
        flapsDeg: number;
        cl: number;
        cd: number;
        isStalled: boolean;
      },
      Fluid3DFlowOutput
    >('fluid-3d', {
      modelType: 'validation_wing',
      aoaDeg: 5,
      airspeedKts: 100,
      mach: 0.15,
      altitudeFt: 0,
      flapsDeg: 0,
      cl: run1.result.telemetry.cl,
      cd: run1.result.telemetry.cd,
      isStalled: false,
    });
    expect(run3d.result.gridResolution).toEqual({ nx: 84, ny: 48, nz: 84 });
    expect(run3d.result.sdfBuffer?.length).toBe(84 * 48 * 84);
    expect(run3d.result.streamlines.length).toBeGreaterThan(60);

    // 3. LBM 2D Diagnostics + Surrogate Engine
    const coords = lbmNaca4(0, 4, 12, 40) as Array<[number, number]>;
    const lbmDiag = await manager.execute<
      { airfoilName: string; coords: Array<[number, number]>; alphaDeg: number; u0: number },
      LbmDiagnosticsReport
    >('lbm-2d', {
      airfoilName: 'NACA 0012',
      coords,
      alphaDeg: 6,
      u0: 0.06,
    });
    expect(lbmDiag.result.machValid).toBe(true);
    expect(lbmDiag.result.bgkStable).toBe(true);
    expect(lbmDiag.result.solidCellCount).toBeGreaterThan(200);

    const neuro = await manager.execute<
      { airfoilName: string; coords: Array<[number, number]>; reynolds: number },
      NeuroFoilSurrogateOutput
    >('neurofoil', {
      airfoilName: 'NACA 0012',
      coords,
      reynolds: 3_000_000,
    });
    expect(neuro.result.valid).toBe(true);
    expect(neuro.result.prediction.polar.length).toBeGreaterThan(5);
  });

  it('detects degenerate triangles, disconnected components, and non-manifold edges via meshValidator', () => {
    // 2 disconnected triangles + 1 degenerate zero-area triangle + 3 faces sharing edge (0,1)
    const positions = new Float32Array([
      0, 0, 0, // v0
      1, 0, 0, // v1
      0, 1, 0, // v2
      0, 0, 1, // v3 (shares edge v0-v1 -> 3 incident faces when combined with v4)
      0, -1, 0, // v4
      // Disconnected component:
      50, 50, 50, // v5
      51, 50, 50, // v6
      50, 51, 50, // v7
    ]);
    const indices = new Uint32Array([
      0, 1, 2, // face 1 sharing edge 0-1
      0, 1, 3, // face 2 sharing edge 0-1
      0, 1, 4, // face 3 sharing edge 0-1 -> non-manifold edge!
      0, 0, 1, // degenerate zero-area triangle
      5, 6, 7, // disconnected island
    ]);

    const report = validateRawTriangleSoup(positions, indices);
    expect(report.triangleCount).toBe(5);
    expect(report.degenerateTriangleCount).toBe(1);
    expect(report.nonManifoldEdgeCount).toBeGreaterThanOrEqual(1);
    expect(report.disconnectedComponents).toBe(2);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
