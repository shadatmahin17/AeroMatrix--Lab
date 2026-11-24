import { create } from 'zustand';
import type { SimulationMetadata } from '../simulation/contracts/SimulationMetadata';

interface SimulationExecutionState {
  activeRunId: string | null;
  activeEngine: string | null;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stage: string | null;
  lastError: string | null;
  lastMetadata: SimulationMetadata | null;
  setRunning: (runId: string, engine: string, stage?: string) => void;
  setProgress: (progress: number, stage?: string) => void;
  setCompleted: (metadata: SimulationMetadata) => void;
  setFailed: (error: string) => void;
  setCancelled: () => void;
}

export const useSimulationStore = create<SimulationExecutionState>((set) => ({
  activeRunId: null,
  activeEngine: null,
  status: 'idle',
  progress: 0,
  stage: null,
  lastError: null,
  lastMetadata: null,
  setRunning: (activeRunId, activeEngine, stage) =>
    set({
      activeRunId,
      activeEngine,
      status: 'running',
      progress: 0,
      stage: stage ?? 'Initializing',
      lastError: null,
    }),
  setProgress: (progress, stage) =>
    set((s) => ({
      progress,
      stage: stage ?? s.stage,
    })),
  setCompleted: (lastMetadata) =>
    set({
      activeRunId: null,
      status: 'completed',
      progress: 1,
      stage: 'Complete',
      lastMetadata,
    }),
  setFailed: (lastError) =>
    set({
      activeRunId: null,
      status: 'failed',
      lastError,
    }),
  setCancelled: () =>
    set({
      activeRunId: null,
      status: 'cancelled',
      stage: 'Cancelled',
    }),
}));
