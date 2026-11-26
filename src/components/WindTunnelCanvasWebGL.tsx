import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SimulationParams, AeroTelemetry } from '../types/aerodynamics';
import { AIRCRAFT_MODELS } from '../utils/airfoilGenerators';
import { getAircraft3DModel } from '../utils/aircraft3DGeometry';
import {
  loadGlbAircraftModel,
  GLB_MODEL_REGISTRY,
  applyCfdPressureHeatmap,
  restoreOriginalGlbMaterials,
  applyWireframeShading,
  createAeroForceVectorsGroup,
  updateAeroForceVectors,
  normalizeAircraftGroupToTunnel,
  disposeThreeGroupResources,
} from '../utils/aircraftGlbModels';
import {
  DEFAULT_LAYER_GAP,
  FluidDynamics3D,
  Fluid3DParams,
  MAX_UNIFIED_FILAMENTS,
  ModelBoundingBox,
  SmokeRakeSeed,
  Velocity3DResult,
} from '../engine/FluidDynamics3D';
import { MeshBvhCollider } from '../engine/MeshBvhCollider';
import { AircraftSurfaceField } from '../engine/AircraftSurfaceField';
import { AeroCalibration, formatModelClassLabel } from '../lib/calibration';
import { CustomGlbAsset, buildOrientedCustomGlbRoot } from './GlbUploader';
import { windTunnelAudio } from '../utils/audio';
import { createSafeWebGLRenderer } from '../utils/webglSupport';
import {
  Warning,
  SpeakerHigh,
  SpeakerSlash,
  Cube,
  Camera,
  ArrowsClockwise,
} from '@phosphor-icons/react';

interface WindTunnelCanvasWebGLProps {
  params: SimulationParams;
  onParamChange: <K extends keyof SimulationParams>(key: K, value: SimulationParams[K]) => void;
  telemetry: AeroTelemetry;
  isPaused: boolean;
  onFallbackToCanvas?: () => void;
  onOpenModelInspector?: () => void;
  customGlbAsset?: CustomGlbAsset | null;
}

function applyCachedXrayMaterial(root: THREE.Group): void {
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.userData.originalMaterial) {
        mesh.userData.originalMaterial = mesh.material;
      }
      if (!mesh.userData.xrayMaterial) {
        mesh.userData.xrayMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.35,
          roughness: 0.15,
          metalness: 0.75,
        });
      }
      mesh.material = mesh.userData.xrayMaterial as THREE.Material;
    }
  });
}

interface FilamentNode {
  x: number;
  y: number;
  z: number;
  speed: number;
  cp: number;
  vorticity: number;
  isSeparated: boolean;
}

interface UnsteadyFilamentState {
  seed: SmokeRakeSeed;
  nodes: FilamentNode[];
}

const MAX_FILAMENTS = MAX_UNIFIED_FILAMENTS; // 200
const MAX_NODES_PER_FILAMENT = 160;
const MAX_SMOKE_VERTS = MAX_FILAMENTS * MAX_NODES_PER_FILAMENT * 2;
const MAX_SMOKE_INDICES = MAX_FILAMENTS * (MAX_NODES_PER_FILAMENT - 1) * 6;
const MAX_PIV_PARTICLES = 1200;

// Pre-allocated scratch helpers for zero-GC 60fps animation loops & centripetal Catmull-Rom smoothing
const _scratchPos = { x: 0, y: 0, z: 0 };
const _scratchVel: Velocity3DResult = {
  u: 1,
  v: 0,
  w: 0,
  speed: 1,
  cpIncompressible: 0,
  pressureCoeff: 0,
  pressureCoeffClamped: 0,
  vorticity: 0,
  isSeparated: false,
};
const _catmullControlPool: THREE.Vector3[] = Array.from(
  { length: MAX_NODES_PER_FILAMENT },
  () => new THREE.Vector3()
);
const _catmullCurve = new THREE.CatmullRomCurve3([], false, 'centripetal');
const _catmullEvalPt = new THREE.Vector3();
const _smoothedNodesBuf: FilamentNode[] = Array.from(
  { length: MAX_NODES_PER_FILAMENT },
  () => ({
    x: 0,
    y: 0,
    z: 0,
    speed: 1,
    cp: 0,
    vorticity: 0,
    isSeparated: false,
  })
);
const _boxBoundsTmp = new THREE.Box3();
const _boxCenterTmp = new THREE.Vector3();
const _boxSizeTmp = new THREE.Vector3();

function computeFlowColorRGB(
  cpClamped: number,
  vorticity: number,
  isSeparated: boolean,
  role: SmokeRakeSeed['role'] | 'piv',
  outRgb: [number, number, number]
): void {
  if (isSeparated) {
    // Separated turbulent wake: warm coral-crimson
    outRgb[0] = 0.96;
    outRgb[1] = 0.34;
    outRgb[2] = 0.30;
    return;
  }
  if (role === 'tip' || vorticity > 1.35) {
    // Wingtip / strong vortex core: luminous sky cyan
    outRgb[0] = 0.28;
    outRgb[1] = 0.84;
    outRgb[2] = 0.99;
    return;
  }
  if (cpClamped < -0.25) {
    // Suction acceleration crest: vivid electric cyan-azure
    const t = Math.min(1, (-cpClamped - 0.25) / 1.4);
    outRgb[0] = 0.72 - 0.50 * t;
    outRgb[1] = 0.92 - 0.08 * t;
    outRgb[2] = 1.0;
    return;
  }
  if (cpClamped > 0.22) {
    // Forward stagnation compression: warm amber-gold
    const t = Math.min(1, (cpClamped - 0.22) / 0.78);
    outRgb[0] = 0.94 + 0.05 * t;
    outRgb[1] = 0.85 - 0.24 * t;
    outRgb[2] = 0.70 - 0.52 * t;
    return;
  }
  if (role === 'piv') {
    outRgb[0] = 0.52;
    outRgb[1] = 0.88;
    outRgb[2] = 0.98;
    return;
  }
  // Attached freestream smoke core: clean icy white-blue
  outRgb[0] = 0.82;
  outRgb[1] = 0.93;
  outRgb[2] = 1.0;
}

const _tmpRgb: [number, number, number] = [0.85, 0.94, 1.0];

function createSmokeRibbonShaderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlowSpeed: { value: 2.2 },
      uSmokeDensity: { value: 0.8 },
    },
    vertexShader: `
      attribute vec3 aTangent;
      attribute float aSide;
      attribute vec3 aColor;
      attribute vec4 aParams;

      varying float vCross;
      varying float vArcDist;
      varying float vUFrac;
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        vCross = aSide;
        vArcDist = aParams.x;
        vUFrac = aParams.y;
        vAlpha = aParams.w;
        vColor = aColor;

        vec3 viewDir = normalize(cameraPosition - position);
        vec3 tanDir = normalize(aTangent);
        vec3 sideDir = cross(tanDir, viewDir);
        float sLen = length(sideDir);
        if (sLen < 0.001) {
          sideDir = normalize(cross(tanDir, vec3(0.0, 1.0, 0.001)));
        } else {
          sideDir /= sLen;
        }

        vec3 worldPos = position + sideDir * (aSide * aParams.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uFlowSpeed;
      uniform float uSmokeDensity;

      varying float vCross;
      varying float vArcDist;
      varying float vUFrac;
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        float radial = exp(-vCross * vCross * 4.2);
        float endFade = smoothstep(0.0, 0.055, vUFrac) * (1.0 - smoothstep(0.84, 1.0, vUFrac));
        float wavePhase = vArcDist * 1.45 - uTime * uFlowSpeed;
        float wisps = 0.72 + 0.28 * (0.65 * sin(wavePhase) + 0.35 * sin(wavePhase * 2.3 + 1.1));
        vec3 finalCol = mix(vColor, vec3(0.96, 0.99, 1.0), radial * 0.32);
        float alpha = radial * endFade * wisps * vAlpha * uSmokeDensity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(finalCol, clamp(alpha, 0.0, 0.85));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function createPivParticleShaderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 0.9 },
    },
    vertexShader: `
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = aAlpha;
        vColor = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        float a = vAlpha * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, clamp(a, 0.0, 0.95));
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

function packSmokeFilamentsToMesh(
  mesh: THREE.Mesh | null,
  filaments: UnsteadyFilamentState[],
  viscosity: number,
  smokeDensity: number
): void {
  if (!mesh) return;
  const geo = mesh.geometry;
  const posArr = (geo.attributes.position as THREE.BufferAttribute).array as Float32Array;
  const tanArr = (geo.attributes.aTangent as THREE.BufferAttribute).array as Float32Array;
  const sideArr = (geo.attributes.aSide as THREE.BufferAttribute).array as Float32Array;
  const colArr = (geo.attributes.aColor as THREE.BufferAttribute).array as Float32Array;
  const paramArr = (geo.attributes.aParams as THREE.BufferAttribute).array as Float32Array;
  const idxArr = geo.index!.array as Uint32Array;

  let vOffset = 0;
  let iOffset = 0;
  const densityScale = 0.65 + 0.45 * Math.max(0.25, Math.min(1.5, smokeDensity));

  const fCount = Math.min(MAX_FILAMENTS, filaments.length);
  for (let f = 0; f < fCount; f++) {
    const fil = filaments[f];
    const rawNodes = fil.nodes;
    const rawLen = Math.min(MAX_NODES_PER_FILAMENT, rawNodes.length);
    if (rawLen < 2) continue;

    // Smooth filament centerline via centripetal THREE.CatmullRomCurve3 (zero-GC pre-allocated buffers)
    const ctrlPts = _catmullCurve.points;
    ctrlPts.length = 0;
    let prevX = Infinity;
    let prevY = Infinity;
    let prevZ = Infinity;
    for (let j = 0; j < rawLen; j++) {
      const rn = rawNodes[j];
      if (j === 0 || Math.hypot(rn.x - prevX, rn.y - prevY, rn.z - prevZ) > 1e-3) {
        const pv = _catmullControlPool[ctrlPts.length];
        pv.set(rn.x, rn.y, rn.z);
        ctrlPts.push(pv);
        prevX = rn.x;
        prevY = rn.y;
        prevZ = rn.z;
      }
    }

    let nodes: FilamentNode[];
    let nCount: number;
    if (ctrlPts.length >= 4) {
      nCount = Math.min(MAX_NODES_PER_FILAMENT, Math.max(ctrlPts.length, Math.round(ctrlPts.length * 1.15)));
      const lastRawIdx = rawLen - 1;
      for (let j = 0; j < nCount; j++) {
        const uFrac = j / (nCount - 1);
        _catmullCurve.getPoint(uFrac, _catmullEvalPt);

        const fIdx = uFrac * lastRawIdx;
        const i0 = Math.min(lastRawIdx, Math.floor(fIdx));
        const i1 = Math.min(lastRawIdx, i0 + 1);
        const alpha = fIdx - i0;
        const aNode = rawNodes[i0];
        const bNode = rawNodes[i1];

        const dst = _smoothedNodesBuf[j];
        dst.x = _catmullEvalPt.x;
        dst.y = _catmullEvalPt.y;
        dst.z = _catmullEvalPt.z;
        dst.speed = aNode.speed + (bNode.speed - aNode.speed) * alpha;
        dst.cp = aNode.cp + (bNode.cp - aNode.cp) * alpha;
        dst.vorticity = aNode.vorticity + (bNode.vorticity - aNode.vorticity) * alpha;
        dst.isSeparated = alpha < 0.5 ? aNode.isSeparated : bNode.isSeparated;
      }
      nodes = _smoothedNodesBuf;
    } else {
      nodes = rawNodes;
      nCount = rawLen;
    }

    const baseVert = vOffset;
    let arcDist = 0;
    for (let j = 0; j < nCount; j++) {
      const cur = nodes[j];
      const prev = j > 0 ? nodes[j - 1] : cur;
      const next = j < nCount - 1 ? nodes[j + 1] : cur;
      if (j > 0) {
        arcDist += Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
      }

      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      let tz = next.z - prev.z;
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;

      computeFlowColorRGB(cur.cp, cur.vorticity, cur.isSeparated, fil.seed.role, _tmpRgb);

      // Mass-conservation narrowing where speed accelerates + downstream wake diffusion
      const speedRatio = Math.max(0.45, Math.min(2.2, cur.speed / 1.2));
      const wakeSpread = Math.sqrt(1 + 0.075 * arcDist * (0.4 + viscosity * 2.2));
      const roleWidth = fil.seed.role === 'tip' ? 0.042 : 0.052;
      const halfWidth =
        (roleWidth * wakeSpread * densityScale) / Math.pow(speedRatio, 0.35) +
        Math.min(0.025, cur.vorticity * 0.008);

      const uFrac = j / (nCount - 1);
      const roleAlpha = fil.seed.role === 'tip' ? 0.88 : 0.72;
      const wakeAtten = 1.0 / (1.0 + 0.028 * arcDist * (0.3 + viscosity));
      const localAlpha = roleAlpha * wakeAtten;

      for (const side of [-1, 1]) {
        const p3 = vOffset * 3;
        const p4 = vOffset * 4;
        posArr[p3] = cur.x;
        posArr[p3 + 1] = cur.y;
        posArr[p3 + 2] = cur.z;

        tanArr[p3] = tx;
        tanArr[p3 + 1] = ty;
        tanArr[p3 + 2] = tz;

        sideArr[vOffset] = side;

        colArr[p3] = _tmpRgb[0];
        colArr[p3 + 1] = _tmpRgb[1];
        colArr[p3 + 2] = _tmpRgb[2];

        paramArr[p4] = arcDist;
        paramArr[p4 + 1] = uFrac;
        paramArr[p4 + 2] = halfWidth;
        paramArr[p4 + 3] = localAlpha;

        vOffset++;
      }

      if (j < nCount - 1) {
        const a = baseVert + j * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        idxArr[iOffset++] = a;
        idxArr[iOffset++] = b;
        idxArr[iOffset++] = c;
        idxArr[iOffset++] = b;
        idxArr[iOffset++] = d;
        idxArr[iOffset++] = c;
      }
    }
  }

  (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  (geo.attributes.aTangent as THREE.BufferAttribute).needsUpdate = true;
  (geo.attributes.aSide as THREE.BufferAttribute).needsUpdate = true;
  (geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
  (geo.attributes.aParams as THREE.BufferAttribute).needsUpdate = true;
  geo.index!.needsUpdate = true;
  geo.setDrawRange(0, iOffset);
}

export const WindTunnelCanvasWebGL: React.FC<WindTunnelCanvasWebGLProps> = ({
  params,
  onParamChange,
  telemetry,
  isPaused,
  onFallbackToCanvas,
  onOpenModelInspector,
  customGlbAsset = null,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Live state refs
  const customGlbAssetRef = useRef<CustomGlbAsset | null>(customGlbAsset);
  customGlbAssetRef.current = customGlbAsset;
  const activeCalibrationRef = useRef<AeroCalibration | null>(
    params.modelType === 'custom_glb' && customGlbAsset ? customGlbAsset.calibration : null
  );
  activeCalibrationRef.current =
    params.modelType === 'custom_glb' && customGlbAsset ? customGlbAsset.calibration : null;
  const surfaceFieldRef = useRef<AircraftSurfaceField | null>(null);
  const bvhColliderRef = useRef<MeshBvhCollider | null>(null);

  // Model & Simulation Roots
  const aircraftGroupRef = useRef<THREE.Group | null>(null);
  const glbRootRef = useRef<THREE.Group | null>(null);
  const isGlbCustomRef = useRef<boolean>(false);
  const proceduralMeshRef = useRef<THREE.Group | null>(null);
  const quiverGroupRef = useRef<THREE.Group | null>(null);
  const smokeRibbonMeshRef = useRef<THREE.Mesh | null>(null);
  const smokeShaderMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const smokeFilamentsRef = useRef<UnsteadyFilamentState[]>([]);
  const smokeUnsteadyRef = useRef<boolean>(false);
  const pivLinesRef = useRef<THREE.LineSegments | null>(null);
  const pivShaderMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const pivStateRef = useRef<{
    count: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    age: Float32Array;
    innerFlag: Uint8Array;
  }>({
    count: 0,
    x: new Float32Array(MAX_PIV_PARTICLES),
    y: new Float32Array(MAX_PIV_PARTICLES),
    z: new Float32Array(MAX_PIV_PARTICLES),
    age: new Float32Array(MAX_PIV_PARTICLES),
    innerFlag: new Uint8Array(MAX_PIV_PARTICLES),
  });

  const machConeMeshRef = useRef<THREE.Mesh | null>(null);
  const forceVectorsGroupRef = useRef<THREE.Group | null>(null);
  const afterburnerGroupRef = useRef<THREE.Group | null>(null);
  const bodyAnnotationsGroupRef = useRef<THREE.Group | null>(null);
  const worldAnnotationsGroupRef = useRef<THREE.Group | null>(null);

  // Live prop refs for zero-rebind 60fps loop
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const telemetryRef = useRef(telemetry);
  telemetryRef.current = telemetry;
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  const simTimeRef = useRef<number>(0);

  // UI state
  const [activePreset, setActivePreset] = useState<'iso' | 'side' | 'top' | 'front' | 'chase'>('iso');
  const [isAutoOrbit, setIsAutoOrbit] = useState<boolean>(false);
  const isAutoOrbitRef = useRef<boolean>(false);
  isAutoOrbitRef.current = isAutoOrbit;
  const onFallbackRef = useRef(onFallbackToCanvas);
  onFallbackRef.current = onFallbackToCanvas;
  const [webglUnavailable, setWebglUnavailable] = useState<boolean>(false);
  const [modelLoading, setModelLoading] = useState<boolean>(true);
  const [loadProgress, setLoadProgress] = useState<number>(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeShading, setActiveShading] = useState<'pbr' | 'wireframe' | 'cfdHeatmap' | 'xray'>('pbr');
  const [surfaceVersion, setSurfaceVersion] = useState<number>(0);

  // Sync Audio with simulation speed & stall
  useEffect(() => {
    if (params.audio_enabled) {
      windTunnelAudio.start();
      windTunnelAudio.update(params.airspeed_kts, telemetry.mach, telemetry.isStalled);
    } else {
      windTunnelAudio.stop();
    }
  }, [params.audio_enabled, params.airspeed_kts, telemetry.mach, telemetry.isStalled]);

  // Main Three.js Scene Initialization
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth || 900;
    const height = mount.clientHeight || 560;

    // 1. Scene (--dark: #0D1114)
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x0d1114);
    scene.fog = new THREE.FogExp2(0x0d1114, 0.011);

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 400);
    camera.position.set(-15, 7.5, 15);
    cameraRef.current = camera;

    // 3. Renderer (safely probed)
    const renderer = createSafeWebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    if (!renderer) {
      setWebglUnavailable(true);
      setModelLoading(false);
      onFallbackRef.current?.();
      return;
    }

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Studio IBL environment for crisp metallic PBR reflections
    let envTex: THREE.Texture | null = null;
    try {
      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTex;
      pmremGenerator.dispose();
    } catch {
      // Fallback gracefully if PMREM fails on constrained drivers
    }

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      setWebglUnavailable(true);
      onFallbackRef.current?.();
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost, false);

    // 4. OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxDistance = 50;
    controls.minDistance = 3.5;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // 5. Studio 3-Point + Hemisphere Lighting Rig
    const hemi = new THREE.HemisphereLight(0xe8f3fa, 0x151a1e, 0.85);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-16, 22, 16);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0x38bdf8, 1.4);
    rim.position.set(18, -8, -14);
    scene.add(rim);

    // 6. Chamber Floor Grid (--dark-surface & --accent)
    const gridFloor = new THREE.GridHelper(36, 36, 0x1769aa, 0x1e2730);
    gridFloor.position.y = -4.5;
    scene.add(gridFloor);

    // Lateral rails
    const railMat = new THREE.LineBasicMaterial({ color: 0x1769aa, transparent: true, opacity: 0.4 });
    for (const rz of [-8, 8]) {
      const railGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-18, -4.5, rz),
        new THREE.Vector3(18, -4.5, rz),
      ]);
      scene.add(new THREE.Line(railGeo, railMat));
    }

    // 7. Aircraft Root Group
    const aircraftGroup = new THREE.Group();
    aircraftGroup.name = 'AircraftGroup';
    scene.add(aircraftGroup);
    aircraftGroupRef.current = aircraftGroup;

    // Afterburner exhaust group
    const abGroup = new THREE.Group();
    aircraftGroup.add(abGroup);
    afterburnerGroupRef.current = abGroup;

    for (const zOff of [-0.67, 0.67]) {
      const coneGeo = new THREE.ConeGeometry(0.32, 2.4, 16);
      coneGeo.rotateZ(-Math.PI / 2);
      const flameMat = new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.85 });
      const flameMesh = new THREE.Mesh(coneGeo, flameMat);
      flameMesh.position.set(6.8 + 1.2, -0.38, zOff);
      abGroup.add(flameMesh);

      const flameLight = new THREE.PointLight(0xf97316, 2.0, 8);
      flameLight.position.set(6.8, -0.38, zOff);
      abGroup.add(flameLight);
    }
    abGroup.visible = false;

    // 8. Vector Quiver Group
    const quiverGroup = new THREE.Group();
    scene.add(quiverGroup);
    quiverGroupRef.current = quiverGroup;

    // 9. Volumetric Billboarded Smoke Streamlines / Streaklines Ribbon Mesh
    const smokeGeo = new THREE.BufferGeometry();
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE_VERTS * 3), 3));
    smokeGeo.setAttribute('aTangent', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE_VERTS * 3), 3));
    smokeGeo.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE_VERTS), 1));
    smokeGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE_VERTS * 3), 3));
    smokeGeo.setAttribute('aParams', new THREE.BufferAttribute(new Float32Array(MAX_SMOKE_VERTS * 4), 4));
    smokeGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_SMOKE_INDICES), 1));
    smokeGeo.setDrawRange(0, 0);

    const smokeMat = createSmokeRibbonShaderMaterial();
    smokeShaderMatRef.current = smokeMat;
    const smokeMesh = new THREE.Mesh(smokeGeo, smokeMat);
    smokeMesh.frustumCulled = false;
    smokeMesh.renderOrder = 10;
    smokeMesh.visible = false;
    scene.add(smokeMesh);
    smokeRibbonMeshRef.current = smokeMesh;

    // 10. Lagrangian PIV Tracer Particle Streaks
    const pivGeo = new THREE.BufferGeometry();
    pivGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PIV_PARTICLES * 2 * 3), 3));
    pivGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX_PIV_PARTICLES * 2), 1));
    pivGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_PIV_PARTICLES * 2 * 3), 3));
    pivGeo.setDrawRange(0, 0);

    const pivMat = createPivParticleShaderMaterial();
    pivShaderMatRef.current = pivMat;
    const pivLines = new THREE.LineSegments(pivGeo, pivMat);
    pivLines.frustumCulled = false;
    pivLines.renderOrder = 11;
    pivLines.visible = false;
    scene.add(pivLines);
    pivLinesRef.current = pivLines;

    // 11. Supersonic Mach Shockwave Cone
    const coneGeo = new THREE.ConeGeometry(6.0, 16.0, 32, 1, true);
    coneGeo.rotateZ(Math.PI / 2);
    coneGeo.translate(8.0 - 6.7, 0, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
      wireframe: true,
      side: THREE.DoubleSide,
    });
    const machConeMesh = new THREE.Mesh(coneGeo, coneMat);
    machConeMesh.visible = false;
    scene.add(machConeMesh);
    machConeMeshRef.current = machConeMesh;

    // 12. Aerodynamic 3D Force Vectors
    const forceGroup = createAeroForceVectorsGroup();
    scene.add(forceGroup);
    forceVectorsGroupRef.current = forceGroup;

    // 12b. Phase 4 Engineering Annotations (Body-fixed chord markers + World-space downwash/trailing filaments)
    const bodyAnnGroup = new THREE.Group();
    bodyAnnGroup.name = 'BodyEngineeringAnnotations';
    aircraftGroup.add(bodyAnnGroup);
    bodyAnnotationsGroupRef.current = bodyAnnGroup;

    const worldAnnGroup = new THREE.Group();
    worldAnnGroup.name = 'WorldEngineeringAnnotations';
    scene.add(worldAnnGroup);
    worldAnnotationsGroupRef.current = worldAnnGroup;

    // 13. 60fps Render Loop
    let lastPerf = performance.now();
    const animate = () => {
      animFrameIdRef.current = requestAnimationFrame(animate);

      const now = performance.now();
      const dtReal = Math.min(0.05, Math.max(0.001, (now - lastPerf) * 0.001));
      lastPerf = now;

      const curParams = paramsRef.current;
      const curTelemetry = telemetryRef.current;
      const paused = isPausedRef.current;
      const sf = surfaceFieldRef.current;

      if (!paused) {
        simTimeRef.current += dtReal;
      }

      if (isAutoOrbitRef.current && controlsRef.current) {
        controlsRef.current.autoRotate = true;
        controlsRef.current.autoRotateSpeed = 1.2;
      } else if (controlsRef.current) {
        controlsRef.current.autoRotate = false;
      }

      if (machConeMeshRef.current && machConeMeshRef.current.visible) {
        const pulse = 1.0 + Math.sin(now * 0.008) * 0.035;
        machConeMeshRef.current.scale.set(pulse, pulse, pulse);
      }

      const needsFlowEval = curParams.show_streamlines || curParams.show_particles;
      const vInfTunnel = Math.max(0.4, ((curParams.airspeed_kts * 0.514444) / 180.0554) * 1.2);
      const frame = needsFlowEval
        ? FluidDynamics3D.getDynamicEmitterFrame(
            sf,
            curParams.rake_spread ?? 1.0,
            curParams.streamline_resolution ?? 1.0
          )
        : null;
      const fluidParamsLive: Fluid3DParams | null = needsFlowEval
        ? {
            modelType: curParams.modelType,
            aoaDeg: curParams.angle_of_attack,
            airspeed_kts: curParams.airspeed_kts,
            mach: curTelemetry.mach,
            altitude_ft: curParams.altitude_ft,
            flapsDeg: curParams.flaps_deg,
            viscosity: curParams.viscosity,
            isStalled: curTelemetry.isStalled,
            cl: curTelemetry.cl,
            cd: curTelemetry.cd,
            timeSec: simTimeRef.current,
            streamlineResolution: curParams.streamline_resolution ?? 1.0,
            surfaceField: sf,
            bvhCollider: bvhColliderRef.current,
            calibration: activeCalibrationRef.current,
          }
        : null;

      // Update Volumetric Smoke Streamlines / Unsteady Streaklines
      if (smokeShaderMatRef.current && smokeRibbonMeshRef.current) {
        smokeRibbonMeshRef.current.visible = curParams.show_streamlines;
        if (curParams.show_streamlines && frame && fluidParamsLive) {
          smokeShaderMatRef.current.uniforms.uTime.value = simTimeRef.current;
          smokeShaderMatRef.current.uniforms.uFlowSpeed.value = Math.min(7.5, Math.max(1.2, vInfTunnel * 2.5));
          smokeShaderMatRef.current.uniforms.uSmokeDensity.value = Math.min(
            1.15,
            0.35 + curParams.smoke_density * 0.55
          );

          // In unsteady wake regimes (cylinder von Kármán street, stall, bluff body), advect live streaklines
          if (smokeUnsteadyRef.current && !paused && smokeFilamentsRef.current.length > 0) {
            const nodeSpacing = Math.max(0.18, 0.24 / (curParams.streamline_resolution ?? 1.0));
            const dtStep = Math.min(0.045, dtReal * 1.45);
            for (let f = 0; f < smokeFilamentsRef.current.length; f++) {
              const fil = smokeFilamentsRef.current[f];
              const nodes = fil.nodes;
              for (let j = 0; j < nodes.length; j++) {
                const nd = nodes[j];
                FluidDynamics3D.stepParticleRK2(
                  nd.x,
                  nd.y,
                  nd.z,
                  fluidParamsLive,
                  dtStep,
                  frame.dsMax,
                  _scratchPos,
                  _scratchVel
                );
                nd.x = _scratchPos.x;
                nd.y = _scratchPos.y;
                nd.z = _scratchPos.z;
                nd.speed = _scratchVel.speed;
                nd.cp = _scratchVel.pressureCoeffClamped;
                nd.vorticity = _scratchVel.vorticity;
                nd.isSeparated = _scratchVel.isSeparated;
              }
              if (nodes.length > 0) {
                const head = nodes[0];
                const distFromNozzle = Math.hypot(
                  head.x - fil.seed.x,
                  head.y - fil.seed.y,
                  head.z - fil.seed.z
                );
                if (distFromNozzle >= nodeSpacing) {
                  const vSeed = FluidDynamics3D.getVelocity(fil.seed, fluidParamsLive);
                  nodes.unshift({
                    x: fil.seed.x,
                    y: fil.seed.y,
                    z: fil.seed.z,
                    speed: vSeed.speed,
                    cp: vSeed.pressureCoeffClamped,
                    vorticity: vSeed.vorticity,
                    isSeparated: vSeed.isSeparated,
                  });
                  if (nodes.length > MAX_NODES_PER_FILAMENT) {
                    nodes.pop();
                  }
                }
                while (nodes.length > 10 && nodes[nodes.length - 1].x > frame.xRecycle + 4) {
                  nodes.pop();
                }
              }
            }
            packSmokeFilamentsToMesh(
              smokeRibbonMeshRef.current,
              smokeFilamentsRef.current,
              curParams.viscosity,
              curParams.smoke_density
            );
          }
        }
      }

      // Update Lagrangian PIV Tracer Particles
      if (pivLinesRef.current && pivShaderMatRef.current) {
        pivLinesRef.current.visible = curParams.show_particles;
        if (curParams.show_particles && pivStateRef.current.count > 0 && frame && fluidParamsLive) {
          const pState = pivStateRef.current;
          const activeCount = pState.count;
          const geo = pivLinesRef.current.geometry;
          const posAttr = geo.attributes.position as THREE.BufferAttribute;
          const alphaAttr = geo.attributes.aAlpha as THREE.BufferAttribute;
          const colAttr = geo.attributes.aColor as THREE.BufferAttribute;
          const posArr = posAttr.array as Float32Array;
          const alphaArr = alphaAttr.array as Float32Array;
          const colArr = colAttr.array as Float32Array;

          pivShaderMatRef.current.uniforms.uOpacity.value = Math.min(
            1.0,
            0.48 + curParams.smoke_density * 0.42
          );

          const dtPiv = paused ? 0 : Math.min(0.04, dtReal * 1.35);
          const streakScale = 0.085 + 0.045 * Math.min(2.2, vInfTunnel / 1.2);
          const spanTotal = Math.max(4.0, frame.xRecycle - frame.xSpawn);

          for (let i = 0; i < activeCount; i++) {
            let px = pState.x[i];
            let py = pState.y[i];
            let pz = pState.z[i];

            if (!paused) {
              FluidDynamics3D.stepParticleRK2(
                px,
                py,
                pz,
                fluidParamsLive,
                dtPiv,
                frame.dsMax,
                _scratchPos,
                _scratchVel
              );
              px = _scratchPos.x;
              py = _scratchPos.y;
              pz = _scratchPos.z;
              pState.age[i] += dtPiv;
            } else {
              const vNow = FluidDynamics3D.getVelocity({ x: px, y: py, z: pz }, fluidParamsLive);
              _scratchVel.u = vNow.u;
              _scratchVel.v = vNow.v;
              _scratchVel.w = vNow.w;
              _scratchVel.speed = vNow.speed;
              _scratchVel.pressureCoeffClamped = vNow.pressureCoeffClamped;
              _scratchVel.vorticity = vNow.vorticity;
              _scratchVel.isSeparated = vNow.isSeparated;
            }

            if (
              px > frame.xRecycle ||
              px < frame.xSpawn - 2.0 ||
              Math.abs(py - frame.yMid) > frame.yHalf * 2.8 ||
              Math.abs(pz) > frame.zHalf * 2.2
            ) {
              const isInner = pState.innerFlag[i] === 1;
              const yScale = isInner ? 0.65 : 1.05;
              const zScale = isInner ? 0.72 : 1.05;
              let rx = frame.xSpawn;
              let ry = frame.yMid + (Math.random() * 2 - 1) * frame.yHalf * yScale;
              let rz = (Math.random() * 2 - 1) * frame.zHalf * zScale;
              if (!FluidDynamics3D.isValidEmitterSeed(rx, ry, rz, fluidParamsLive)) {
                ry = frame.yMid + (ry >= frame.yMid ? 1 : -1) * Math.max(0.8, frame.yHalf);
              }
              px = rx;
              py = ry;
              pz = rz;
              pState.age[i] = 0;
            }

            pState.x[i] = px;
            pState.y[i] = py;
            pState.z[i] = pz;

            const tailLen = Math.min(0.95, Math.max(0.08, _scratchVel.speed * streakScale));
            const invS = _scratchVel.speed > 1e-4 ? 1 / _scratchVel.speed : 1;
            const tailX = px - _scratchVel.u * invS * tailLen;
            const tailY = py - _scratchVel.v * invS * tailLen;
            const tailZ = pz - _scratchVel.w * invS * tailLen;

            const lifeIn = Math.min(1.0, Math.max(0.0, (px - frame.xSpawn) / (0.12 * spanTotal)));
            const lifeOut = Math.min(1.0, Math.max(0.0, (frame.xRecycle - px) / (0.15 * spanTotal)));
            const headAlpha = Math.min(lifeIn, lifeOut);

            computeFlowColorRGB(
              _scratchVel.pressureCoeffClamped,
              _scratchVel.vorticity,
              _scratchVel.isSeparated,
              'piv',
              _tmpRgb
            );

            const vTail = i * 2;
            const vHead = vTail + 1;
            posArr[vTail * 3] = tailX;
            posArr[vTail * 3 + 1] = tailY;
            posArr[vTail * 3 + 2] = tailZ;
            posArr[vHead * 3] = px;
            posArr[vHead * 3 + 1] = py;
            posArr[vHead * 3 + 2] = pz;

            alphaArr[vTail] = 0.0;
            alphaArr[vHead] = headAlpha;

            colArr[vTail * 3] = _tmpRgb[0] * 0.6;
            colArr[vTail * 3 + 1] = _tmpRgb[1] * 0.6;
            colArr[vTail * 3 + 2] = _tmpRgb[2] * 0.6;
            colArr[vHead * 3] = _tmpRgb[0];
            colArr[vHead * 3 + 1] = _tmpRgb[1];
            colArr[vHead * 3 + 2] = _tmpRgb[2];
          }

          posAttr.needsUpdate = true;
          alphaAttr.needsUpdate = true;
          colAttr.needsUpdate = true;
          geo.setDrawRange(0, activeCount * 2);
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!mount || !renderer || !camera) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    handleResize();
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost, false);
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
      if (envTex) envTex.dispose();
      bvhColliderRef.current?.dispose();
      bvhColliderRef.current = null;
      smokeGeo.dispose();
      smokeMat.dispose();
      pivGeo.dispose();
      pivMat.dispose();
      coneGeo.dispose();
      coneMat.dispose();
      controls.dispose();
      renderer.dispose();
      rendererRef.current = null;
      mount.innerHTML = '';
    };
  }, []);

  // Dynamic 3D GLB Model Loading & Real Vertex Surface Field Extraction
  useEffect(() => {
    if (!aircraftGroupRef.current || webglUnavailable) return;
    const aircraftGroup = aircraftGroupRef.current;
    let cancelled = false;

    if (glbRootRef.current) {
      aircraftGroup.remove(glbRootRef.current);
      if (isGlbCustomRef.current) {
        disposeThreeGroupResources(glbRootRef.current, {
          disposeGeometries: false,
          disposeMaterials: true,
          disposeTextures: false,
        });
      } else {
        restoreOriginalGlbMaterials(glbRootRef.current);
      }
      glbRootRef.current = null;
      isGlbCustomRef.current = false;
    }
    if (proceduralMeshRef.current) {
      aircraftGroup.remove(proceduralMeshRef.current);
      disposeThreeGroupResources(proceduralMeshRef.current, {
        disposeGeometries: true,
        disposeMaterials: true,
        disposeTextures: false,
      });
      proceduralMeshRef.current = null;
    }
    if (surfaceFieldRef.current) {
      surfaceFieldRef.current.clear();
      surfaceFieldRef.current = null;
    }
    if (bvhColliderRef.current) {
      bvhColliderRef.current.dispose();
      bvhColliderRef.current = null;
    }

    setModelLoading(true);
    setLoadProgress(0);
    setLoadError(null);

    const applyActiveShadingToRoot = (root: THREE.Group) => {
      if (activeShading === 'cfdHeatmap' || params.show_heatmap) {
        applyCfdPressureHeatmap(root, params.angle_of_attack, telemetry.isStalled);
      } else if (activeShading === 'wireframe') {
        restoreOriginalGlbMaterials(root);
        applyWireframeShading(root, true);
      } else if (activeShading === 'xray') {
        applyCachedXrayMaterial(root);
      } else {
        restoreOriginalGlbMaterials(root);
        applyWireframeShading(root, false);
      }
    };

    const customAsset = customGlbAssetRef.current;

    if (params.modelType === 'custom_glb' && customAsset) {
      const { root } = buildOrientedCustomGlbRoot(
        customAsset,
        Boolean(params.customGlbFlipNose),
        params.customGlbYawDeg ?? 0
      );
      glbRootRef.current = root;
      isGlbCustomRef.current = true;
      aircraftGroup.add(root);
      aircraftGroup.updateMatrixWorld(true);
      surfaceFieldRef.current = AircraftSurfaceField.fromThreeGroup(root);
      bvhColliderRef.current = MeshBvhCollider.fromThreeGroup(root, aircraftGroup);

      setSurfaceVersion((v) => v + 1);
      setModelLoading(false);
      applyActiveShadingToRoot(root);

      return () => {
        cancelled = true;
      };
    }

    const isGlbAvailable = !!GLB_MODEL_REGISTRY[params.modelType];

    if (isGlbAvailable) {
      loadGlbAircraftModel(params.modelType, (pct) => {
        if (!cancelled) setLoadProgress(pct);
      })
        .then(({ root }) => {
          if (cancelled || !aircraftGroupRef.current) return;
          // Extract real 3D mesh vertices & BVH collider in pure body frame (relative to aircraftGroup)
          glbRootRef.current = root;
          isGlbCustomRef.current = false;
          aircraftGroupRef.current.add(root);
          aircraftGroupRef.current.updateMatrixWorld(true);
          surfaceFieldRef.current = AircraftSurfaceField.fromThreeGroup(root);
          bvhColliderRef.current = MeshBvhCollider.fromThreeGroup(root, aircraftGroupRef.current);

          setSurfaceVersion((v) => v + 1);
          setModelLoading(false);
          applyActiveShadingToRoot(root);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error('Failed to load GLB model, falling back to procedural:', err);
          setLoadError('Falling back to procedural mesh');
          loadProceduralFallback();
        });
    } else {
      loadProceduralFallback();
    }

    function loadProceduralFallback() {
      const meshData = getAircraft3DModel(
        params.modelType,
        params.flaps_deg,
        params.angle_of_attack,
        params.airspeed_kts,
        telemetry.lift_N
      );
      const geom = new THREE.BufferGeometry();
      const positions: number[] = [];
      const colors: number[] = [];

      for (const face of meshData.faces) {
        const c = new THREE.Color(face.baseColor || '#1769AA');
        const idx = face.indices;
        for (let i = 1; i < idx.length - 1; i++) {
          const v0 = meshData.vertices[idx[0]];
          const v1 = meshData.vertices[idx[i]];
          const v2 = meshData.vertices[idx[i + 1]];
          positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
          colors.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
        }
      }

      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geom.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.35,
        metalness: 0.45,
        side: THREE.DoubleSide,
      });

      const procMesh = new THREE.Mesh(geom, mat);
      const procGroup = new THREE.Group();
      procGroup.name = `Procedural_${params.modelType}`;
      procGroup.add(procMesh);

      // Keep cylinder matching analytical CYLINDER_RADIUS; normalize all other procedural meshes to 10.0 units
      if (params.modelType !== 'cylinder') {
        normalizeAircraftGroupToTunnel(procGroup, 10.0, 0.35);
      } else {
        procGroup.updateMatrixWorld(true);
      }

      proceduralMeshRef.current = procGroup;
      aircraftGroup.add(procGroup);
      aircraftGroup.updateMatrixWorld(true);

      surfaceFieldRef.current = AircraftSurfaceField.fromThreeGroup(procGroup);
      bvhColliderRef.current = MeshBvhCollider.fromThreeGroup(procGroup, aircraftGroup);
      setSurfaceVersion((v) => v + 1);
      setModelLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [
    params.modelType,
    params.customAirfoilVersion,
    params.customGlbVersion,
    params.customGlbFlipNose,
    params.customGlbYawDeg,
    params.flowDomainVersion,
    customGlbAsset,
    webglUnavailable,
  ]);



  // Update Dynamic Aircraft Pitch (AoA)
  useEffect(() => {
    if (!aircraftGroupRef.current) return;
    const pitchRad = (params.angle_of_attack * Math.PI) / 180;
    aircraftGroupRef.current.rotation.z = -pitchRad;
  }, [params.angle_of_attack, telemetry.isStalled]);

  // Update Shading Mode (PBR, Wireframe, CFD Heatmap, X-Ray)
  useEffect(() => {
    if (!glbRootRef.current) return;
    const root = glbRootRef.current;

    if (activeShading === 'cfdHeatmap' || params.show_heatmap) {
      applyCfdPressureHeatmap(root, params.angle_of_attack, telemetry.isStalled);
    } else if (activeShading === 'wireframe') {
      restoreOriginalGlbMaterials(root);
      applyWireframeShading(root, true);
    } else if (activeShading === 'xray') {
      applyCachedXrayMaterial(root);
    } else {
      restoreOriginalGlbMaterials(root);
      applyWireframeShading(root, false);
    }
  }, [activeShading, params.show_heatmap, params.angle_of_attack, telemetry.isStalled]);

  // Update Mach Shockwave Cone
  useEffect(() => {
    if (!machConeMeshRef.current) return;
    const isSupersonic = telemetry.mach >= 1.0 && params.show_shockwaves;
    machConeMeshRef.current.visible = isSupersonic;

    if (isSupersonic) {
      const mu = Math.asin(1 / Math.max(1.001, telemetry.mach));
      const coneHeight = 16.0;
      const baseRadius = coneHeight * Math.tan(mu);
      const noseX = surfaceFieldRef.current ? surfaceFieldRef.current.minX : -6.7;
      machConeMeshRef.current.geometry.dispose();
      const newGeo = new THREE.ConeGeometry(baseRadius, coneHeight, 32, 1, true);
      newGeo.rotateZ(Math.PI / 2);
      newGeo.translate(coneHeight / 2 + noseX, 0, 0);
      machConeMeshRef.current.geometry = newGeo;
    }
  }, [telemetry.mach, params.show_shockwaves, params.modelType, surfaceVersion]);

  // Update Afterburner Flame strictly for built-in twin/quad supersonic jets (F-22 & Concorde)
  useEffect(() => {
    if (!afterburnerGroupRef.current) return;
    const isBuiltInJet = params.modelType === 'f22' || params.modelType === 'concorde';
    const config = AIRCRAFT_MODELS[params.modelType];
    afterburnerGroupRef.current.visible = isBuiltInJet && config.supersonicCapable && params.airspeed_kts > 480;
  }, [params.modelType, params.airspeed_kts]);

  // Update Force Vectors Overlay
  useEffect(() => {
    if (!forceVectorsGroupRef.current) return;
    updateAeroForceVectors(
      forceVectorsGroupRef.current,
      telemetry.lift_N,
      telemetry.drag_N,
      params.angle_of_attack,
      params.show_pressure_vectors,
      { cl: telemetry.cl, cd: telemetry.cd }
    );
  }, [telemetry.lift_N, telemetry.drag_N, telemetry.cl, telemetry.cd, params.angle_of_attack, params.show_pressure_vectors]);

  // Phase 4: Update Engineering Annotations (Stagnation, x_tr, x_sep, Bound Vortex Filaments, Downwash Vectors)
  useEffect(() => {
    const bodyGrp = bodyAnnotationsGroupRef.current;
    const worldGrp = worldAnnotationsGroupRef.current;
    if (!bodyGrp || !worldGrp) return;

    const disposeGroup = (grp: THREE.Group) => {
      grp.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        const mat = (obj as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      grp.clear();
    };

    disposeGroup(bodyGrp);
    disposeGroup(worldGrp);

    const anyEnabled =
      params.show_stagnation_annotation ||
      params.show_transition_annotation ||
      params.show_separation_annotation ||
      params.show_vortex_filaments ||
      params.show_downwash_vectors;

    if (!anyEnabled) return;

    const sf = surfaceFieldRef.current;
    const halfSpan = sf ? sf.halfSpan : 6.0;
    const isWingOnly =
      params.modelType === 'naca0012' ||
      params.modelType === 'naca2412' ||
      params.modelType === 'validation_wing' ||
      params.modelType === 'custom_airfoil';
    const refZ = isWingOnly ? 0 : halfSpan * 0.42;
    const sec = { leX: -3.0, teX: 3.0, quarterChordX: -1.5, chord: 6.0, yMid: 0, thickness: 0.45 };
    if (sf) {
      sf.getSpanSection(refZ, sec);
    }

    const chord = Math.max(0.6, sec.chord);
    const wingYTop = sec.yMid + Math.max(0.18, sec.thickness * 0.52);
    const spanLimit = Math.max(1.0, halfSpan * 0.92);
    const aoaRad = (params.angle_of_attack * Math.PI) / 180;

    // 1. Stagnation Point Marker (Body-fixed)
    if (params.show_stagnation_annotation) {
      const stagX = sec.leX + telemetry.stagnationXc * chord;
      const stagY = sec.yMid - Math.sin(aoaRad) * Math.max(0.12, sec.thickness * 0.25);
      const stagZPositions = isWingOnly ? [0] : [-refZ, 0, refZ];
      const stagMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xfde047,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
      });

      for (const zPos of stagZPositions) {
        const sGeo = new THREE.SphereGeometry(0.14, 16, 12);
        const sMesh = new THREE.Mesh(sGeo, stagMat);
        sMesh.position.set(stagX, stagY, zPos);
        bodyGrp.add(sMesh);

        const rGeo = new THREE.RingGeometry(0.2, 0.27, 24);
        rGeo.rotateY(Math.PI / 2);
        const rMesh = new THREE.Mesh(rGeo, ringMat);
        rMesh.position.set(stagX - 0.04, stagY, zPos);
        bodyGrp.add(rMesh);
      }
    }

    // 2. Boundary-Layer Transition Line x_tr/c (Body-fixed)
    if (params.show_transition_annotation) {
      const trX = sec.leX + telemetry.xTransitionUpper * chord;
      const trGeo = new THREE.CylinderGeometry(0.035, 0.035, spanLimit * 2, 10);
      trGeo.rotateX(Math.PI / 2);
      const trMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.9,
      });
      const trMesh = new THREE.Mesh(trGeo, trMat);
      trMesh.position.set(trX, wingYTop, 0);
      bodyGrp.add(trMesh);
    }

    // 3. Boundary-Layer Separation Onset Line x_sep/c (Body-fixed)
    if (params.show_separation_annotation && telemetry.xSeparationUpper < 0.995) {
      const sepX = sec.leX + telemetry.xSeparationUpper * chord;
      const sepGeo = new THREE.CylinderGeometry(0.045, 0.045, spanLimit * 2, 10);
      sepGeo.rotateX(Math.PI / 2);
      const sepMat = new THREE.MeshBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0.95,
      });
      const sepMesh = new THREE.Mesh(sepGeo, sepMat);
      sepMesh.position.set(sepX, wingYTop + 0.04, 0);
      bodyGrp.add(sepMesh);
    }

    // 4. Quarter-Chord Bound Vortex Filament & Trailing Horseshoe Legs
    if (params.show_vortex_filaments) {
      const boundGeo = new THREE.CylinderGeometry(0.06, 0.06, spanLimit * 2, 14);
      boundGeo.rotateX(Math.PI / 2);
      const boundMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.9,
      });
      const boundMesh = new THREE.Mesh(boundGeo, boundMat);
      boundMesh.position.set(sec.quarterChordX, sec.yMid, 0);
      bodyGrp.add(boundMesh);

      // Trailing tip horseshoe filaments in world wake
      const tipMat = new THREE.MeshBasicMaterial({
        color: 0x0ea5e9,
        transparent: true,
        opacity: 0.72,
      });
      const teWorldX = sec.quarterChordX * Math.cos(aoaRad) + chord * 0.75 * Math.cos(aoaRad);
      const teWorldY = sec.yMid - chord * 0.75 * Math.sin(aoaRad);
      for (const tipSign of [-1, 1]) {
        const legLen = 11.0;
        const legGeo = new THREE.CylinderGeometry(0.04, 0.025, legLen, 10);
        legGeo.rotateZ(-Math.PI / 2);
        const legMesh = new THREE.Mesh(legGeo, tipMat);
        const epsRad = (telemetry.downwashAngle_deg * Math.PI) / 180;
        legMesh.rotation.z = -epsRad * 0.5;
        legMesh.position.set(
          teWorldX + legLen * 0.5 - 0.5,
          teWorldY - Math.sin(epsRad * 0.5) * legLen * 0.5,
          tipSign * spanLimit
        );
        worldGrp.add(legMesh);
      }
    }

    // 5. Trefftz Downwash Velocity Vectors behind Trailing Edge (World-space)
    if (params.show_downwash_vectors) {
      const epsRad = (telemetry.downwashAngle_deg * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.cos(epsRad), -Math.sin(epsRad), 0).normalize();
      const arrowLen = Math.max(1.2, Math.min(3.2, 1.4 + Math.abs(telemetry.cl) * 1.1));
      const teWorldX = sec.teX * Math.cos(aoaRad) + sec.yMid * Math.sin(aoaRad) + 0.7;
      const teWorldY = -sec.teX * Math.sin(aoaRad) + sec.yMid * Math.cos(aoaRad);

      const zStations = isWingOnly
        ? [-spanLimit * 0.65, 0, spanLimit * 0.65]
        : [-spanLimit * 0.75, -spanLimit * 0.38, 0, spanLimit * 0.38, spanLimit * 0.75];

      for (const zPos of zStations) {
        const arrow = new THREE.ArrowHelper(
          dir,
          new THREE.Vector3(teWorldX, teWorldY, zPos),
          arrowLen,
          0x22d3ee,
          0.38,
          0.2
        );
        worldGrp.add(arrow);
      }
    }
  }, [
    params.show_stagnation_annotation,
    params.show_transition_annotation,
    params.show_separation_annotation,
    params.show_vortex_filaments,
    params.show_downwash_vectors,
    params.modelType,
    params.angle_of_attack,
    telemetry.stagnationXc,
    telemetry.xTransitionUpper,
    telemetry.xSeparationUpper,
    telemetry.downwashAngle_deg,
    telemetry.cl,
    surfaceVersion,
  ]);



  // Build & Upload Volumetric Smoke Streamlines / Streakline Seed Geometry
  useEffect(() => {
    const smokeMesh = smokeRibbonMeshRef.current;
    if (!smokeMesh) return;

    smokeMesh.visible = params.show_streamlines;
    if (!params.show_streamlines) {
      smokeFilamentsRef.current = [];
      smokeMesh.geometry.setDrawRange(0, 0);
      return;
    }

    const sf = surfaceFieldRef.current;
    const bvh = bvhColliderRef.current;
    const cal = activeCalibrationRef.current;
    const isBluffWake =
      cal &&
      ((cal.modelClass === 'bluff_body' && cal.wakeTurbulenceOnset >= 0.25) ||
        (cal.modelClass === 'car' && cal.wakeTurbulenceOnset >= 0.35));
    const isUnsteady = telemetry.isStalled || params.modelType === 'cylinder' || Boolean(isBluffWake);
    smokeUnsteadyRef.current = isUnsteady;

    const fluidParams: Fluid3DParams = {
      modelType: params.modelType,
      aoaDeg: params.angle_of_attack,
      airspeed_kts: params.airspeed_kts,
      mach: telemetry.mach,
      altitude_ft: params.altitude_ft,
      flapsDeg: params.flaps_deg,
      viscosity: params.viscosity,
      isStalled: telemetry.isStalled,
      cl: telemetry.cl,
      cd: telemetry.cd,
      timeSec: simTimeRef.current,
      streamlineResolution: params.streamline_resolution ?? 1.0,
      surfaceField: sf,
      bvhCollider: bvh,
      calibration: cal,
    };

    // Derive active 3D Box3 bounds (fallback to analytical/SDF bounds while async GLB loads)
    let modelBounds: ModelBoundingBox = FluidDynamics3D.getModelBoundingBox(sf, fluidParams);
    const activeModelRoot = glbRootRef.current || proceduralMeshRef.current;
    if (activeModelRoot && aircraftGroupRef.current) {
      aircraftGroupRef.current.updateMatrixWorld(true);
      _boxBoundsTmp.setFromObject(activeModelRoot);
      if (!_boxBoundsTmp.isEmpty()) {
        _boxBoundsTmp.getCenter(_boxCenterTmp);
        _boxBoundsTmp.getSize(_boxSizeTmp);
        modelBounds = {
          center: { x: _boxCenterTmp.x, y: _boxCenterTmp.y, z: _boxCenterTmp.z },
          minX: _boxBoundsTmp.min.x,
          maxX: _boxBoundsTmp.max.x,
          halfY: Math.max(0.25, _boxSizeTmp.y * 0.5),
          halfZ: Math.max(0.35, _boxSizeTmp.z * 0.5),
          lengthX: Math.max(0.8, _boxSizeTmp.x),
        };
      }
    }

    const seeds = FluidDynamics3D.buildUnifiedRakeSeeds(modelBounds, fluidParams, {
      layerGap: params.layer_gap ?? DEFAULT_LAYER_GAP,
      rakeSpread: params.rake_spread ?? 1.0,
      maxFilaments: MAX_FILAMENTS,
    });

    const resScale = Math.max(0.5, Math.min(2.0, params.streamline_resolution ?? 1.0));
    const maxSteps = Math.min(MAX_NODES_PER_FILAMENT - 1, Math.round(135 * Math.min(1.18, resScale)));
    const xWakeEnd = modelBounds.maxX + Math.max(7.5, 1.8 * modelBounds.lengthX);
    const xSpawn = modelBounds.minX - 1.5 * Math.max(0.8, modelBounds.lengthX);
    const desiredSpan = Math.max(18.0, xWakeEnd - xSpawn);
    const stepDs = Math.max(0.14, Math.max(desiredSpan / maxSteps, 0.24 / resScale));

    const filaments: UnsteadyFilamentState[] = [];
    for (const seed of seeds) {
      const traced = FluidDynamics3D.traceStreamline(seed, fluidParams, maxSteps, stepDs);
      if (traced.length < 2) continue;

      const vSeed = FluidDynamics3D.getVelocity(seed, fluidParams);
      const nodes: FilamentNode[] = [
        {
          x: seed.x,
          y: seed.y,
          z: seed.z,
          speed: vSeed.speed,
          cp: vSeed.pressureCoeffClamped,
          vorticity: vSeed.vorticity,
          isSeparated: vSeed.isSeparated,
        },
        ...traced.slice(0, MAX_NODES_PER_FILAMENT - 1).map((pt) => ({
          x: pt.x,
          y: pt.y,
          z: pt.z,
          speed: pt.speed,
          cp: pt.pressureCoeffClamped,
          vorticity: pt.vorticity,
          isSeparated: pt.isSeparated,
        })),
      ];
      filaments.push({ seed, nodes });
    }

    smokeFilamentsRef.current = filaments;
    packSmokeFilamentsToMesh(smokeMesh, filaments, params.viscosity, params.smoke_density);
  }, [
    params.show_streamlines,
    params.modelType,
    params.angle_of_attack,
    params.airspeed_kts,
    params.altitude_ft,
    params.flaps_deg,
    params.viscosity,
    params.smoke_density,
    params.rake_spread,
    params.layer_gap,
    params.streamline_resolution,
    params.streamline_count,
    params.flowDomainVersion,
    telemetry.cl,
    telemetry.cd,
    telemetry.mach,
    telemetry.isStalled,
    surfaceVersion,
    customGlbAsset,
  ]);

  // Seed Stratified Lagrangian PIV Particle Field
  useEffect(() => {
    const pivLines = pivLinesRef.current;
    if (!pivLines) return;

    pivLines.visible = params.show_particles;
    const pState = pivStateRef.current;
    if (!params.show_particles) {
      pState.count = 0;
      pivLines.geometry.setDrawRange(0, 0);
      return;
    }

    const sf = surfaceFieldRef.current;
    const frame = FluidDynamics3D.getDynamicEmitterFrame(
      sf,
      params.rake_spread ?? 1.0,
      params.streamline_resolution ?? 1.0
    );
    const fluidParams: Fluid3DParams = {
      modelType: params.modelType,
      aoaDeg: params.angle_of_attack,
      airspeed_kts: params.airspeed_kts,
      mach: telemetry.mach,
      altitude_ft: params.altitude_ft,
      flapsDeg: params.flaps_deg,
      viscosity: params.viscosity,
      isStalled: telemetry.isStalled,
      cl: telemetry.cl,
      cd: telemetry.cd,
      timeSec: simTimeRef.current,
      streamlineResolution: params.streamline_resolution ?? 1.0,
      surfaceField: sf,
      bvhCollider: bvhColliderRef.current,
      calibration: activeCalibrationRef.current,
    };

    const targetCount = Math.min(
      MAX_PIV_PARTICLES,
      Math.max(20, Math.round(params.particle_count ?? 480))
    );
    const inletX = frame.xSpawn;
    const modelStartX = sf ? sf.minX - 0.5 : -3.2;
    const fillSpan = Math.max(2.0, modelStartX - inletX);
    const clearance = sf ? Math.max(0.08, sf.dMin * 0.38) : 0.12;

    for (let i = 0; i < targetCount; i++) {
      const isInner = i < Math.round(targetCount * 0.65);
      const yScale = isInner ? 0.65 : 1.05;
      const zScale = isInner ? 0.72 : 1.05;
      const rawPt = {
        x: inletX + Math.random() * fillSpan,
        y: frame.yMid + (Math.random() * 2 - 1) * frame.yHalf * yScale,
        z: (Math.random() * 2 - 1) * frame.zHalf * zScale,
      };
      if (bvhColliderRef.current) {
        bvhColliderRef.current.deflectWorldPointAndVelocity(
          rawPt,
          null,
          params.angle_of_attack,
          clearance,
          sf
        );
      }
      const pt = FluidDynamics3D.constrainToExterior(rawPt, fluidParams, clearance);
      pState.x[i] = pt.x;
      pState.y[i] = pt.y;
      pState.z[i] = pt.z;
      pState.age[i] = Math.random() * 2.0;
      pState.innerFlag[i] = isInner ? 1 : 0;
    }
    pState.count = targetCount;
  }, [
    params.show_particles,
    params.particle_count,
    params.smoke_density,
    params.rake_spread,
    params.modelType,
    params.flowDomainVersion,
    surfaceVersion,
    customGlbAsset,
  ]);

  // Update 3D Vector Quiver Grid (when params.show_quiver is enabled)
  useEffect(() => {
    const qGroup = quiverGroupRef.current;
    if (!qGroup) return;

    qGroup.traverse((obj) => {
      if ((obj as THREE.LineSegments).isLineSegments) {
        (obj as THREE.LineSegments).geometry.dispose();
        const m = (obj as THREE.LineSegments).material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    qGroup.clear();

    if (!params.show_quiver) return;

    const fluid3DParams: Fluid3DParams = {
      modelType: params.modelType,
      aoaDeg: params.angle_of_attack,
      airspeed_kts: params.airspeed_kts,
      mach: telemetry.mach,
      altitude_ft: params.altitude_ft,
      flapsDeg: params.flaps_deg,
      viscosity: params.viscosity,
      isStalled: telemetry.isStalled,
      cl: telemetry.cl,
      cd: telemetry.cd,
      timeSec: performance.now() * 0.001,
      surfaceField: surfaceFieldRef.current,
      calibration: activeCalibrationRef.current,
    };

    const positions: number[] = [];
    const colors: number[] = [];

    for (let x = -9; x <= 11; x += 2.5) {
      for (let y = -2.0; y <= 3.0; y += 1.25) {
        for (let z = -6.0; z <= 6.0; z += 3.0) {
          const vel = FluidDynamics3D.getVelocity({ x, y, z }, fluid3DParams);
          const s = vel.speed || 1;
          const len = Math.min(1.6, 0.45 + s * 0.42);
          const nx = (vel.u / s) * len;
          const ny = (vel.v / s) * len;
          const nz = (vel.w / s) * len;

          positions.push(x, y, z, x + nx, y + ny, z + nz);

          let r = 0.22, g = 0.74, b = 0.97;
          if (vel.isSeparated) { r = 0.94; g = 0.27; b = 0.27; }
          else if (vel.pressureCoeffClamped < -0.5) { r = 0.14; g = 0.68; b = 0.98; }
          else if (vel.pressureCoeffClamped > 0.2) { r = 0.96; g = 0.72; b = 0.16; }
          else { r = 0.20; g = 0.83; b = 0.60; }

          colors.push(r * 0.4, g * 0.4, b * 0.4, r, g, b);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 });
    qGroup.add(new THREE.LineSegments(geo, mat));
  }, [
    params.show_quiver,
    params.modelType,
    params.angle_of_attack,
    params.airspeed_kts,
    params.flaps_deg,
    params.viscosity,
    telemetry.cl,
    telemetry.mach,
    telemetry.isStalled,
    surfaceVersion,
  ]);

  // Camera Presets
  const setCameraPreset = (preset: 'iso' | 'side' | 'top' | 'front' | 'chase') => {
    setActivePreset(preset);
    setIsAutoOrbit(false);
    if (!cameraRef.current || !controlsRef.current) return;

    const cam = cameraRef.current;
    const ctrl = controlsRef.current;
    ctrl.target.set(0, 0, 0);

    switch (preset) {
      case 'iso':
        cam.position.set(-15, 7.5, 15);
        break;
      case 'side':
        cam.position.set(0, 1, 18);
        break;
      case 'top':
        cam.position.set(0, 22, 0.001);
        break;
      case 'front':
        cam.position.set(-18, 1, 0);
        break;
      case 'chase':
        cam.position.set(18, 4, 0);
        break;
    }
    ctrl.update();
  };

  // Snapshot
  const handleTakeSnapshot = () => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;
    rendererRef.current.render(sceneRef.current, cameraRef.current);
    const dataUrl = rendererRef.current.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `aerolab-${params.modelType}-vortex-flow-${Date.now()}.png`;
    a.click();
  };

  const currentMeta = GLB_MODEL_REGISTRY[params.modelType];

  return (
    <div className="relative w-full h-full min-h-[220px] sm:min-h-[360px] lg:min-h-[420px] rounded-xl overflow-hidden border border-[var(--border)] bg-[#0D1114] shadow-[var(--shadow-tech)] flex flex-col group select-none">
      {/* Three.js Canvas Container */}
      <div ref={mountRef} className="w-full h-full touch-none cursor-grab active:cursor-grabbing" />

      {/* WebGL2 Unavailable Fallback Overlay */}
      {webglUnavailable && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0D1114]/95 gap-4 z-30 p-6 text-center">
          <Warning weight="duotone" className="w-10 h-10 text-amber-400" />
          <div className="max-w-md flex flex-col gap-1.5">
            <h3 className="text-sm font-bold text-white">Hardware WebGL2 Unavailable</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Your browser or GPU driver could not initialize a WebGL2 context. Use the built-in Software 3D Canvas engine for full aerodynamic simulation.
            </p>
          </div>
          {onFallbackToCanvas && (
            <button
              onClick={onFallbackToCanvas}
              className="px-4 py-2 rounded-lg bg-[#1769AA] hover:bg-[#1e7bc4] text-white font-semibold text-xs transition-colors"
            >
              Switch to Canvas 3D Engine
            </button>
          )}
        </div>
      )}

      {/* Model Loading Spinner / Progress */}
      {modelLoading && !webglUnavailable && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0D1114]/90 gap-3.5 z-20">
          <div className="w-12 h-12 rounded-full border-2 border-slate-700 border-t-[#38bdf8] animate-spin" />
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-100 font-mono">
              Loading {currentMeta ? currentMeta.name : '3D CAD Model'} · {loadProgress}%
            </span>
            <div className="w-48 h-1.5 rounded-full bg-[#151A1E] overflow-hidden border border-slate-700">
              <div
                className="h-full bg-[#1769AA] transition-all duration-200"
                style={{ width: `${Math.max(8, loadProgress)}%` }}
              />
            </div>
            <span className="text-[11px] text-slate-400 font-mono">
              {currentMeta ? `${currentMeta.fileSizeLabel} · ${currentMeta.meshCountLabel}` : 'Building vertex flow field'}
            </span>
          </div>
        </div>
      )}

      {loadError && !modelLoading && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 px-3 py-1 rounded-lg bg-[#151A1E] border border-amber-500/40 text-amber-300 text-[11px] font-mono z-10 pointer-events-none">
          {loadError}
        </div>
      )}

      {/* Top Header Overlay (Solid #151A1E surface, zero backdrop-blur over WebGL) */}
      <div className="absolute top-2.5 left-2.5 right-2.5 flex items-start justify-between gap-2 pointer-events-none z-10">
        <div className="flex flex-col items-start gap-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-[#151A1E]/95 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg border border-slate-700/80 pointer-events-auto text-[11px] sm:text-xs">
            <span className="font-semibold text-slate-100">
              {params.modelType === 'custom_glb' && customGlbAsset
                ? `${customGlbAsset.fileName.replace(/\.glb$/i, '')} (${formatModelClassLabel(customGlbAsset.calibration.modelClass)})`
                : currentMeta
                  ? currentMeta.name
                  : AIRCRAFT_MODELS[params.modelType].name}
            </span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span className="sm:hidden text-[10px] font-mono text-sky-300">
              Reduced-Order Biot–Savart VLM
            </span>
            <span className="hidden sm:inline text-[11px] font-mono text-sky-300">
              Reduced-Order Biot–Savart Vortex-Lattice &amp; Approximate SDF Model
            </span>
            {telemetry.isStalled && (
              <>
                <span className="text-slate-500" aria-hidden="true">·</span>
                <span className="text-[10px] sm:text-[11px] font-bold text-red-400 flex items-center gap-1 whitespace-nowrap shrink-0">
                  <Warning weight="duotone" className="w-3.5 h-3.5" />
                  STALL
                </span>
              </>
            )}
          </div>

          {/* Floating Spatial Force Readout (stacks cleanly below header badge) */}
          {params.show_pressure_vectors && (
            <div className="flex flex-col gap-0.5 sm:gap-1 font-mono tabular-nums text-[10px] sm:text-[11px] bg-[#151A1E]/92 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg border border-slate-700/80">
              <div className="flex items-center justify-between gap-2.5 sm:gap-3 text-emerald-300">
                <span>LIFT</span>
                <span className="font-semibold">{(telemetry.lift_N / 1000).toFixed(1)} kN</span>
              </div>
              <div className="flex items-center justify-between gap-2.5 sm:gap-3 text-amber-300">
                <span>DRAG</span>
                <span className="font-semibold">{(telemetry.drag_N / 1000).toFixed(1)} kN</span>
              </div>
              <div className="flex items-center justify-between gap-2.5 sm:gap-3 text-sky-300">
                <span>L/D</span>
                <span className="font-semibold">{telemetry.ldRatio.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Top-Right Quick Action Toolbar */}
        <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
          {onOpenModelInspector && (
            <button
              onClick={onOpenModelInspector}
              className="p-1.5 sm:px-3 sm:py-1.5 rounded-lg bg-[#151A1E]/95 hover:bg-slate-800 border border-slate-700/80 text-slate-100 text-xs font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              title="Open 3D CAD Asset Inspector"
            >
              <Cube weight="duotone" className="w-4 h-4 text-sky-400" />
              <span className="hidden sm:inline">3D Inspector</span>
            </button>
          )}

          <button
            onClick={handleTakeSnapshot}
            className="p-2 rounded-lg bg-[#151A1E]/95 hover:bg-slate-800 border border-slate-700/80 text-slate-200 hover:text-white transition-colors"
            title="Save CFD PNG Snapshot"
          >
            <Camera weight="duotone" className="w-4 h-4 text-sky-400" />
          </button>

          <div className="flex items-center bg-[#151A1E]/95 p-0.5 rounded-lg border border-slate-700/80">
            <button
              onClick={() => onParamChange('audio_enabled', !params.audio_enabled)}
              className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
              title={params.audio_enabled ? 'Mute Wind Sound' : 'Enable Wind Audio'}
            >
              {params.audio_enabled ? (
                <SpeakerHigh weight="duotone" className="w-4 h-4 text-sky-400" />
              ) : (
                <SpeakerSlash weight="duotone" className="w-4 h-4" />
              )}
            </button>

            {onFallbackToCanvas && (
              <button
                onClick={onFallbackToCanvas}
                className="px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-white transition-colors border-l border-slate-700/80 ml-0.5 whitespace-nowrap shrink-0"
                title="Switch to Canvas 3D Engine"
              >
                Canvas 3D
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Floating Controls Dock */}
      <div className="absolute bottom-2 left-2 right-2 flex flex-col gap-1.5 pointer-events-none z-10">

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          {/* Camera Presets & Turntable */}
          <div className="flex items-center gap-0.5 sm:gap-1 bg-[#151A1E]/95 p-0.5 sm:p-1 rounded-lg border border-slate-700/80 pointer-events-auto max-w-full overflow-x-auto">
            {(['iso', 'side', 'top', 'front', 'chase'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setCameraPreset(p)}
                className={`px-1.5 sm:px-2.5 py-1 rounded-md text-[10px] sm:text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                  activePreset === p && !isAutoOrbit
                    ? 'bg-[#1769AA] text-white'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                {p}
              </button>
            ))}

            <div className="w-px h-3.5 bg-slate-700 mx-0.5 shrink-0" />

            <button
              onClick={() => setIsAutoOrbit(!isAutoOrbit)}
              className={`px-1.5 sm:px-2.5 py-1 rounded-md text-[10px] sm:text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 ${
                isAutoOrbit
                  ? 'bg-[#1769AA] text-white'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
              }`}
              title="Toggle 360 Turntable Orbit"
            >
              <ArrowsClockwise weight="bold" className={`w-3.5 h-3.5 ${isAutoOrbit ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Orbit</span>
            </button>
          </div>

          {/* Shading & Heatmap Overlays */}
          <div className="flex items-center gap-0.5 sm:gap-1 bg-[#151A1E]/95 p-0.5 sm:p-1 rounded-lg border border-slate-700/80 pointer-events-auto max-w-full overflow-x-auto">
            {(
              [
                { id: 'pbr', label: 'PBR' },
                { id: 'cfdHeatmap', label: 'CFD Heat' },
                { id: 'wireframe', label: 'Wire' },
                { id: 'xray', label: 'X-Ray' },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActiveShading(s.id);
                  if (s.id === 'cfdHeatmap') onParamChange('show_heatmap', true);
                  else if (s.id === 'pbr') onParamChange('show_heatmap', false);
                }}
                className={`px-1.5 sm:px-2.5 py-1 rounded-md text-[10px] sm:text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeShading === s.id
                    ? 'bg-[#1769AA] text-white'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* CFD Pressure Heatmap Legend Overlay */}
      {(activeShading === 'cfdHeatmap' || params.show_heatmap) && (
        <div className="absolute top-14 right-3 pointer-events-none z-10 bg-[#151A1E]/95 px-3 py-2 rounded-lg border border-slate-700/80 flex flex-col gap-1 text-[10px] font-mono">
          <span className="text-slate-200 font-semibold tracking-wider">Cp PRESSURE COEFFICIENT</span>
          <div className="w-32 h-2 rounded-full bg-gradient-to-r from-blue-600 via-cyan-400 via-emerald-400 via-amber-400 to-red-600 border border-slate-700" />
          <div className="flex justify-between text-slate-300">
            <span>-2.5</span>
            <span>0</span>
            <span>+1.0</span>
          </div>
        </div>
      )}
    </div>
  );
};
