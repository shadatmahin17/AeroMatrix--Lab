import * as THREE from 'three';
import { normalizeAircraftGroupToTunnel, NormalizedTunnelBounds } from '../../utils/aircraftGlbModels';
import { BoundingBoxDims } from '../../lib/calibration';

export { normalizeAircraftGroupToTunnel, type NormalizedTunnelBounds };

export function boundingDimsFromBox(box: THREE.Box3): BoundingBoxDims {
  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    x: Number((size.x || 1).toFixed(4)),
    y: Number((size.y || 0.3).toFixed(4)),
    z: Number((size.z || 0.6).toFixed(4)),
  };
}
