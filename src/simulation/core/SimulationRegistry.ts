import type { SimulationEngine } from '../contracts/SimulationMetadata';

export class SimulationRegistry {
  private engines = new Map<string, SimulationEngine<unknown, unknown>>();

  public register<I, O>(engine: SimulationEngine<I, O>): void {
    this.engines.set(engine.id, engine as SimulationEngine<unknown, unknown>);
  }

  public get<I, O>(id: string): SimulationEngine<I, O> | undefined {
    return this.engines.get(id) as SimulationEngine<I, O> | undefined;
  }

  public require<I, O>(id: string): SimulationEngine<I, O> {
    const engine = this.get<I, O>(id);
    if (!engine) {
      throw new Error(`Simulation engine "${id}" is not registered.`);
    }
    return engine;
  }

  public list(): Array<{ id: string; version: string }> {
    return Array.from(this.engines.values()).map((e) => ({
      id: e.id,
      version: e.version,
    }));
  }
}
