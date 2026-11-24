import {
  computeDeterministicHash,
  type SimulationContext,
  type SimulationEngine,
  type SimulationMetadata,
  type SimulationRecord,
  type ValidationStatus,
} from '../contracts/SimulationMetadata';
import { CANONICAL_COORDINATE_SYSTEM } from '../contracts/ScientificContracts';
import { SimulationRegistry } from './SimulationRegistry';
import { SimulationScheduler } from './SimulationScheduler';
import { SimulationCache } from './SimulationCache';
import { SimulationEventBus, type SimulationEventListener } from './SimulationEvents';
import { SiPhysicsEngine } from '../engines/analytical/SiPhysicsEngine';
import { Fluid3DFlowEngine } from '../engines/fluid3d/Fluid3DFlowEngine';
import { Lbm2DEngine } from '../engines/cfd2d/Lbm2DEngine';
import { NeuroFoilEngine } from '../engines/surrogate/NeuroFoilEngine';
import {
  LocalSimulationRepository,
  type ISimulationRepository,
} from '../../data/repositories/SimulationRepository';

export interface RunEngineOptions {
  projectId?: string;
  geometryHash?: string;
  useCache?: boolean;
  supersedePreviousForEngine?: boolean;
  persistRecord?: boolean;
  modelName?: string;
}

export interface OrchestratedRunResult<O> {
  runId: string;
  result: O;
  metadata: SimulationMetadata;
  fromCache: boolean;
}

export class SimulationManager {
  public readonly registry = new SimulationRegistry();
  public readonly scheduler = new SimulationScheduler();
  public readonly cache = new SimulationCache(64);
  public readonly events = new SimulationEventBus();
  private repository: ISimulationRepository = new LocalSimulationRepository();

  constructor() {
    this.registry.register(new SiPhysicsEngine());
    this.registry.register(new Fluid3DFlowEngine());
    this.registry.register(new Lbm2DEngine());
    this.registry.register(new NeuroFoilEngine());
  }

  public setRepository(repo: ISimulationRepository): void {
    this.repository = repo;
  }

  public subscribe(listener: SimulationEventListener): () => void {
    return this.events.subscribe(listener);
  }

  public registerEngine<I, O>(engine: SimulationEngine<I, O>): void {
    this.registry.register(engine);
  }

  public cancel(runId: string, engineId?: string): boolean {
    const cancelled = this.scheduler.cancelRun(runId);
    if (engineId) {
      this.registry.get(engineId)?.cancel(runId);
      if (cancelled) {
        this.events.emit({ type: 'cancelled', runId, engineId });
      }
    }
    return cancelled;
  }

  public async execute<I, O>(
    engineId: string,
    input: I,
    options: RunEngineOptions = {}
  ): Promise<OrchestratedRunResult<O>> {
    const engine = this.registry.require<I, O>(engineId);
    const validation = engine.validate(input);
    if (!validation.valid) {
      const errorMsg = validation.issues
        .filter((i) => i.severity === 'error')
        .map((i) => i.message)
        .join(' | ');
      throw new Error(`Validation failed for "${engineId}": ${errorMsg}`);
    }

    const geometryHash = options.geometryHash ?? computeDeterministicHash({ engineId, scope: 'default-geometry' });
    const inputHash = computeDeterministicHash(input);
    const cacheKey = SimulationCache.buildKey(engine.id, engine.version, geometryHash, inputHash);

    if (options.useCache !== false) {
      const cached = this.cache.get<O>(cacheKey);
      if (cached) {
        this.events.emit({
          type: 'cached',
          runId: cached.metadata.id,
          engineId: engine.id,
          metadata: cached.metadata,
        });
        return {
          runId: cached.metadata.id,
          result: cached.result,
          metadata: cached.metadata,
          fromCache: true,
        };
      }
    }

    const handle = this.scheduler.startRun(engine.id, {
      supersedePreviousForEngine: options.supersedePreviousForEngine,
    });
    const startedAt = Date.now();
    this.events.emit({ type: 'started', runId: handle.runId, engineId: engine.id, timestamp: startedAt });

    const context: SimulationContext = {
      runId: handle.runId,
      signal: handle.controller.signal,
      onProgress: (progress, stage) => {
        this.events.emit({
          type: 'progress',
          runId: handle.runId,
          engineId: engine.id,
          progress,
          stage,
        });
      },
    };

    try {
      const result = await engine.run(input, context);
      const metadata = this.buildMetadata(
        handle.runId,
        engine,
        input,
        result,
        geometryHash,
        inputHash,
        validation.issues.map((i) => i.message),
        options.projectId
      );

      this.cache.set(cacheKey, result, metadata);

      if (options.persistRecord) {
        const record = this.buildRecord(metadata, result, options.modelName);
        await this.repository.save(record);
      }

      this.events.emit({
        type: 'completed',
        runId: handle.runId,
        engineId: engine.id,
        metadata,
        durationMs: Date.now() - startedAt,
      });

      return {
        runId: handle.runId,
        result,
        metadata,
        fromCache: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (handle.controller.signal.aborted) {
        this.events.emit({ type: 'cancelled', runId: handle.runId, engineId: engine.id });
      } else {
        this.events.emit({ type: 'failed', runId: handle.runId, engineId: engine.id, error: msg });
      }
      throw err;
    } finally {
      this.scheduler.finishRun(handle.runId);
    }
  }

  public async listHistory(projectId?: string): Promise<SimulationRecord[]> {
    return this.repository.listByProject(projectId);
  }

  public async getRecordById(id: string): Promise<SimulationRecord | null> {
    return this.repository.getById(id);
  }

  private buildMetadata(
    runId: string,
    engine: SimulationEngine<unknown, unknown>,
    input: unknown,
    output: unknown,
    geometryHash: string,
    inputHash: string,
    validationWarnings: string[],
    projectId?: string
  ): SimulationMetadata {
    const outObj = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
    const flow = outObj.flow as Record<string, unknown> | undefined;
    const telemetry = outObj.telemetry as Record<string, unknown> | undefined;
    const warnings = [...validationWarnings];

    if (Array.isArray(outObj.warnings)) {
      for (const w of outObj.warnings) {
        if (typeof w === 'string') warnings.push(w);
      }
    }
    if (telemetry && Array.isArray(telemetry.regimeWarnings)) {
      for (const w of telemetry.regimeWarnings as Array<{ title?: string }>) {
        if (w?.title) warnings.push(w.title);
      }
    }

    let validationStatus: ValidationStatus = 'verified';
    if (outObj.validationStatus === 'failed' || outObj.validationStatus === 'unverified' || outObj.validationStatus === 'verified') {
      validationStatus = outObj.validationStatus;
    } else if (telemetry?.continuumValid === false) {
      validationStatus = 'failed';
    } else if (warnings.length > 0) {
      validationStatus = 'unverified';
    }

    const meshResolution =
      typeof outObj.nx === 'number' && typeof outObj.ny === 'number'
        ? { x: outObj.nx, y: outObj.ny }
        : outObj.gridResolution && typeof outObj.gridResolution === 'object'
          ? {
              x: Number((outObj.gridResolution as { nx?: number }).nx ?? 84),
              y: Number((outObj.gridResolution as { ny?: number }).ny ?? 48),
              z: Number((outObj.gridResolution as { nz?: number }).nz ?? 84),
            }
          : undefined;

    const convergence =
      typeof outObj.converged === 'boolean'
        ? {
            converged: outObj.converged,
            iterations: 1,
            residual: typeof outObj.residual === 'number' ? outObj.residual : 0,
          }
        : undefined;

    return {
      id: runId,
      projectId: projectId ?? 'default',
      softwareVersion: 'AeroMatrix-Lab/2.0',
      engine: engine.id,
      engineVersion: engine.version,
      geometryHash,
      inputHash,
      createdAt: new Date().toISOString(),
      solverSettings: (input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {}),
      coordinateSystem: CANONICAL_COORDINATE_SYSTEM,
      environmentalConditions: flow
        ? {
            altitude: Number(flow.altitude ?? 0),
            velocity: Number(flow.velocity ?? 0),
            temperature: Number(flow.temperature ?? 288.15),
            pressure: Number(flow.pressure ?? 101325),
            density: Number(flow.density ?? 1.225),
            dynamicViscosity: Number(flow.dynamicViscosity ?? 1.7894e-5),
            mach: Number(flow.mach ?? 0),
            reynolds: Number(flow.reynolds ?? 0),
          }
        : {},
      numericalPrecision: engine.id === 'si-physics' ? 'float64' : 'float32',
      meshResolution,
      convergence,
      assumptions:
        engine.id === 'fluid-3d'
          ? ['Reduced-order 6-panel Biot-Savart VLM + 84x48x84 SDF visual collision constraint']
          : engine.id === 'lbm-2d'
            ? ['Incompressible D2Q9 Lattice-Boltzmann BGK/Smagorinsky diagnostics']
            : engine.id === 'neurofoil'
              ? ['Reduced-order Bezier feature surrogate calibrated against XFOIL polars']
              : ['SI Standard Atmosphere (0-20km), Prandtl lifting-line & surrogate Cp quadrature'],
      warnings,
      validationStatus,
    };
  }

  private buildRecord<O>(metadata: SimulationMetadata, result: O, modelName?: string): SimulationRecord<O> {
    const outObj = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const telemetry = outObj.telemetry as Record<string, unknown> | undefined;
    const geometry = outObj.geometry as Record<string, unknown> | undefined;

    return {
      metadata,
      summary: {
        modelName: modelName ?? String(geometry?.name ?? metadata.engine),
        cl: typeof telemetry?.cl === 'number' ? telemetry.cl : null,
        cd: typeof telemetry?.cd === 'number' ? telemetry.cd : null,
        ldRatio: typeof telemetry?.ldRatio === 'number' ? telemetry.ldRatio : null,
        mach: typeof telemetry?.mach === 'number' ? telemetry.mach : undefined,
        reynolds: typeof telemetry?.reynolds === 'number' ? telemetry.reynolds : undefined,
      },
      result,
    };
  }
}

export const simulationManager = new SimulationManager();
