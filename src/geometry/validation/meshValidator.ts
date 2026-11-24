import * as THREE from 'three';
import { AirfoilValidation2D, MeshValidationReport } from '../contracts/GeometryMetadata';

const DEGENERATE_AREA_SQ_EPS = 1e-20; // area < 1e-10

/**
 * Pure geometry health & topology validator operating directly on raw triangle buffers
 * (safe for Web Workers, Node/Vitest, and browser main thread).
 */
export function validateRawTriangleSoup(
  positions: Float32Array,
  indices?: Uint32Array | Uint16Array | null
): MeshValidationReport {
  const vertexCount = Math.floor(positions.length / 3);
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertexCount / 3);

  if (vertexCount < 3 || triangleCount === 0) {
    return {
      triangleCount: 0,
      vertexCount,
      degenerateTriangleCount: 0,
      disconnectedComponents: 0,
      invertedNormalCount: 0,
      nonManifoldEdgeCount: 0,
      isWatertightApprox: false,
      unitScaleWarning: null,
      warnings: ['Empty or insufficient triangle geometry (< 1 triangle).'],
      passed: false,
    };
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const cx = 0.5 * (minX + maxX);
  const cy = 0.5 * (minY + maxY);
  const cz = 0.5 * (minZ + maxZ);

  // Quantize vertices spatially so non-indexed or split-normal vertices merge for component/edge checks
  const qScale = maxDim > 1e-6 ? 10000 / maxDim : 10000;
  const spatialVertexMap = new Map<string, number>();
  const getSpatialVertexId = (vertIdx: number): number => {
    const x = positions[vertIdx * 3];
    const y = positions[vertIdx * 3 + 1];
    const z = positions[vertIdx * 3 + 2];
    const qx = Math.round(x * qScale);
    const qy = Math.round(y * qScale);
    const qz = Math.round(z * qScale);
    const key = `${qx},${qy},${qz}`;
    const existing = spatialVertexMap.get(key);
    if (existing !== undefined) return existing;
    const id = spatialVertexMap.size;
    spatialVertexMap.set(key, id);
    return id;
  };

  // Union-Find over spatial vertices (capped at reasonable mesh sizes for real-time speed)
  const sampleLimit = Math.min(triangleCount, 80000);
  const triSpatialIds = new Int32Array(sampleLimit * 3);
  const edgeCounts = new Map<string, number>();

  let degenerateTriangleCount = 0;
  let invertedNormalCount = 0;

  for (let t = 0; t < sampleLimit; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) {
      degenerateTriangleCount++;
      triSpatialIds[t * 3] = 0;
      triSpatialIds[t * 3 + 1] = 0;
      triSpatialIds[t * 3 + 2] = 0;
      continue;
    }

    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cxp = positions[i2 * 3], cyp = positions[i2 * 3 + 1], czp = positions[i2 * 3 + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cxp - ax, acy = cyp - ay, acz = czp - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const crossSq = nx * nx + ny * ny + nz * nz;

    // 4 * area^2 = |AB x AC|^2 => area^2 < 1e-20 corresponds to 4*area^2 < 4e-20
    if (!Number.isFinite(crossSq) || crossSq <= 4 * DEGENERATE_AREA_SQ_EPS) {
      degenerateTriangleCount++;
    } else {
      // Heuristic outward normal check against bounding-box centroid on outer hull points
      const mx = (ax + bx + cxp) / 3 - cx;
      const my = (ay + by + cyp) / 3 - cy;
      const mz = (az + bz + czp) / 3 - cz;
      const rSq = mx * mx + my * my + mz * mz;
      if (maxDim > 1e-6 && rSq > 0.16 * maxDim * maxDim) {
        const dot = nx * mx + ny * my + nz * mz;
        if (dot < 0) invertedNormalCount++;
      }
    }

    const s0 = getSpatialVertexId(i0);
    const s1 = getSpatialVertexId(i1);
    const s2 = getSpatialVertexId(i2);
    triSpatialIds[t * 3] = s0;
    triSpatialIds[t * 3 + 1] = s1;
    triSpatialIds[t * 3 + 2] = s2;

    const addEdge = (u: number, v: number) => {
      if (u === v) return;
      const lo = u < v ? u : v;
      const hi = u < v ? v : u;
      const key = `${lo}:${hi}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    };
    addEdge(s0, s1);
    addEdge(s1, s2);
    addEdge(s2, s0);
  }

  // Disconnected components via union-find
  const numSpatialVerts = Math.max(1, spatialVertexMap.size);
  const parent = new Int32Array(numSpatialVerts);
  for (let i = 0; i < numSpatialVerts; i++) parent[i] = i;

  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let t = 0; t < sampleLimit; t++) {
    const s0 = triSpatialIds[t * 3];
    const s1 = triSpatialIds[t * 3 + 1];
    const s2 = triSpatialIds[t * 3 + 2];
    union(s0, s1);
    union(s1, s2);
  }

  const roots = new Set<number>();
  for (let i = 0; i < numSpatialVerts; i++) {
    roots.add(find(i));
  }
  const disconnectedComponents = roots.size;

  let nonManifoldEdgeCount = 0;
  let boundaryEdgeCount = 0;
  for (const count of edgeCounts.values()) {
    if (count > 2) nonManifoldEdgeCount++;
    if (count === 1) boundaryEdgeCount++;
  }

  let unitScaleWarning: string | null = null;
  if (maxDim > 500) {
    unitScaleWarning = `Large raw coordinates detected (${maxDim.toFixed(1)} units — likely millimeters); auto-normalized to 10.0 tunnel units.`;
  } else if (maxDim > 0 && maxDim < 0.05) {
    unitScaleWarning = `Very small raw coordinates detected (${maxDim.toFixed(4)} units); auto-normalized to 10.0 tunnel units.`;
  }

  const warnings: string[] = [];
  if (degenerateTriangleCount > 0) {
    warnings.push(`${degenerateTriangleCount} degenerate (zero-area) triangles skipped by SDF/flow queries.`);
  }
  if (nonManifoldEdgeCount > 0) {
    warnings.push(`${nonManifoldEdgeCount} non-manifold edges detected (>2 incident faces).`);
  }
  if (disconnectedComponents > 1) {
    warnings.push(`${disconnectedComponents} disconnected mesh sub-components detected (expected for multi-part CAD assemblies).`);
  }
  if (invertedNormalCount > sampleLimit * 0.25) {
    warnings.push(`High proportion of inward-facing outer hull normals (${invertedNormalCount}); double-sided SDF & lighting guard active.`);
  }
  if (unitScaleWarning) {
    warnings.push(unitScaleWarning);
  }

  return {
    triangleCount,
    vertexCount,
    degenerateTriangleCount,
    disconnectedComponents,
    invertedNormalCount,
    nonManifoldEdgeCount,
    isWatertightApprox: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
    unitScaleWarning,
    warnings,
    passed: triangleCount > 0 && degenerateTriangleCount < triangleCount,
  };
}

/**
 * Traverses a Three.js Object3D hierarchy, extracts world-space vertex positions/indices,
 * and produces a combined `MeshValidationReport`.
 */
export function validateThreeObject(root: THREE.Object3D): MeshValidationReport {
  root.updateMatrixWorld(true);
  const posList: number[] = [];
  const idxList: number[] = [];
  const v = new THREE.Vector3();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos || pos.count < 3) return;

    const baseVertex = posList.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      posList.push(v.x, v.y, v.z);
    }

    const index = mesh.geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) {
        idxList.push(baseVertex + index.getX(i));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        idxList.push(baseVertex + i);
      }
    }
  });

  if (posList.length === 0) {
    return validateRawTriangleSoup(new Float32Array(0));
  }

  return validateRawTriangleSoup(new Float32Array(posList), new Uint32Array(idxList));
}

export function validateAirfoilCoords2D(coords: Array<number[]>): AirfoilValidation2D {
  const issues: string[] = [];
  if (!Array.isArray(coords) || coords.length < 16) {
    issues.push('Insufficient airfoil coordinates (minimum 16 points required).');
    return {
      valid: false,
      pointCount: Array.isArray(coords) ? coords.length : 0,
      closedTrailingEdge: false,
      selfIntersectionsApprox: 0,
      issues,
    };
  }

  let hasInvalid = false;
  for (const [x, y] of coords) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      hasInvalid = true;
      break;
    }
  }
  if (hasInvalid) {
    issues.push('Non-finite coordinate values detected in airfoil profile.');
  }

  const first = coords[0];
  const last = coords[coords.length - 1];
  const teGap = Math.hypot(first[0] - last[0], first[1] - last[1]);
  const closedTrailingEdge = teGap < 0.02;
  if (!closedTrailingEdge) {
    issues.push(`Blunt/open trailing edge gap (${(teGap * 100).toFixed(2)}% chord).`);
  }

  return {
    valid: !hasInvalid && coords.length >= 16,
    pointCount: coords.length,
    closedTrailingEdge,
    selfIntersectionsApprox: 0,
    issues,
  };
}
