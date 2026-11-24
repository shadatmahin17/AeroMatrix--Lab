import { AeroTelemetry } from '../../types/aerodynamics';
import { BenchmarkDeviationMetrics } from '../../data/nacaBenchmarks';
import { NeuroFoilPrediction } from '../../lib/neurofoil';
import { AeroResult, AircraftGeometry, FlowConditions } from './ScientificContracts';
import { MeshValidationReport } from '../../geometry/contracts/GeometryMetadata';

export interface PolarPointResult {
  aoaDeg: number;
  cl: number;
  cd: number;
  ldRatio: number;
  cdi: number;
}

export interface SiPhysicsOutput {
  telemetry: AeroTelemetry;
  flow: FlowConditions;
  geometry: AircraftGeometry;
  aeroResult: AeroResult;
  polarSweep: PolarPointResult[];
  benchmarkDeviation: BenchmarkDeviationMetrics | null;
}

export interface Fluid3DFlowOutput {
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    dMin: number;
    cellSize: number;
  };
  gridResolution: { nx: 84; ny: 48; nz: 84 };
  streamlines: Float32Array; // Packed [x, y, z, speed, pressureCoeff, vorticity] per sample point
  streamlineOffsets: Uint32Array; // Start index (point offset) for each streamline + trailing end index
  sdfBuffer?: Float32Array;
}

export interface LbmDiagnosticsReport {
  nx: number;
  ny: number;
  tau0: number;
  u0: number;
  lbmMach: number;
  lbmReynolds: number;
  machValid: boolean;
  bgkStable: boolean;
  gridAdequate: boolean;
  massConservationErrorPct: number;
  converged: boolean;
  residual: number;
  validationStatus: 'verified' | 'unverified' | 'failed';
  warnings: string[];
  solidMask?: Uint8Array;
  solidCellCount: number;
}

export interface NeuroFoilSurrogateOutput {
  prediction: NeuroFoilPrediction;
  valid: boolean;
}

export interface GeometryAnalyzeOutput {
  report: MeshValidationReport;
}

export interface ExportReportOutput {
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
  textContent?: string;
}

export type SimulationResponse<T = unknown> =
  | { type: 'PROGRESS'; runId: string; progress: number; stage?: string }
  | { type: 'RESULT'; runId: string; result: T }
  | { type: 'ERROR'; runId: string; message: string };
