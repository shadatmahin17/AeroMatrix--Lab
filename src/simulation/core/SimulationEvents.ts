import type { SimulationMetadata } from '../contracts/SimulationMetadata';

export type SimulationEvent =
  | { type: 'started'; runId: string; engineId: string; timestamp: number }
  | { type: 'progress'; runId: string; engineId: string; progress: number; stage?: string }
  | { type: 'cached'; runId: string; engineId: string; metadata: SimulationMetadata }
  | { type: 'completed'; runId: string; engineId: string; metadata: SimulationMetadata; durationMs: number }
  | { type: 'failed'; runId: string; engineId: string; error: string }
  | { type: 'cancelled'; runId: string; engineId: string };

export type SimulationEventListener = (event: SimulationEvent) => void;

export class SimulationEventBus {
  private listeners = new Set<SimulationEventListener>();

  public subscribe(listener: SimulationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: SimulationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate subscriber failures so orchestration continues safely
      }
    }
  }
}
