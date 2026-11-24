import { AircraftModelType, SimulationParams } from '../../types/aerodynamics';
import { AeroCalibration } from '../../lib/calibration';
import { Coord2D } from '../../types/airfoil';

export interface SiPhysicsInput {
  modelType: AircraftModelType;
  angleOfAttackDeg: number;
  airspeedKts: number;
  altitudeFt: number;
  flapsDeg: number;
  includePolarSweep?: boolean;
  aoaSweepRange?: [number, number, number];
}

export interface Fluid3DFlowInput {
  modelType: AircraftModelType;
  aoaDeg: number;
  airspeedKts: number;
  mach: number;
  altitudeFt: number;
  flapsDeg: number;
  cl: number;
  cd: number;
  isStalled: boolean;
  viscosity?: number;
  streamlineResolution?: number;
  rakeSpread?: number;
  calibration?: AeroCalibration | null;
  meshSamplePoints?: Float32Array;
  meshBounds?: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  geometryHash?: string;
}

export interface Lbm2DInput {
  airfoilName: string;
  coords: Coord2D[];
  alphaDeg: number;
  u0: number;
  nx?: number;
  ny?: number;
  tau0?: number;
  observedCl?: number | null;
  observedCd?: number | null;
  observedSeparationPct?: number;
  residualDelta?: number;
}

export interface NeuroFoilSurrogateInput {
  airfoilName: string;
  coords: Coord2D[];
  reynolds: number;
  alphaDeg?: number;
}

export interface GeometryAnalyzeInput {
  positions: Float32Array;
  indices?: Uint32Array | Uint16Array | null;
  originalUnitsHint?: 'm' | 'cm' | 'mm' | 'ft' | 'unknown';
}

export interface ExportReportInput {
  modelType: AircraftModelType;
  params: SimulationParams;
  format: 'pdf' | 'markdown' | 'json' | 'csv';
}

export type SimulationRequest =
  | { type: 'RUN_PHYSICS'; runId: string; input: SiPhysicsInput }
  | { type: 'BUILD_SDF'; runId: string; input: Fluid3DFlowInput }
  | { type: 'TRACE_STREAMLINES'; runId: string; input: Fluid3DFlowInput }
  | { type: 'RUN_LBM_DIAGNOSTICS'; runId: string; input: Lbm2DInput }
  | { type: 'ANALYZE_GEOMETRY'; runId: string; input: GeometryAnalyzeInput }
  | { type: 'BUILD_REPORT'; runId: string; input: ExportReportInput };
