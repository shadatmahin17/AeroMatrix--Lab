import * as THREE from 'three';
import { AeroCalibration, AxisDir, BoundingBoxDims } from '../../lib/calibration';
import { CANONICAL_COORDINATE_SYSTEM } from '../../simulation/contracts/ScientificContracts';
import { computeDeterministicHash } from '../../simulation/contracts/SimulationMetadata';
import { GeometryTransformMetadata } from '../contracts/GeometryMetadata';
import { validateThreeObject } from '../validation/meshValidator';
import { normalizeAircraftGroupToTunnel } from '../processing/normalization';

export function buildGeometryTransformMetadata(params: {
  fileName: string;
  rawRoot: THREE.Object3D;
  originalBounds: BoundingBoxDims;
  calibration: AeroCalibration;
  estimatedNoseAxis?: AxisDir;
  estimatedUpAxis?: AxisDir;
  pcaConfidence?: number;
  manualCorrectionApplied?: boolean;
  canonicalMaxDim?: number;
}): {
  metadata: GeometryTransformMetadata;
  normalizedBounds: BoundingBoxDims;
} {
  const validation = validateThreeObject(params.rawRoot);
  const norm = normalizeAircraftGroupToTunnel(
    params.rawRoot,
    params.canonicalMaxDim ?? CANONICAL_COORDINATE_SYSTEM.tunnelReferenceMaxDim,
    CANONICAL_COORDINATE_SYSTEM.aerodynamicCenterFraction
  );

  const normalizedBounds: BoundingBoxDims = {
    x: Number((norm.size.x || 1).toFixed(4)),
    y: Number((norm.size.y || 0.3).toFixed(4)),
    z: Number((norm.size.z || 0.6).toFixed(4)),
  };

  const geometryHash = computeDeterministicHash({
    fileName: params.fileName,
    originalBounds: params.originalBounds,
    normalizedBounds,
    triangleCount: validation.triangleCount,
    vertexCount: validation.vertexCount,
    noseAxis: params.calibration.noseAxis,
    upAxis: params.calibration.upAxis,
  });

  const metadata: GeometryTransformMetadata = {
    fileName: params.fileName,
    geometryHash,
    originalBounds: params.originalBounds,
    normalizedBounds,
    scaleApplied: norm.scaleApplied,
    aerodynamicCenterOffset: [
      Number((norm.min.x + 0.35 * norm.size.x).toFixed(4)),
      Number((0.5 * (norm.min.y + norm.max.y)).toFixed(4)),
      Number((0.5 * (norm.min.z + norm.max.z)).toFixed(4)),
    ],
    coordinateSystem: CANONICAL_COORDINATE_SYSTEM,
    estimatedNoseAxis: params.estimatedNoseAxis ?? params.calibration.noseAxis,
    estimatedUpAxis: params.estimatedUpAxis ?? params.calibration.upAxis,
    pcaConfidence: params.pcaConfidence ?? 1.0,
    manualCorrectionApplied: Boolean(params.manualCorrectionApplied),
    validation,
  };

  return { metadata, normalizedBounds };
}
