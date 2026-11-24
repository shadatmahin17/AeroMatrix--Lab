import type { SimulationMetadata } from '../contracts/SimulationMetadata';

export interface CachedSimulationEntry<T = unknown> {
  key: string;
  result: T;
  metadata: SimulationMetadata;
  cachedAtMs: number;
}

export class SimulationCache {
  private readonly maxEntries: number;
  private store = new Map<string, CachedSimulationEntry>();

  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(8, maxEntries);
  }

  public static buildKey(engineId: string, engineVersion: string, geometryHash: string, inputHash: string): string {
    return `${engineId}@${engineVersion}::${geometryHash}::${inputHash}`;
  }

  public get<T>(key: string): CachedSimulationEntry<T> | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry as CachedSimulationEntry<T>;
  }

  public set<T>(key: string, result: T, metadata: SimulationMetadata): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      key,
      result,
      metadata,
      cachedAtMs: Date.now(),
    });
  }

  public invalidateByEngine(engineId: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${engineId}@`)) {
        this.store.delete(key);
      }
    }
  }

  public clear(): void {
    this.store.clear();
  }

  public get size(): number {
    return this.store.size;
  }
}
