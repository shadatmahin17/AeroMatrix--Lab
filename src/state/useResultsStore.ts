import { create } from 'zustand';
import type { AeroTelemetry } from '../types/aerodynamics';
import type { LbmDiagnosticsReport, PolarPointResult } from '../simulation/contracts/SimulationOutput';
import type { SimulationRecord } from '../simulation/contracts/SimulationMetadata';

interface ResultsStoreState {
  telemetry3D: AeroTelemetry | null;
  polarSweep3D: PolarPointResult[];
  lbmDiagnostics2D: LbmDiagnosticsReport | null;
  savedRecords: SimulationRecord[];
  setTelemetry3D: (telemetry: AeroTelemetry, polarSweep?: PolarPointResult[]) => void;
  setLbmDiagnostics2D: (report: LbmDiagnosticsReport | null) => void;
  setSavedRecords: (records: SimulationRecord[]) => void;
  prependSavedRecord: (record: SimulationRecord) => void;
}

export const useResultsStore = create<ResultsStoreState>((set) => ({
  telemetry3D: null,
  polarSweep3D: [],
  lbmDiagnostics2D: null,
  savedRecords: [],
  setTelemetry3D: (telemetry3D, polarSweep3D) =>
    set((s) => ({
      telemetry3D,
      polarSweep3D: polarSweep3D ?? s.polarSweep3D,
    })),
  setLbmDiagnostics2D: (lbmDiagnostics2D) => set({ lbmDiagnostics2D }),
  setSavedRecords: (savedRecords) => set({ savedRecords }),
  prependSavedRecord: (record) =>
    set((s) => ({
      savedRecords: [record, ...s.savedRecords.filter((r) => r.metadata.id !== record.metadata.id)].slice(0, 50),
    })),
}));
