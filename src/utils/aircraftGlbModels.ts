import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { AircraftModelType } from '../types/aerodynamics';

export interface GlbModelMetadata {
  id: AircraftModelType;
  name: string;
  glbPath: string;
  targetLength: number;
  rotationOffset: [number, number, number];
  positionOffset: [number, number, number];
  scaleMultiplier: number;
  fileSizeLabel: string;
  meshCountLabel: string;
  sourceCredit: string;
}

export const GLB_MODEL_REGISTRY: Record<string, GlbModelMetadata> = {
  airliner: {
    id: 'airliner',
    name: 'Boeing 787 Dreamliner',
    glbPath: '/models/boeing_787.glb',
    targetLength: 14.5,
    // Boeing 787 CAD has length on X (nose at +X): rotate 180 deg to point nose directly into oncoming flow (-X)
    rotationOffset: [0, Math.PI, 0],
    positionOffset: [0, 0, 0],
    scaleMultiplier: 1.0,
    fileSizeLabel: '3.9 MB CAD',
    meshCountLabel: '1,872 Meshes',
    sourceCredit: 'High-detail Boeing 787 commercial airliner CAD model',
  },
  concorde: {
    id: 'concorde',
    name: 'Concorde SST (Supersonic)',
    glbPath: '/models/concorde_free_with_interior.glb',
    targetLength: 15.0,
    // Concorde CAD has needle nose natively pointing upstream (-X) and tail downstream (+X)
    rotationOffset: [0, 0, 0],
    positionOffset: [0, 0, 0],
    scaleMultiplier: 1.0,
    fileSizeLabel: '755 KB PBR',
    meshCountLabel: '37 Meshes & Interior',
    sourceCredit: 'Concorde SST Mach 2.0 CAD model with passenger cabin',
  },
  naca2412: {
    id: 'naca2412',
    name: 'Airfoil Section 3D',
    glbPath: '/models/airfoil.glb',
    targetLength: 9.5,
    // Airfoil CAD: maps thick leading edge to -X and sharp trailing edge to +X with span on Z
    rotationOffset: [Math.PI / 2, 0, -Math.PI / 2],
    positionOffset: [0, 0, 0],
    scaleMultiplier: 1.0,
    fileSizeLabel: '11.4 KB Mesh',
    meshCountLabel: '1 Lifting Surface',
    sourceCredit: 'Precision aerodynamic 3D airfoil boundary wing section',
  },
  f22: {
    id: 'f22',
    name: 'F-22 Raptor Stealth Fighter',
    glbPath: '/models/f22_raptor.glb',
    targetLength: 13.0,
    // F-22 native CAD nose is at +X: rotate 180 deg to face oncoming wind (-X)
    rotationOffset: [0, Math.PI, 0],
    positionOffset: [0, 0, 0],
    scaleMultiplier: 1.0,
    fileSizeLabel: '741 KB PBR',
    meshCountLabel: '8 Airframe Groups',
    sourceCredit: '5th-Gen Stealth Fighter CAD Mesh by bohmerang',
  },
};

// In-memory cache for parsed GLTF scenes (stored in normalized tunnel space)
const gltfCache = new Map<string, THREE.Group>();

// Module-level scratch math helpers (zero per-call / per-frame allocations)
const _normBox = new THREE.Box3();
const _normSize = new THREE.Vector3();
const _hmWindDir = new THREE.Vector3();
const _hmNormalMatrix = new THREE.Matrix3();
const _hmWorldNormal = new THREE.Vector3();

export interface NormalizedTunnelBounds {
  size: THREE.Vector3;
  min: THREE.Vector3;
  max: THREE.Vector3;
  scaleApplied: number;
}

export interface OptimizedGroupStats {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  optimizedTextures: number;
}

/**
 * Uniformly scales `root` so its longest bounding-box dimension equals `canonicalMaxDim`
 * (default 10.0 tunnel units) and translates it so its aerodynamic center
 * (acLengthFraction of length aft of nose, centered in Y and Z) sits at world origin (0, 0, 0).
 */
export function normalizeAircraftGroupToTunnel(
  root: THREE.Object3D,
  canonicalMaxDim = 10.0,
  acLengthFraction = 0.35
): NormalizedTunnelBounds {
  root.updateMatrixWorld(true);
  _normBox.setFromObject(root);
  _normBox.getSize(_normSize);

  const rawMax = Math.max(_normSize.x, _normSize.y, _normSize.z);
  const s = rawMax > 1e-6 && Number.isFinite(rawMax) ? canonicalMaxDim / rawMax : 1.0;

  const acX = _normBox.min.x + acLengthFraction * _normSize.x;
  const acY = 0.5 * (_normBox.min.y + _normBox.max.y);
  const acZ = 0.5 * (_normBox.min.z + _normBox.max.z);

  root.scale.multiplyScalar(s);
  root.position.set(
    (root.position.x - acX) * s,
    (root.position.y - acY) * s,
    (root.position.z - acZ) * s
  );
  root.updateMatrixWorld(true);

  _normBox.setFromObject(root);
  const outSize = new THREE.Vector3();
  _normBox.getSize(outSize);

  return {
    size: outSize,
    min: _normBox.min.clone(),
    max: _normBox.max.clone(),
    scaleApplied: s,
  };
}

/**
 * Optimizes uploaded or parsed GLTF/Three.js scene graphs for smooth 60 FPS interaction:
 * - Prunes empty non-mesh helper nodes
 * - Computes missing vertex normals, bounding boxes, and bounding spheres with frustumCulled = true
 * - Downscales oversized embedded textures (> 1024px) to protect mobile/WebGL VRAM
 * - Disables costly shadow passes and freezes static matrices on ultra-high-poly meshes (> 120k tris)
 */
export function optimizeUploadedThreeGroup(rawScene: THREE.Object3D): OptimizedGroupStats {
  let meshCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let optimizedTextures = 0;

  const meshes: THREE.Mesh[] = [];
  const meshDescendantMap = new WeakSet<THREE.Object3D>();
  const emptyNodes: THREE.Object3D[] = [];

  rawScene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const pos = mesh.geometry?.attributes?.position;
      if (!pos || pos.count === 0) {
        emptyNodes.push(mesh);
        return;
      }
      meshCount++;
      vertexCount += pos.count;
      const idx = mesh.geometry.index;
      triangleCount += idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
      meshes.push(mesh);

      let p: THREE.Object3D | null = mesh;
      while (p) {
        meshDescendantMap.add(p);
        p = p.parent;
      }
    }
  });

  rawScene.traverse((child) => {
    if (child !== rawScene && !meshDescendantMap.has(child) && !(child as THREE.Light).isLight) {
      emptyNodes.push(child);
    }
  });

  for (const node of emptyNodes) {
    node.parent?.remove(node);
  }

  const processedTextures = new WeakSet<THREE.Texture>();
  const maybeDownscaleTexture = (tex: THREE.Texture | null | undefined) => {
    if (!tex || processedTextures.has(tex)) return;
    processedTextures.add(tex);
    if (typeof document === 'undefined') return;
    const img = tex.image as { width?: number; height?: number } | undefined;
    if (!img || !img.width || !img.height) return;
    const maxEdge = Math.max(img.width, img.height);
    if (maxEdge <= 1024) return;
    try {
      const scale = 1024 / maxEdge;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
      tex.image = canvas;
      tex.needsUpdate = true;
      optimizedTextures++;
    } catch {
      // Skip non-canvas-drawable images (e.g. compressed/data textures)
    }
  };

  const isHeavyPoly = triangleCount > 120_000;

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    if (geo) {
      if (!geo.attributes.normal) {
        geo.computeVertexNormals();
      }
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingSphere) geo.computeBoundingSphere();
    }

    mesh.frustumCulled = true;
    if (isHeavyPoly) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    } else {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const std = m as THREE.MeshStandardMaterial;
      maybeDownscaleTexture(std.map);
      maybeDownscaleTexture(std.normalMap);
      maybeDownscaleTexture(std.roughnessMap);
      maybeDownscaleTexture(std.metalnessMap);
      maybeDownscaleTexture(std.aoMap);
      maybeDownscaleTexture(std.emissiveMap);
    }
  }

  return { meshCount, vertexCount, triangleCount, optimizedTextures };
}

/**
 * Safely disposes Three.js materials, cached shading variants, and optionally geometries/textures
 * inside a group so swapping or removing `.glb` models does not leak WebGL VRAM.
 */
export function disposeThreeGroupResources(
  root: THREE.Object3D | null | undefined,
  options: { disposeGeometries?: boolean; disposeMaterials?: boolean; disposeTextures?: boolean } = {}
): void {
  if (!root) return;
  const { disposeGeometries = false, disposeMaterials = true, disposeTextures = false } = options;

  const disposeMat = (mat: THREE.Material | null | undefined) => {
    if (!mat) return;
    if (disposeTextures) {
      const std = mat as THREE.MeshStandardMaterial;
      std.map?.dispose();
      std.normalMap?.dispose();
      std.roughnessMap?.dispose();
      std.metalnessMap?.dispose();
      std.aoMap?.dispose();
      std.emissiveMap?.dispose();
    }
    mat.dispose();
  };

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    if (disposeGeometries && mesh.geometry) {
      mesh.geometry.dispose();
    }

    if (disposeMaterials) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) disposeMat(m);
      if (mesh.userData.originalMaterial && mesh.userData.originalMaterial !== mesh.material) {
        const orig = Array.isArray(mesh.userData.originalMaterial)
          ? mesh.userData.originalMaterial
          : [mesh.userData.originalMaterial];
        for (const m of orig) disposeMat(m);
      }
      if (mesh.userData.heatmapMaterial) {
        disposeMat(mesh.userData.heatmapMaterial as THREE.Material);
        mesh.userData.heatmapMaterial = undefined;
      }
      if (mesh.userData.xrayMaterial) {
        disposeMat(mesh.userData.xrayMaterial as THREE.Material);
        mesh.userData.xrayMaterial = undefined;
      }
    }
  });
}

/**
 * Loads a GLB model with automatic centering, bounding-box normalization (maxDim = 10.0,
 * aerodynamic center at 35% aft of nose), and airflow axis alignment (nose towards -X).
 */
export function loadGlbAircraftModel(
  modelType: AircraftModelType,
  onProgress?: (progressPercent: number) => void
): Promise<{ root: THREE.Group; metadata: GlbModelMetadata }> {
  return new Promise((resolve, reject) => {
    const meta = GLB_MODEL_REGISTRY[modelType];
    if (!meta) {
      reject(new Error(`No GLB model configured for type: ${modelType}`));
      return;
    }

    const cached = gltfCache.get(modelType);
    if (cached) {
      if (onProgress) onProgress(100);
      resolve({ root: cached, metadata: meta });
      return;
    }

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);

    loader.load(
      meta.glbPath,
      (gltf) => {
        const rawScene = gltf.scene;
        optimizeUploadedThreeGroup(rawScene);

        const wrapper = new THREE.Group();
        wrapper.name = `GLB_${modelType}_Wrapper`;

        const box = new THREE.Box3().setFromObject(rawScene);
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Center the raw scene at origin before orientation alignment
        rawScene.position.sub(center);

        const innerGroup = new THREE.Group();
        innerGroup.name = `GLB_${modelType}_Inner`;
        innerGroup.add(rawScene);

        // Apply metadata rotation to align nose cleanly into oncoming wind (-X)
        innerGroup.rotation.set(
          meta.rotationOffset[0],
          meta.rotationOffset[1],
          meta.rotationOffset[2]
        );
        innerGroup.position.set(
          meta.positionOffset[0],
          meta.positionOffset[1],
          meta.positionOffset[2]
        );

        wrapper.add(innerGroup);

        // Normalize uniformly to canonical 10.0 tunnel units with aerodynamic center at 35% length
        normalizeAircraftGroupToTunnel(wrapper, 10.0, 0.35);

        // Preserve original materials and vertex data references
        wrapper.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.userData.originalMaterial = mesh.material;
            if (mesh.geometry && !mesh.geometry.attributes.normal) {
              mesh.geometry.computeVertexNormals();
            }
          }
        });

        gltfCache.set(modelType, wrapper);
        resolve({ root: wrapper, metadata: meta });
      },
      (xhr) => {
        if (xhr.total > 0 && onProgress) {
          onProgress(Math.round((xhr.loaded / xhr.total) * 100));
        }
      },
      (error) => {
        console.error(`Failed to load GLB model for ${modelType} from ${meta.glbPath}:`, error);
        reject(error);
      }
    );
  });
}

/**
 * Applies CFD Pressure Heatmap colors across the 3D GLB model based on
 * surface face normals relative to wind vector and angle of attack.
 * Uses module-level scratch math and direct Float32Array indexing for zero GC overhead.
 */
export function applyCfdPressureHeatmap(
  root: THREE.Group,
  aoaDeg: number,
  isStalled: boolean
): void {
  const aoaRad = (aoaDeg * Math.PI) / 180;
  // Wind flows from -X to +X, so freestream relative to aircraft is (cos(aoa), -sin(aoa), 0)
  _hmWindDir.set(Math.cos(aoaRad), -Math.sin(aoaRad), 0).normalize();
  const wx = _hmWindDir.x;
  const wy = _hmWindDir.y;
  const wz = _hmWindDir.z;

  root.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const geo = mesh.geometry;
    if (!geo || !geo.attributes.position) return;

    _hmNormalMatrix.getNormalMatrix(mesh.matrixWorld);
    const m = _hmNormalMatrix.elements;
    const m00 = m[0], m01 = m[3], m02 = m[6];
    const m10 = m[1], m11 = m[4], m12 = m[7];
    const m20 = m[2], m21 = m[5], m22 = m[8];

    const posCount = geo.attributes.position.count;
    let colorAttr = geo.attributes.color as THREE.BufferAttribute | undefined;
    if (!colorAttr || colorAttr.count !== posCount) {
      colorAttr = new THREE.BufferAttribute(new Float32Array(posCount * 3), 3);
      geo.setAttribute('color', colorAttr);
    }

    const colArr = colorAttr.array as Float32Array;
    const normals = geo.attributes.normal;
    const normArr = normals ? (normals.array as Float32Array) : null;
    const normStride = normals && 'itemSize' in normals ? normals.itemSize : 3;

    for (let i = 0; i < posCount; i++) {
      let nx = 0, ny = 1, nz = 0;
      if (normArr) {
        const nIdx = i * normStride;
        const lnx = normArr[nIdx];
        const lny = normArr[nIdx + 1];
        const lnz = normArr[nIdx + 2];
        _hmWorldNormal.set(
          m00 * lnx + m01 * lny + m02 * lnz,
          m10 * lnx + m11 * lny + m12 * lnz,
          m20 * lnx + m21 * lny + m22 * lnz
        );
        const nLen = _hmWorldNormal.length();
        if (nLen > 1e-6) {
          nx = _hmWorldNormal.x / nLen;
          ny = _hmWorldNormal.y / nLen;
          nz = _hmWorldNormal.z / nLen;
        }
      }

      const dot = -(nx * wx + ny * wy + nz * wz);

      let r = 0, g = 0.5, b = 1.0;

      if (isStalled) {
        r = 0.95;
        g = 0.15 + Math.sin(i * 0.3) * 0.1;
        b = 0.25;
      } else if (dot > 0.05) {
        const t = Math.min(1.0, dot * 1.3);
        if (t < 0.5) {
          r = 0.1 + (t / 0.5) * 0.8;
          g = 0.7 + (t / 0.5) * 0.2;
          b = 0.1;
        } else {
          r = 0.9 + (t - 0.5) * 0.2;
          g = 0.9 - (t - 0.5) * 0.8;
          b = 0.05;
        }
      } else {
        const suction = Math.min(1.0, Math.abs(dot) * 1.5);
        r = 0.02;
        g = 0.5 + (1.0 - suction) * 0.4;
        b = 0.95;
      }

      const cIdx = i * 3;
      colArr[cIdx] = r;
      colArr[cIdx + 1] = g;
      colArr[cIdx + 2] = b;
    }

    colorAttr.needsUpdate = true;

    if (!mesh.userData.heatmapMaterial) {
      mesh.userData.heatmapMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.3,
        metalness: 0.2,
        side: THREE.DoubleSide,
      });
    }
    mesh.material = mesh.userData.heatmapMaterial;
  });
}

/**
 * Restores original PBR materials on the GLB mesh
 */
export function restoreOriginalGlbMaterials(root: THREE.Group): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.userData.originalMaterial) {
        mesh.material = mesh.userData.originalMaterial;
      }
    }
  });
}

/**
 * Applies wireframe shading to the GLB mesh
 */
export function applyWireframeShading(root: THREE.Group, enabled: boolean): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        mat.forEach((m) => {
          if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = enabled;
        });
      } else if (mat && 'wireframe' in mat) {
        (mat as THREE.MeshStandardMaterial).wireframe = enabled;
      }
    }
  });
}

const configureArrowOverlay = (arrow: THREE.ArrowHelper, renderOrder: number) => {
  const lineMat = arrow.line.material as THREE.LineBasicMaterial;
  const coneMat = arrow.cone.material as THREE.MeshBasicMaterial;
  lineMat.transparent = true;
  lineMat.opacity = 0.92;
  lineMat.depthTest = false;
  coneMat.transparent = true;
  coneMat.opacity = 0.94;
  coneMat.depthTest = false;
  arrow.renderOrder = renderOrder;
};

export interface ForceVectorOptions {
  cl?: number;
  cd?: number;
}

/**
 * Creates 3D Force Vectors (Lift, Drag, Resultant, Center of Pressure)
 */
export function createAeroForceVectorsGroup(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'AeroForceVectors';

  // 1. Lift Vector (Emerald Green arrow, points +Y or -Y)
  const liftArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    3.5,
    0x10b981,
    0.58,
    0.34
  );
  liftArrow.name = 'liftArrow';
  configureArrowOverlay(liftArrow, 25);
  group.add(liftArrow);

  // 2. Drag Vector (Crimson Red arrow, points +X downstream)
  const dragArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    2.0,
    0xef4444,
    0.5,
    0.29
  );
  dragArrow.name = 'dragArrow';
  configureArrowOverlay(dragArrow, 25);
  group.add(dragArrow);

  // 3. Resultant Aerodynamic Force Vector (Azure Cyan arrow)
  const resultantArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0.3, 0.95, 0).normalize(),
    new THREE.Vector3(0, 0, 0),
    4.0,
    0x00f0ff,
    0.6,
    0.35
  );
  resultantArrow.name = 'resultantArrow';
  configureArrowOverlay(resultantArrow, 26);
  group.add(resultantArrow);

  // 4. Center of Pressure (CP) Target Ring
  const cpRingGeo = new THREE.RingGeometry(0.28, 0.38, 32);
  cpRingGeo.rotateX(Math.PI / 2);
  const cpRingMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const cpRing = new THREE.Mesh(cpRingGeo, cpRingMat);
  cpRing.name = 'cpRing';
  cpRing.renderOrder = 24;
  group.add(cpRing);

  return group;
}

/**
 * Updates 3D Force Vectors proportionally to live calculated force magnitudes (|L|, |D|, |R|).
 * Suppresses the Lift arrow completely when |L| < 0.05 kN (50 N) or |CL| < 0.002,
 * and inverts it downward (-Y) when L < 0.
 */
export function updateAeroForceVectors(
  group: THREE.Group,
  lift_N: number,
  drag_N: number,
  aoaDeg: number,
  visible = true,
  options?: ForceVectorOptions
): void {
  group.visible = visible;
  if (!visible) return;

  const liftArrow = group.getObjectByName('liftArrow') as THREE.ArrowHelper | undefined;
  const dragArrow = group.getObjectByName('dragArrow') as THREE.ArrowHelper | undefined;
  const resultantArrow = group.getObjectByName('resultantArrow') as THREE.ArrowHelper | undefined;
  const cpRing = group.getObjectByName('cpRing') as THREE.Mesh | undefined;

  const absLift = Math.abs(lift_N);
  const absDrag = Math.abs(drag_N);
  const clSmall = options?.cl !== undefined && Math.abs(options.cl) < 0.002;
  const isZeroLift = absLift < 50 || clSmall;

  const effectiveLift = isZeroLift ? 0 : lift_N;
  const absEffLift = Math.abs(effectiveLift);
  const effectiveDrag = absDrag < 1 ? 0 : absDrag;
  const resultantForce = Math.hypot(absEffLift, effectiveDrag);

  if (resultantForce < 1) {
    if (liftArrow) liftArrow.visible = false;
    if (dragArrow) dragArrow.visible = false;
    if (resultantArrow) resultantArrow.visible = false;
  } else {
    // Smoothly map |R| across micro airfoils (~0.2 kN) to heavy jets (~1500+ kN)
    // while strictly preserving vector triangle proportionality L : D : R.
    const totalVisualLen = Math.min(6.4, Math.max(0.45, 1.15 * Math.pow(resultantForce / 1000, 0.23)));
    const scale = totalVisualLen / resultantForce;
    const liftMagnitude = absEffLift * scale;
    const dragMagnitude = effectiveDrag * scale;
    const liftSign = effectiveLift >= 0 ? 1 : -1;

    if (liftArrow) {
      if (isZeroLift || liftMagnitude < 0.04) {
        liftArrow.visible = false;
      } else {
        liftArrow.visible = true;
        const headLen = Math.min(0.58, liftMagnitude * 0.34);
        const headWid = headLen * 0.58;
        liftArrow.setDirection(new THREE.Vector3(0, liftSign, 0));
        liftArrow.setLength(liftMagnitude, headLen, headWid);
      }
    }

    if (dragArrow) {
      if (dragMagnitude < 0.04) {
        dragArrow.visible = false;
      } else {
        dragArrow.visible = true;
        const headLen = Math.min(0.5, dragMagnitude * 0.36);
        const headWid = headLen * 0.58;
        dragArrow.setDirection(new THREE.Vector3(1, 0, 0));
        dragArrow.setLength(dragMagnitude, headLen, headWid);
      }
    }

    if (resultantArrow) {
      // When Lift is zero, Resultant equals Drag (avoid overlapping dragArrow)
      if (isZeroLift || liftMagnitude < 0.04) {
        resultantArrow.visible = false;
      } else {
        resultantArrow.visible = true;
        const resultantDir = new THREE.Vector3(dragMagnitude, liftMagnitude * liftSign, 0).normalize();
        const resultantLen = Math.hypot(liftMagnitude, dragMagnitude);
        const headLen = Math.min(0.6, resultantLen * 0.34);
        const headWid = headLen * 0.58;
        resultantArrow.setDirection(resultantDir);
        resultantArrow.setLength(resultantLen, headLen, headWid);
      }
    }
  }

  if (cpRing) {
    // Dynamic Center of Pressure shifts forward with increasing AoA
    const cpShiftX = -0.5 - (aoaDeg * 0.04);
    cpRing.position.set(cpShiftX, 0, 0);
  }
}

