import React, { useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  AeroCalibration,
  AxisDir,
  BoundingBoxDims,
  DEFAULT_CALIBRATION,
  ModelClass,
  axisToTuple,
  computeOrientationMatrixArray,
  formatModelClassLabel,
  sanitizeCalibration,
} from '../lib/calibration';
import {
  deleteSharedGlbModel,
  downloadSharedGlbBuffer,
  ensureUserProfile,
  updateSharedGlbModelCalibration,
  uploadSharedGlbModel,
  type SharedGlbModelDoc,
} from '../lib/airfoilRepository.ts';
import { useSupabase } from './SupabaseProvider.tsx';
import { useToast } from './PopupToast.tsx';
import {
  UploadSimple,
  ArrowsLeftRight,
  ArrowsClockwise,
  ArrowCounterClockwise,
  Cube,
  SpinnerGap,
  CloudCheck,
  DownloadSimple,
  Trash,
  Globe,
} from '@phosphor-icons/react';

export const MAX_GLB_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
export const TUNNEL_CUSTOM_GLB_BASE_SCALE = 12.0;

export type GlbUploadPhase =
  | 'idle'
  | 'loading'
  | 'analyzing'
  | 'ready'
  | 'error';

export interface MeshPcaAnalysis {
  /** Unit eigenvector of the longest principal axis in normalized original coordinates. */
  principalAxis: [number, number, number];
  /** Nearest canonical AxisDir whose positive/negative sign aligns with the tapered nose end. */
  pcaNoseAxis: AxisDir;
  /** Confidence that the + vs - end asymmetry distinguishes nose from tail (0..1). */
  asymmetryConfidence: number;
  /** Ratio lambda1 / lambda2 measuring elongation along longest principal axis. */
  elongationRatio: number;
  /** True when PCA detected a 180-degree discrepancy vs AI's noseAxis and flipped it. */
  corrected180: boolean;
  /** Human-readable verification note. */
  note: string;
}

export interface CustomGlbAsset {
  cloudId?: string;
  storagePath?: string;
  storageUrl?: string;
  uploaderUid?: string;
  fileName: string;
  fileSizeBytes: number;
  unitGroup: THREE.Group; // Centered at origin, longest side = 1.0 unit, original axes
  bounds: BoundingBoxDims; // Normalized unit bounds in original axes
  calibration: AeroCalibration;
  pca?: MeshPcaAnalysis;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

interface GlbUploaderProps {
  activeAsset: CustomGlbAsset | null;
  isCustomActive: boolean;
  flipNose: boolean;
  onAssetReady: (asset: CustomGlbAsset) => void;
  onCloudAssetLinked?: (fileName: string, doc: SharedGlbModelDoc) => void;
  onCalibrationUpdated: (
    calibration: AeroCalibration,
    fallbackUsed: boolean,
    reason?: string,
    pca?: MeshPcaAnalysis
  ) => void;
  onFlipNose: () => void;
  onResetDefault: () => void;
}

/**
 * Clones the unit-normalized GLB scene, rotates it so upAxis -> +Y and noseAxis -> -X
 * (or +X when flipNose is true), and scales it cleanly into the 3D wind tunnel chamber.
 */
export function buildOrientedCustomGlbRoot(
  asset: CustomGlbAsset,
  flipNose: boolean
): { root: THREE.Group; orientedBounds: BoundingBoxDims } {
  const wrapper = new THREE.Group();
  wrapper.name = 'Custom_GLB_Wrapper';

  const clonedUnit = asset.unitGroup.clone(true);

  // Re-attach originalMaterial references & clone materials safely so shading modes never mutate the pristine cache
  clonedUnit.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
      mesh.userData.originalMaterial = mesh.material;
    }
  });

  const orientedUnit = new THREE.Group();
  orientedUnit.name = 'Custom_GLB_Oriented_Unit';
  const matArray = computeOrientationMatrixArray(
    asset.calibration.noseAxis,
    asset.calibration.upAxis,
    flipNose
  );
  const rotMatrix = new THREE.Matrix4().fromArray(matArray);
  orientedUnit.quaternion.setFromRotationMatrix(rotMatrix);
  orientedUnit.add(clonedUnit);
  orientedUnit.updateMatrixWorld(true);

  const orientedBox = new THREE.Box3().setFromObject(orientedUnit);
  const orientedSize = new THREE.Vector3();
  orientedBox.getSize(orientedSize);

  const scale = TUNNEL_CUSTOM_GLB_BASE_SCALE * asset.calibration.scaleHint;
  orientedUnit.scale.set(scale, scale, scale);
  wrapper.add(orientedUnit);
  wrapper.updateMatrixWorld(true);

  return {
    root: wrapper,
    orientedBounds: {
      x: Number((orientedSize.x || 1).toFixed(3)),
      y: Number((orientedSize.y || 0.3).toFixed(3)),
      z: Number((orientedSize.z || 0.6).toFixed(3)),
    },
  };
}

export async function parseGlbBuffer(buffer: ArrayBuffer): Promise<{
  unitGroup: THREE.Group;
  bounds: BoundingBoxDims;
}> {
  if (buffer.byteLength < 12) {
    throw new Error('File is too small to be a valid .glb model.');
  }

  // Verify binary glTF magic header ("glTF" = 0x46546C67)
  const magic = new DataView(buffer).getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error('Invalid .glb binary header. Please select a valid binary glTF (.glb) file.');
  }

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
    loader.parse(buffer, '', (result) => resolve(result), (err) => reject(err));
  });

  const rawScene = gltf.scene;
  rawScene.updateMatrixWorld(true);

  let meshCount = 0;
  rawScene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      meshCount++;
      const mesh = child as THREE.Mesh;
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }
      if (!mesh.material) {
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0x94a3b8,
          roughness: 0.4,
          metalness: 0.35,
        });
      }
    }
  });

  if (meshCount === 0) {
    throw new Error('No 3D mesh geometry found inside this .glb file.');
  }

  const box = new THREE.Box3().setFromObject(rawScene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const longest = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(longest) || longest <= 1e-6) {
    throw new Error('Model bounding box is degenerate.');
  }

  const normScale = 1.0 / longest;

  // Center at origin and normalize so longest side = 1.0 unit
  rawScene.position.sub(center);

  const unitGroup = new THREE.Group();
  unitGroup.name = 'Custom_GLB_Unit_Group';
  const scaler = new THREE.Group();
  scaler.scale.setScalar(normScale);
  scaler.add(rawScene);
  unitGroup.add(scaler);
  unitGroup.updateMatrixWorld(true);

  const normBounds: BoundingBoxDims = {
    x: Number((size.x * normScale).toFixed(4)),
    y: Number((size.y * normScale).toFixed(4)),
    z: Number((size.z * normScale).toFixed(4)),
  };

  return { unitGroup, bounds: normBounds };
}

async function parseAndNormalizeGlb(file: File): Promise<{
  unitGroup: THREE.Group;
  bounds: BoundingBoxDims;
}> {
  const buffer = await file.arrayBuffer();
  return parseGlbBuffer(buffer);
}

export async function buildCustomGlbAssetFromDoc(doc: SharedGlbModelDoc): Promise<CustomGlbAsset> {
  const buffer = await downloadSharedGlbBuffer(doc);
  const { unitGroup, bounds } = await parseGlbBuffer(buffer);
  const rawPca = computeMeshPca(unitGroup);
  const calibration = sanitizeCalibration(doc.calibration);
  const pca: MeshPcaAnalysis = {
    ...rawPca,
    corrected180: false,
    note: `PCA + symmetry aligned nose ${calibration.noseAxis}, up ${calibration.upAxis} (elongation ${rawPca.elongationRatio.toFixed(1)}x)`,
  };
  return {
    cloudId: doc.id,
    storagePath: doc.storagePath,
    storageUrl: doc.storageUrl,
    uploaderUid: doc.uploaderUid,
    fileName: doc.filename,
    fileSizeBytes: doc.fileSizeBytes || buffer.byteLength,
    unitGroup,
    bounds: doc.bounds || bounds,
    calibration,
    pca,
    fallbackUsed: false,
  };
}

function vectorToNearestAxisDir(v: [number, number, number]): AxisDir {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return v[0] >= 0 ? '+X' : '-X';
  if (ay >= ax && ay >= az) return v[1] >= 0 ? '+Y' : '-Y';
  return v[2] >= 0 ? '+Z' : '-Z';
}

function axisIndexToDir(axisIdx: 0 | 1 | 2, sign: 1 | -1): AxisDir {
  if (axisIdx === 0) return sign > 0 ? '+X' : '-X';
  if (axisIdx === 1) return sign > 0 ? '+Y' : '-Y';
  return sign > 0 ? '+Z' : '-Z';
}

function sampleNormalizedMeshPoints(unitGroup: THREE.Group, maxSampleVerts = 14000): Float32Array {
  unitGroup.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  let totalVerts = 0;
  unitGroup.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const pos = (child as THREE.Mesh).geometry?.attributes?.position;
      if (pos && pos.count > 0) {
        meshes.push(child as THREE.Mesh);
        totalVerts += pos.count;
      }
    }
  });

  const pts: number[] = [];
  const tmp = new THREE.Vector3();

  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const share = Math.max(48, Math.floor((pos.count / Math.max(1, totalVerts)) * maxSampleVerts));
    const step = Math.max(1, Math.floor(pos.count / share));
    for (let i = 0; i < pos.count; i += step) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (Number.isFinite(tmp.x) && Number.isFinite(tmp.y) && Number.isFinite(tmp.z)) {
        pts.push(tmp.x, tmp.y, tmp.z);
      }
    }
  }

  return new Float32Array(pts);
}

/**
 * Performs 3D Principal Component Analysis (PCA) on the loaded mesh vertices in `unitGroup`
 * using a 3x3 symmetric Jacobi eigensolver, then evaluates geometric nose-vs-tail cross-sectional
 * taper along the longest principal axis to detect its forward orientation.
 */
export function computeMeshPca(unitGroup: THREE.Group): MeshPcaAnalysis {
  const pts = sampleNormalizedMeshPoints(unitGroup, 12000);
  const n = Math.floor(pts.length / 3);
  if (n < 6) {
    return {
      principalAxis: [-1, 0, 0],
      pcaNoseAxis: '-X',
      asymmetryConfidence: 0,
      elongationRatio: 1,
      corrected180: false,
      note: 'Insufficient vertices for PCA; keeping nominal axis.',
    };
  }

  // 1. Mean center
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    mx += pts[i * 3];
    my += pts[i * 3 + 1];
    mz += pts[i * 3 + 2];
  }
  mx /= n;
  my /= n;
  mz /= n;

  // 2. 3x3 Covariance matrix
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - mx;
    const dy = pts[i * 3 + 1] - my;
    const dz = pts[i * 3 + 2] - mz;
    cxx += dx * dx;
    cxy += dx * dy;
    cxz += dx * dz;
    cyy += dy * dy;
    cyz += dy * dz;
    czz += dz * dz;
  }
  const invN = 1 / n;
  const a = [
    [cxx * invN, cxy * invN, cxz * invN],
    [cxy * invN, cyy * invN, cyz * invN],
    [cxz * invN, cyz * invN, czz * invN],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  // 3. Symmetric 3x3 Jacobi eigensolver
  for (let iter = 0; iter < 24; iter++) {
    let p = 0, q = 1;
    let maxOff = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(a[1][2]); }
    if (maxOff < 1e-10) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    a[p][p] = app - t * apq;
    a[q][q] = aqq + t * apq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let r = 0; r < 3; r++) {
      if (r !== p && r !== q) {
        const arp = a[r][p];
        const arq = a[r][q];
        a[r][p] = c * arp - s * arq;
        a[p][r] = a[r][p];
        a[r][q] = s * arp + c * arq;
        a[q][r] = a[r][q];
      }
    }

    for (let r = 0; r < 3; r++) {
      const vrp = v[r][p];
      const vrq = v[r][q];
      v[r][p] = c * vrp - s * vrq;
      v[r][q] = s * vrp + c * vrq;
    }
  }

  // Sort eigenvalues descending
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const e0 = order[0];
  const e1 = order[1];
  const lambda1 = Math.max(1e-9, a[e0][e0]);
  const lambda2 = Math.max(1e-9, a[e1][e1]);
  const elongationRatio = Number((lambda1 / lambda2).toFixed(2));

  const pc1: [number, number, number] = [v[0][e0], v[1][e0], v[2][e0]];

  // 4. Nose-vs-tail polarity along pc1:
  // Compare end-cap radial spread (aircraft/rockets have a slender nose radome at one tip)
  let minProj = Infinity;
  let maxProj = -Infinity;
  const proj = new Float32Array(n);
  const radSq = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const dx = pts[i * 3] - mx;
    const dy = pts[i * 3 + 1] - my;
    const dz = pts[i * 3 + 2] - mz;
    const t = dx * pc1[0] + dy * pc1[1] + dz * pc1[2];
    proj[i] = t;
    const rx = dx - t * pc1[0];
    const ry = dy - t * pc1[1];
    const rz = dz - t * pc1[2];
    radSq[i] = rx * rx + ry * ry + rz * rz;
    if (t < minProj) minProj = t;
    if (t > maxProj) maxProj = t;
  }

  const spanLen = Math.max(1e-4, maxProj - minProj);
  const tipBand = spanLen * 0.24;
  let negSumR = 0, negCount = 0;
  let posSumR = 0, posCount = 0;

  for (let i = 0; i < n; i++) {
    const t = proj[i];
    if (t <= minProj + tipBand) {
      negSumR += Math.sqrt(radSq[i]);
      negCount++;
    } else if (t >= maxProj - tipBand) {
      posSumR += Math.sqrt(radSq[i]);
      posCount++;
    }
  }

  const negMeanR = negCount > 0 ? negSumR / negCount : 0;
  const posMeanR = posCount > 0 ? posSumR / posCount : 0;
  const maxMeanR = Math.max(1e-5, negMeanR, posMeanR);
  const asymmetryConfidence = Number((Math.abs(posMeanR - negMeanR) / maxMeanR).toFixed(3));

  const noseSign = negMeanR <= posMeanR ? -1 : 1;
  const orientedPc1: [number, number, number] = [
    pc1[0] * noseSign,
    pc1[1] * noseSign,
    pc1[2] * noseSign,
  ];
  const pcaNoseAxis = vectorToNearestAxisDir(orientedPc1);

  return {
    principalAxis: orientedPc1,
    pcaNoseAxis,
    asymmetryConfidence,
    elongationRatio,
    corrected180: false,
    note: `PCA principal axis ${pcaNoseAxis} (elongation ${elongationRatio.toFixed(1)}x)`,
  };
}

/**
 * Computes a bilateral mirror-asymmetry score in [0, 1] along canonical axis `axisIdx` (0=X,1=Y,2=Z).
 * Higher score = MORE symmetric left-to-right (characteristic of wing-to-wing lateral axis).
 * Lower score = MORE asymmetric front-to-back (characteristic of nose-to-tail or belly-to-fin axis).
 */
function computeCanonicalMirrorSymmetry(pts: Float32Array, axisIdx: 0 | 1 | 2): number {
  const n = Math.floor(pts.length / 3);
  if (n < 12) return 0.5;

  const otherA = ((axisIdx + 1) % 3) as 0 | 1 | 2;
  const otherB = ((axisIdx + 2) % 3) as 0 | 1 | 2;

  let minK = Infinity, maxK = -Infinity;
  let minA = Infinity, maxA = -Infinity;
  let minB = Infinity, maxB = -Infinity;

  for (let i = 0; i < n; i++) {
    const vk = pts[i * 3 + axisIdx];
    const va = pts[i * 3 + otherA];
    const vb = pts[i * 3 + otherB];
    if (vk < minK) minK = vk;
    if (vk > maxK) maxK = vk;
    if (va < minA) minA = va;
    if (va > maxA) maxA = va;
    if (vb < minB) minB = vb;
    if (vb > maxB) maxB = vb;
  }

  const spanK = Math.max(1e-4, maxK - minK);
  const spanA = Math.max(1e-4, maxA - minA);
  const spanB = Math.max(1e-4, maxB - minB);

  const bins = 6;
  const posGrid = new Float32Array(bins * bins);
  const negGrid = new Float32Array(bins * bins);

  for (let i = 0; i < n; i++) {
    const vk = pts[i * 3 + axisIdx];
    if (Math.abs(vk) < 0.03 * spanK) continue;
    const ba = Math.min(bins - 1, Math.max(0, Math.floor(((pts[i * 3 + otherA] - minA) / spanA) * bins)));
    const bb = Math.min(bins - 1, Math.max(0, Math.floor(((pts[i * 3 + otherB] - minB) / spanB) * bins)));
    const cell = ba * bins + bb;
    if (vk > 0) posGrid[cell] += 1;
    else negGrid[cell] += 1;
  }

  let intersection = 0;
  let total = 0;
  for (let c = 0; c < bins * bins; c++) {
    intersection += Math.min(posGrid[c], negGrid[c]);
    total += Math.max(posGrid[c], negGrid[c]);
  }
  return total > 0 ? intersection / total : 0.5;
}

/**
 * Pure client-side 3D geometric, PCA, and symmetry aerodynamic calibration.
 * Replaces server/AI calls with deterministic mesh inspection.
 */
function calibrateFromMeshGeometry(
  unitGroup: THREE.Group,
  bounds: BoundingBoxDims,
  fileName: string,
  pca: MeshPcaAnalysis
): { calibration: AeroCalibration; pca: MeshPcaAnalysis } {
  const pts = sampleNormalizedMeshPoints(unitGroup, 14000);
  const n = Math.floor(pts.length / 3);
  const spans: [number, number, number] = [bounds.x, bounds.y, bounds.z];
  const symScores: [number, number, number] = [
    computeCanonicalMirrorSymmetry(pts, 0),
    computeCanonicalMirrorSymmetry(pts, 1),
    computeCanonicalMirrorSymmetry(pts, 2),
  ];

  // 1. Identify vertical (upAxis), lateral (spanAxis), and longitudinal (longAxis)
  const axesBySpan = ([0, 1, 2] as const).slice().sort((a, b) => spans[a] - spans[b]);
  const minAxis = axesBySpan[0];
  const midAxis = axesBySpan[1];
  const maxAxis = axesBySpan[2];

  let vertAxis: 0 | 1 | 2;
  let longAxis: 0 | 1 | 2;
  let spanAxis: 0 | 1 | 2;

  if (spans[minAxis] < spans[midAxis] * 0.72) {
    // Thin vertical profile (airliner, fighter, glider, UAV, car)
    vertAxis = minAxis;
    const pair = ([0, 1, 2] as const).filter((ax) => ax !== vertAxis) as [0 | 1 | 2, 0 | 1 | 2];
    const [a0, a1] = pair;
    // The lateral wing-to-wing axis has stronger left-right bilateral mirror symmetry
    const diffSym = symScores[a0] - symScores[a1];
    if (Math.abs(diffSym) > 0.04) {
      spanAxis = diffSym > 0 ? a0 : a1;
      longAxis = spanAxis === a0 ? a1 : a0;
    } else {
      longAxis = spans[a0] >= spans[a1] ? a0 : a1;
      spanAxis = longAxis === a0 ? a1 : a0;
    }
  } else if (spans[maxAxis] >= spans[midAxis] * 1.65) {
    // Rocket / missile / cylindrical fuselage
    longAxis = maxAxis;
    vertAxis = longAxis !== 1 ? 1 : 2;
    spanAxis = (3 - longAxis - vertAxis) as 0 | 1 | 2;
  } else {
    // Compact / bluff body: honor glTF +Y up standard when ambiguous
    vertAxis = 1;
    longAxis = symScores[0] <= symScores[2] ? 0 : 2;
    spanAxis = longAxis === 0 ? 2 : 0;
  }

  // 2. Determine + / - sign of upAxis (dorsal fin / greenhouse cabin tapers narrower on top than belly/wheels)
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const val = pts[i * 3 + vertAxis];
    if (val < minV) minV = val;
    if (val > maxV) maxV = val;
  }
  const spanV = Math.max(1e-4, maxV - minV);
  const capBandV = spanV * 0.25;
  let topSpanSum = 0, topCount = 0;
  let botSpanSum = 0, botCount = 0;
  for (let i = 0; i < n; i++) {
    const val = pts[i * 3 + vertAxis];
    const absLat = Math.abs(pts[i * 3 + spanAxis]);
    if (val >= maxV - capBandV) {
      topSpanSum += absLat;
      topCount++;
    } else if (val <= minV + capBandV) {
      botSpanSum += absLat;
      botCount++;
    }
  }
  const topMeanLat = topCount > 0 ? topSpanSum / topCount : 1;
  const botMeanLat = botCount > 0 ? botSpanSum / botCount : 1;
  // Standard glTF uses +Y up; only flip to -vertAxis if bottom has a pronounced narrower dorsal fin/canopy
  const upSign: 1 | -1 =
    vertAxis === 1
      ? botMeanLat < topMeanLat * 0.72
        ? -1
        : 1
      : topMeanLat <= botMeanLat
        ? 1
        : -1;
  const upAxis = axisIndexToDir(vertAxis, upSign);

  // 3. Determine + / - sign of noseAxis (pointed nose radome / bumper vs wider tail/vertical stabilizer)
  let minL = Infinity, maxL = -Infinity;
  for (let i = 0; i < n; i++) {
    const val = pts[i * 3 + longAxis];
    if (val < minL) minL = val;
    if (val > maxL) maxL = val;
  }
  const spanL = Math.max(1e-4, maxL - minL);
  const tipBandL = spanL * 0.26;
  let negR = 0, negC = 0, negMinV = Infinity, negMaxV = -Infinity;
  let posR = 0, posC = 0, posMinV = Infinity, posMaxV = -Infinity;

  for (let i = 0; i < n; i++) {
    const lVal = pts[i * 3 + longAxis];
    const vVal = pts[i * 3 + vertAxis];
    const sVal = pts[i * 3 + spanAxis];
    const r = Math.hypot(vVal, sVal);
    if (lVal <= minL + tipBandL) {
      negR += r;
      negC++;
      if (vVal < negMinV) negMinV = vVal;
      if (vVal > negMaxV) negMaxV = vVal;
    } else if (lVal >= maxL - tipBandL) {
      posR += r;
      posC++;
      if (vVal < posMinV) posMinV = vVal;
      if (vVal > posMaxV) posMaxV = vVal;
    }
  }
  const negMeanR = negC > 0 ? negR / negC : 0;
  const posMeanR = posC > 0 ? posR / posC : 0;
  const negVertSpread = negC > 0 ? Math.max(0, negMaxV - negMinV) : 0;
  const posVertSpread = posC > 0 ? Math.max(0, posMaxV - posMinV) : 0;

  const negTailScore = negMeanR + negVertSpread * 0.45;
  const posTailScore = posMeanR + posVertSpread * 0.45;
  let noseSign: 1 | -1 = negTailScore <= posTailScore ? -1 : 1;

  // Cross-check with PCA's principal axis polarity if PCA aligns with longitudinal axis
  const pcaTuple = axisToTuple(pca.pcaNoseAxis);
  if (Math.abs(pcaTuple[longAxis]) > 0.5 && pca.asymmetryConfidence >= 0.16) {
    noseSign = pcaTuple[longAxis] > 0 ? 1 : -1;
  }
  const noseAxis = axisIndexToDir(longAxis, noseSign);

  // 4. Classify geometry & compute calibrated aerodynamic parameters
  const L = Math.max(0.05, spans[longAxis]);
  const W = Math.max(0.05, spans[spanAxis]);
  const H = Math.max(0.05, spans[vertAxis]);
  const spanToLen = W / L;
  const heightToLen = H / L;
  const lowerName = fileName.toLowerCase();

  let modelClass: ModelClass = 'other';
  if (/\b(car|sedan|coupe|suv|truck|f1|formula|racecar|auto|vehicle|buggy)\b/.test(lowerName)) {
    modelClass = 'car';
  } else if (/\b(rocket|missile|falcon|saturn|booster|torpedo)\b/.test(lowerName)) {
    modelClass = 'rocket';
  } else if (/\b(glider|sailplane|soarer)\b/.test(lowerName)) {
    modelClass = 'glider';
  } else if (/\b(uav|drone|reaper|predator|rq|mq)\b/.test(lowerName)) {
    modelClass = 'uav';
  } else if (/\b(f22|f16|f35|f18|f15|su|mig|eurofighter|rafale|fighter|delta|concorde|sr71)\b/.test(lowerName)) {
    modelClass = 'delta_fighter';
  } else if (/\b(787|777|747|737|a320|a350|a380|airliner|boeing|airbus|cessna|plane|aircraft)\b/.test(lowerName)) {
    modelClass = 'airliner';
  } else if (/\b(cylinder|cube|sphere|bluff|box|block)\b/.test(lowerName)) {
    modelClass = 'bluff_body';
  } else if (L >= 2.1 * Math.max(W, H) && Math.abs(W - H) / Math.max(W, H) < 0.35) {
    modelClass = 'rocket';
  } else if (spanToLen >= 1.25 && heightToLen <= 0.25) {
    modelClass = 'glider';
  } else if (spanToLen >= 0.78 && heightToLen <= 0.34) {
    modelClass = 'airliner';
  } else if (spanToLen >= 0.55 && heightToLen <= 0.29) {
    modelClass = 'delta_fighter';
  } else if (spanToLen >= 0.32 && spanToLen <= 0.65 && heightToLen >= 0.24 && heightToLen <= 0.55 && botMeanLat >= topMeanLat * 0.95) {
    modelClass = 'car';
  } else if (heightToLen >= 0.45 && spanToLen < 0.75) {
    modelClass = 'bluff_body';
  } else {
    modelClass = 'uav';
  }

  const presets: Record<ModelClass, Partial<AeroCalibration>> = {
    airliner: {
      scaleHint: 1.05,
      cl0: 0.28,
      cd0: 0.024,
      liftSlope: 5.1,
      oswaldEfficiency: 0.85,
      stallAngleDeg: 15.5,
      wingtipVortexStrength: 0.75,
      viscosity: 0.22,
      wakeTurbulenceOnset: 0.45,
      cruiseSpeedMs: 245,
      aoaMinDeg: -8,
      aoaMaxDeg: 20,
    },
    delta_fighter: {
      scaleHint: 1.0,
      cl0: 0.08,
      cd0: 0.02,
      liftSlope: 3.9,
      oswaldEfficiency: 0.74,
      stallAngleDeg: 24.0,
      wingtipVortexStrength: 0.9,
      viscosity: 0.2,
      wakeTurbulenceOnset: 0.65,
      cruiseSpeedMs: 320,
      aoaMinDeg: -10,
      aoaMaxDeg: 32,
    },
    glider: {
      scaleHint: 1.12,
      cl0: 0.34,
      cd0: 0.011,
      liftSlope: 5.8,
      oswaldEfficiency: 0.94,
      stallAngleDeg: 14.0,
      wingtipVortexStrength: 0.42,
      viscosity: 0.14,
      wakeTurbulenceOnset: 0.35,
      cruiseSpeedMs: 42,
      aoaMinDeg: -6,
      aoaMaxDeg: 16,
    },
    uav: {
      scaleHint: 1.0,
      cl0: 0.22,
      cd0: 0.021,
      liftSlope: 5.3,
      oswaldEfficiency: 0.88,
      stallAngleDeg: 16.0,
      wingtipVortexStrength: 0.58,
      viscosity: 0.18,
      wakeTurbulenceOnset: 0.42,
      cruiseSpeedMs: 75,
      aoaMinDeg: -8,
      aoaMaxDeg: 18,
    },
    car: {
      scaleHint: 0.95,
      cl0: -0.18,
      cd0: 0.32,
      liftSlope: 1.1,
      oswaldEfficiency: 0.6,
      stallAngleDeg: 0,
      wingtipVortexStrength: 0.35,
      viscosity: 0.38,
      wakeTurbulenceOnset: 0.8,
      cruiseSpeedMs: 55,
      aoaMinDeg: -5,
      aoaMaxDeg: 8,
    },
    rocket: {
      scaleHint: 1.05,
      cl0: 0.0,
      cd0: 0.16,
      liftSlope: 1.4,
      oswaldEfficiency: 0.65,
      stallAngleDeg: 0,
      wingtipVortexStrength: 0.22,
      viscosity: 0.16,
      wakeTurbulenceOnset: 0.35,
      cruiseSpeedMs: 380,
      aoaMinDeg: -10,
      aoaMaxDeg: 14,
    },
    bluff_body: {
      scaleHint: 0.9,
      cl0: 0.0,
      cd0: 0.95,
      liftSlope: 0.5,
      oswaldEfficiency: 0.5,
      stallAngleDeg: 0,
      wingtipVortexStrength: 0.2,
      viscosity: 0.55,
      wakeTurbulenceOnset: 0.9,
      cruiseSpeedMs: 45,
      aoaMinDeg: -10,
      aoaMaxDeg: 15,
    },
    other: { ...DEFAULT_CALIBRATION },
  };

  const base = presets[modelClass];
  const confidence = Number(
    Math.min(0.96, 0.58 + pca.asymmetryConfidence * 0.35 + (pca.elongationRatio > 1.3 ? 0.1 : 0)).toFixed(2)
  );

  const calibration = sanitizeCalibration({
    ...DEFAULT_CALIBRATION,
    ...base,
    modelClass,
    noseAxis,
    upAxis,
    confidence,
  });

  const updatedPca: MeshPcaAnalysis = {
    ...pca,
    corrected180: false,
    note: `PCA + symmetry aligned nose ${noseAxis}, up ${upAxis} (elongation ${pca.elongationRatio.toFixed(1)}x)`,
  };

  return { calibration, pca: updatedPca };
}

export const GlbUploader: React.FC<GlbUploaderProps> = ({
  activeAsset,
  isCustomActive,
  flipNose,
  onAssetReady,
  onCloudAssetLinked,
  onCalibrationUpdated,
  onFlipNose,
  onResetDefault,
}) => {
  const { user, sharedAirfoils, sharedGlbModels, glbCloudError, isSupabaseReady } = useSupabase();
  const { notify } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<GlbUploadPhase>(() =>
    activeAsset ? 'ready' : 'idle'
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [savingCloud, setSavingCloud] = useState(false);
  const [cloudSaveError, setCloudSaveError] = useState<string | null>(null);
  const [loadingDocId, setLoadingDocId] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  const isBusy = phase === 'loading' || phase === 'analyzing' || loadingDocId !== null;

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setErrorText(null);
    setCloudSaveError(null);

    if (!file.name.toLowerCase().endsWith('.glb')) {
      setPhase('error');
      setErrorText('Only binary .glb files are supported.');
      return;
    }

    if (file.size > MAX_GLB_FILE_BYTES) {
      setPhase('error');
      setErrorText('File exceeds the 50 MB size limit.');
      return;
    }

    try {
      setPhase('loading');
      const { unitGroup, bounds } = await parseAndNormalizeGlb(file);

      setPhase('analyzing');
      const rawPca = computeMeshPca(unitGroup);
      const { calibration, pca } = calibrateFromMeshGeometry(unitGroup, bounds, file.name, rawPca);

      const asset: CustomGlbAsset = {
        fileName: file.name,
        fileSizeBytes: file.size,
        unitGroup,
        bounds,
        calibration,
        pca,
        fallbackUsed: false,
      };

      setPhase('ready');
      onAssetReady(asset);

      if (isSupabaseReady) {
        setSavingCloud(true);
        try {
          const baseName = file.name.replace(/\.glb$/i, '') || 'Custom 3D Model';
          const savedDoc = await uploadSharedGlbModel({
            file,
            name: baseName,
            filename: file.name,
            fileSizeBytes: file.size,
            calibration,
            bounds,
            uploaderName: user?.displayName || 'Community',
          });
          onCloudAssetLinked?.(file.name, savedDoc);
          if (user && !user.uid.startsWith('local:')) {
            const myFoilCount = sharedAirfoils.filter((a) => a.uploaderUid === user.uid).length;
            const myGlbCount = sharedGlbModels.filter((m) => m.uploaderUid === user.uid).length + 1;
            void ensureUserProfile({ totalUploads: myFoilCount + myGlbCount }).catch(() => {});
          }
          notify(`Saved 3D model "${file.name}".`);
        } catch (saveErr) {
          const msg = saveErr instanceof Error ? saveErr.message : 'Could not save 3D model.';
          setCloudSaveError(msg);
          notify(`Loaded "${file.name}" locally; cloud save failed.`, 'error');
        } finally {
          setSavingCloud(false);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load .glb model.';
      setPhase('error');
      setErrorText(msg);
    }
  };

  const handleLoadSavedModel = async (doc: SharedGlbModelDoc) => {
    if (isBusy) return;
    setErrorText(null);
    setCloudSaveError(null);
    setLoadingDocId(doc.id);
    setPhase('loading');
    try {
      const asset = await buildCustomGlbAssetFromDoc(doc);
      setPhase('ready');
      onAssetReady(asset);
      notify(`Loaded "${doc.filename}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load saved 3D model.';
      setPhase('error');
      setErrorText(msg);
    } finally {
      setLoadingDocId(null);
    }
  };

  const handleDownloadSavedModel = async (doc: SharedGlbModelDoc) => {
    try {
      const buffer = await downloadSharedGlbBuffer(doc);
      triggerBlobDownload(new Blob([buffer], { type: 'model/gltf-binary' }), doc.filename);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not download 3D model.';
      setCloudSaveError(msg);
    }
  };

  const handleDeleteSavedModel = async (doc: SharedGlbModelDoc) => {
    if (deletingDocId) return;
    setDeletingDocId(doc.id);
    setCloudSaveError(null);
    try {
      await deleteSharedGlbModel(doc.id, doc.uploaderUid, doc.storagePath);
      notify(`Removed "${doc.name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not delete 3D model.';
      setCloudSaveError(msg);
    } finally {
      setDeletingDocId(null);
    }
  };

  const handleReanalyze = () => {
    if (!activeAsset || isBusy) return;
    setErrorText(null);
    setPhase('analyzing');

    const rawPca = computeMeshPca(activeAsset.unitGroup);
    const { calibration, pca } = calibrateFromMeshGeometry(
      activeAsset.unitGroup,
      activeAsset.bounds,
      activeAsset.fileName,
      rawPca
    );

    setPhase('ready');
    onCalibrationUpdated(calibration, false, undefined, pca);

    if (isSupabaseReady && activeAsset.cloudId) {
      void updateSharedGlbModelCalibration(activeAsset.cloudId, calibration).catch(() => {});
    }
  };

  const statusText = (() => {
    if (phase === 'loading') return loadingDocId ? 'Downloading model…' : 'Loading model';
    if (phase === 'analyzing') return 'Calibrating geometry';
    if (phase === 'error') return errorText || 'Upload failed';
    if (savingCloud) return 'Saving model…';
    if (activeAsset && isCustomActive) {
      return `Ready (${activeAsset.calibration.modelClass})`;
    }
    return 'Upload any .glb mesh (max 50 MB)';
  })();

  const formatBytes = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  return (
    <div className="p-3 rounded-xl bg-[var(--bg)] border border-[var(--border)] flex flex-col gap-2.5">
      <input
        ref={inputRef}
        type="file"
        accept=".glb"
        onChange={handleFileChange}
        className="hidden"
        aria-label="Upload custom .glb 3D model"
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-[9px] bg-gradient-to-br from-[#1769AA]/16 via-[#1769AA]/10 to-[#0EA5E9]/18 ring-1 ring-[#1769AA]/20 flex items-center justify-center text-[#1769AA] shrink-0">
            <Cube weight="duotone" className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-[#161A1D] truncate">
              Custom 3D Model (.glb)
            </div>
            <div
              className={`text-[10px] font-mono truncate flex items-center gap-1 ${
                phase === 'error'
                  ? 'text-red-600 font-semibold'
                  : isBusy || savingCloud
                    ? 'text-[#1769AA] font-semibold'
                    : activeAsset && isCustomActive
                      ? 'text-emerald-700 font-semibold'
                      : 'text-[#5C6670]'
              }`}
            >
              {(isBusy || savingCloud) && <SpinnerGap className="w-3 h-3 animate-spin shrink-0" />}
              <span className="truncate">{statusText}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={isBusy}
          onClick={() => inputRef.current?.click()}
          className="px-2.5 py-1.5 rounded-lg bg-[#1769AA] hover:bg-[#145a92] disabled:opacity-60 text-white font-semibold text-[11px] transition-colors flex items-center gap-1.5 shadow-sm shrink-0 cursor-pointer"
        >
          <UploadSimple weight="bold" className="w-3.5 h-3.5" />
          <span>Upload .glb</span>
        </button>
      </div>

      {(cloudSaveError || (glbCloudError && sharedGlbModels.length === 0)) && (
        <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-snug">
          {cloudSaveError || glbCloudError}
        </div>
      )}

      {activeAsset && isCustomActive && (
        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border)]">
          <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-[#5C6670]">
            <span className="truncate font-semibold text-[#161A1D] flex items-center gap-1" title={activeAsset.fileName}>
              {activeAsset.cloudId && (
                <CloudCheck weight="duotone" className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              )}
              <span className="truncate">
                {activeAsset.fileName} · {formatBytes(activeAsset.fileSizeBytes)}
              </span>
            </span>
            <span className="shrink-0">
              Nose {flipNose ? 'Flipped' : activeAsset.calibration.noseAxis} · Up {activeAsset.calibration.upAxis}
            </span>
          </div>

          {activeAsset.pca && (
            <p className="text-[10px] text-[#5C6670] font-mono leading-snug">
              {activeAsset.pca.note}
            </p>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={isBusy}
              onClick={onFlipNose}
              className={`py-1.5 px-2 rounded-lg text-[10.5px] font-semibold border transition-colors flex items-center justify-center gap-1 cursor-pointer ${
                flipNose
                  ? 'bg-[var(--accent-light)] text-[#1769AA] border-[#1769AA]/45'
                  : 'bg-[var(--surface)] text-[#161A1D] border-[var(--border)] hover:border-[#1769AA]'
              }`}
              title="Rotate 180 degrees around vertical axis if nose points backwards"
            >
              <ArrowsLeftRight weight="bold" className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Flip nose</span>
            </button>

            <button
              type="button"
              disabled={isBusy}
              onClick={handleReanalyze}
              className="py-1.5 px-2 rounded-lg text-[10.5px] font-semibold bg-[var(--surface)] text-[#161A1D] border border-[var(--border)] hover:border-[#1769AA] disabled:opacity-60 transition-colors flex items-center justify-center gap-1 cursor-pointer"
              title="Re-run local 3D PCA and geometric aerodynamic calibration"
            >
              <ArrowsClockwise weight="bold" className={`w-3.5 h-3.5 shrink-0 ${phase === 'analyzing' ? 'animate-spin' : ''}`} />
              <span className="truncate">Re-analyze</span>
            </button>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={onResetDefault}
            className="w-full py-1.5 px-2.5 rounded-lg text-[10.5px] font-semibold bg-[var(--surface)] text-[#5C6670] hover:text-red-700 border border-[var(--border)] hover:border-red-300 disabled:opacity-60 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <ArrowCounterClockwise weight="bold" className="w-3.5 h-3.5 shrink-0" />
            <span>Reset to default aircraft</span>
          </button>
        </div>
      )}

      {(isSupabaseReady || sharedGlbModels.length > 0) && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border)]">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-[10.5px] font-bold text-[#161A1D]">
              <Globe weight="duotone" className="w-3.5 h-3.5 text-[#1769AA]" />
              <span>Saved 3D Models ({sharedGlbModels.length})</span>
            </span>
            <span className="text-[10px] font-mono text-[#5C6670]">Auto-saved</span>
          </div>

          {sharedGlbModels.length === 0 ? (
            <div className="text-[10px] text-[#5C6670] px-2.5 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-center">
              Uploaded .glb models will appear here for one-click reload.
            </div>
          ) : (
            <div className="max-h-40 overflow-y-auto custom-scrollbar rounded-lg border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
              {sharedGlbModels.map((item) => {
                const isSelected = Boolean(isCustomActive && activeAsset?.cloudId === item.id);
                const isRowLoading = loadingDocId === item.id;
                const isRowDeleting = deletingDocId === item.id;
                const canDelete = Boolean(
                  !item.uploaderUid || (user && item.uploaderUid === user.uid)
                );

                return (
                  <div
                    key={item.id}
                    className={`px-2.5 py-1.5 flex items-center justify-between gap-1.5 transition-colors ${
                      isSelected ? 'bg-[var(--accent-light)]' : 'hover:bg-[var(--bg)]'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleLoadSavedModel(item)}
                      className="flex-1 min-w-0 text-left cursor-pointer disabled:opacity-60"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isRowLoading ? (
                          <SpinnerGap className="w-3 h-3 animate-spin text-[#1769AA] shrink-0" />
                        ) : (
                          <Cube
                            weight={isSelected ? 'fill' : 'duotone'}
                            className="w-3 h-3 text-[#1769AA] shrink-0"
                          />
                        )}
                        <span className="text-[11px] font-bold text-[#161A1D] truncate">
                          {item.name}
                        </span>
                      </div>
                      <div className="text-[9.5px] font-mono tabular-nums text-[#5C6670] truncate">
                        {formatModelClassLabel(item.modelClass)} · {formatBytes(item.fileSizeBytes)} · {item.uploaderName}
                      </div>
                    </button>

                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleDownloadSavedModel(item)}
                        title={`Download ${item.filename}`}
                        aria-label={`Download ${item.name}`}
                        className="p-1 rounded text-[#5C6670] hover:text-[#1769AA] cursor-pointer"
                      >
                        <DownloadSimple weight="bold" className="w-3.5 h-3.5" />
                      </button>
                      {canDelete && (
                        <button
                          type="button"
                          disabled={isRowDeleting}
                          onClick={() => void handleDeleteSavedModel(item)}
                          title={`Delete ${item.name}`}
                          aria-label={`Delete ${item.name}`}
                          className="p-1 rounded text-[#5C6670] hover:text-red-600 disabled:opacity-50 cursor-pointer"
                        >
                          <Trash weight="bold" className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
