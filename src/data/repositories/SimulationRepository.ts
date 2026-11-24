import type { SimulationRecord } from '../../simulation/contracts/SimulationMetadata';
import {
  idbDeleteSimulationRecord,
  idbGetSimulationRecord,
  idbListSimulationRecordsByProject,
  idbSaveSimulationRecord,
} from '../indexeddb/simulationDb';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BenchmarkRunDoc, SharedAirfoilDoc, SharedGlbModelDoc } from '../../lib/airfoilRepository';

export interface ISimulationRepository {
  save(run: SimulationRecord): Promise<void>;
  getById(id: string): Promise<SimulationRecord | null>;
  listByProject(projectId?: string): Promise<SimulationRecord[]>;
  deleteById?(id: string): Promise<void>;
}

export interface IAirfoilRepository {
  listPublic(): Promise<SharedAirfoilDoc[]>;
}

export interface IAircraftRepository {
  listSharedModels(): Promise<SharedGlbModelDoc[]>;
}

export interface IBenchmarkRepository {
  listBenchmarks(): Promise<BenchmarkRunDoc[]>;
}

export class LocalSimulationRepository implements ISimulationRepository {
  public async save(run: SimulationRecord): Promise<void> {
    await idbSaveSimulationRecord(run);
  }

  public async getById(id: string): Promise<SimulationRecord | null> {
    return idbGetSimulationRecord(id);
  }

  public async listByProject(projectId?: string): Promise<SimulationRecord[]> {
    return idbListSimulationRecordsByProject(projectId);
  }

  public async deleteById(id: string): Promise<void> {
    await idbDeleteSimulationRecord(id);
  }
}

/**
 * Cloud Supabase persistence adapter storing compact reproducible metadata & summary JSONB
 * (never uploading raw multi-megabyte CFD grid arrays as database rows) with IndexedDB local cache fallback.
 */
export class SupabaseSimulationRepository implements ISimulationRepository {
  private readonly client: SupabaseClient | null;
  private readonly localCache = new LocalSimulationRepository();
  private readonly tableName: string;

  constructor(client: SupabaseClient | null, tableName = 'simulation_runs') {
    this.client = client;
    this.tableName = tableName;
  }

  public async save(run: SimulationRecord): Promise<void> {
    await this.localCache.save(run);
    if (!this.client) return;
    try {
      const compactPayload = {
        id: run.metadata.id,
        project_id: run.metadata.projectId ?? 'default',
        engine: run.metadata.engine,
        engine_version: run.metadata.engineVersion,
        geometry_hash: run.metadata.geometryHash,
        input_hash: run.metadata.inputHash,
        created_at: run.metadata.createdAt,
        validation_status: run.metadata.validationStatus,
        metadata: run.metadata,
        summary: run.summary,
      };
      await this.client.from(this.tableName).upsert(compactPayload);
    } catch {
      // Graceful offline/RLS fallback to IndexedDB cache
    }
  }

  public async getById(id: string): Promise<SimulationRecord | null> {
    if (this.client) {
      try {
        const { data } = await this.client
          .from(this.tableName)
          .select('metadata, summary')
          .eq('id', id)
          .maybeSingle();
        if (data?.metadata) {
          return {
            metadata: data.metadata,
            summary: data.summary ?? { modelName: 'Unknown' },
            result: null,
          };
        }
      } catch {
        // Fallback to IndexedDB
      }
    }
    return this.localCache.getById(id);
  }

  public async listByProject(projectId?: string): Promise<SimulationRecord[]> {
    if (this.client) {
      try {
        let query = this.client
          .from(this.tableName)
          .select('metadata, summary')
          .order('created_at', { ascending: false })
          .limit(50);
        if (projectId) {
          query = query.eq('project_id', projectId);
        }
        const { data } = await query;
        if (Array.isArray(data) && data.length > 0) {
          return data.map((row) => ({
            metadata: row.metadata,
            summary: row.summary ?? { modelName: 'Unknown' },
            result: null,
          }));
        }
      } catch {
        // Fallback to IndexedDB
      }
    }
    return this.localCache.listByProject(projectId);
  }
}

export function createSimulationRepository(supabaseClient: SupabaseClient | null): ISimulationRepository {
  return supabaseClient
    ? new SupabaseSimulationRepository(supabaseClient)
    : new LocalSimulationRepository();
}
