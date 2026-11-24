import { AxisDir, BoundingBoxDims } from '../../lib/calibration';
import { CoordinateSystemSpec } from '../../simulation/contracts/ScientificContracts';

export interface MeshValidationReport {
  triangleCount: number;
  vertexCount: number;
  degenerateTriangleCount: number;
  disconnectedComponents: number;
  invertedNormalCount: number;
  nonManifoldEdgeCount: number;
  isWatertightApprox: boolean;
  unitScaleWarning: string | null;
  warnings: string[];
  passed: boolean;
}

export interface GeometryTransformMetadata {
  fileName: string;
  geometryHash: string;
  originalBounds: BoundingBoxDims;
  normalizedBounds: BoundingBoxDims;
  scaleApplied: number;
  aerodynamicCenterOffset: [number, number, number];
  coordinateSystem: CoordinateSystemSpec;
  estimatedNoseAxis: AxisDir;
  estimatedUpAxis: AxisDir;
  pcaConfidence: number;
  manualCorrectionApplied: boolean;
  validation: MeshValidationReport;
}

export interface AirfoilValidation2D {
  valid: boolean;
  pointCount: number;
  closedTrailingEdge: boolean;
  selfIntersectionsApprox: number;
  issues: string[];
}
