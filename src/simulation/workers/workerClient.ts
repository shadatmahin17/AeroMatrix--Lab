import type { SimulationRequest } from '../contracts/SimulationInput';
import type { SimulationResponse } from '../contracts/SimulationOutput';
import { dispatchWorkerRequest } from '../../workers/handlers';

export type WorkerKind = 'physics' | 'fluid3d' | 'geometry' | 'tunnel2d' | 'export';

interface PendingTask<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number, stage?: string) => void;
  kind: WorkerKind;
}

class WorkerClientPool {
  private workers = new Map<WorkerKind, Worker>();
  private pending = new Map<string, PendingTask<unknown>>();

  private getOrSpawnWorker(kind: WorkerKind): Worker | null {
    if (typeof Worker === 'undefined') return null;
    const existing = this.workers.get(kind);
    if (existing) return existing;

    try {
      let worker: Worker;
      switch (kind) {
        case 'physics':
          worker = new Worker(new URL('../../workers/physics.worker.ts', import.meta.url), { type: 'module' });
          break;
        case 'fluid3d':
          worker = new Worker(new URL('../../workers/fluid3d.worker.ts', import.meta.url), { type: 'module' });
          break;
        case 'geometry':
          worker = new Worker(new URL('../../workers/geometry.worker.ts', import.meta.url), { type: 'module' });
          break;
        case 'tunnel2d':
          worker = new Worker(new URL('../../workers/tunnel2d.worker.ts', import.meta.url), { type: 'module' });
          break;
        case 'export':
          worker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), { type: 'module' });
          break;
      }

      worker.onmessage = (event: MessageEvent<SimulationResponse<unknown>>) => {
        const msg = event.data;
        if (!msg || !msg.runId) return;
        const task = this.pending.get(msg.runId);
        if (!task) return;

        if (msg.type === 'PROGRESS') {
          task.onProgress?.(msg.progress, msg.stage);
        } else if (msg.type === 'RESULT') {
          this.pending.delete(msg.runId);
          task.resolve(msg.result);
        } else if (msg.type === 'ERROR') {
          this.pending.delete(msg.runId);
          task.reject(new Error(msg.message));
        }
      };

      worker.onerror = (err) => {
        for (const [runId, task] of this.pending.entries()) {
          if (task.kind === kind) {
            this.pending.delete(runId);
            task.reject(new Error(err.message || `Worker "${kind}" runtime error.`));
          }
        }
        worker.terminate();
        this.workers.delete(kind);
      };

      this.workers.set(kind, worker);
      return worker;
    } catch {
      return null;
    }
  }

  public async execute<T>(
    kind: WorkerKind,
    request: SimulationRequest,
    options?: {
      transferables?: Transferable[];
      onProgress?: (progress: number, stage?: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<T> {
    if (options?.signal?.aborted) {
      throw new Error(`Simulation run "${request.runId}" was cancelled.`);
    }

    const worker = this.getOrSpawnWorker(kind);
    if (!worker) {
      const { result } = await dispatchWorkerRequest(request, options?.onProgress);
      return result as T;
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.cancel(request.runId, kind);
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(request.runId, {
        resolve: (val) => {
          options?.signal?.removeEventListener('abort', onAbort);
          resolve(val as T);
        },
        reject: (err) => {
          options?.signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        onProgress: options?.onProgress,
        kind,
      });

      if (options?.transferables && options.transferables.length > 0) {
        worker.postMessage(request, options.transferables);
      } else {
        worker.postMessage(request);
      }
    });
  }

  public cancel(runId: string, kind?: WorkerKind): void {
    const task = this.pending.get(runId);
    const resolvedKind = kind ?? task?.kind;
    if (task) {
      this.pending.delete(runId);
      task.reject(new Error(`Simulation run "${runId}" cancelled.`));
    }
    if (resolvedKind) {
      const worker = this.workers.get(resolvedKind);
      if (worker) {
        worker.terminate();
        this.workers.delete(resolvedKind);
      }
    }
  }
}

export const workerClient = new WorkerClientPool();
