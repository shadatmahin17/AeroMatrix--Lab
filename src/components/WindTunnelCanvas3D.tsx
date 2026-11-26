import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { SimulationParams, AeroTelemetry } from '../types/aerodynamics';
import { AIRCRAFT_MODELS } from '../utils/airfoilGenerators';
import { getAircraft3DModel, computeFaceNormal, Vertex3D } from '../utils/aircraft3DGeometry';
import { AircraftSurfaceField } from '../engine/AircraftSurfaceField';
import { FluidDynamics3D, Fluid3DParams, SmokeRakeSeed, Velocity3DResult } from '../engine/FluidDynamics3D';
import { windTunnelAudio } from '../utils/audio';
import {
  ArrowsClockwise,
  Warning,
  Lightning,
  SpeakerHigh,
  SpeakerSlash,
  ArrowUpRight,
  Flame,
  Pulse,
  CompassRose,
  Cube,
} from '@phosphor-icons/react';

import { AeroCalibration } from '../lib/calibration';

interface WindTunnelCanvas3DProps {
  params: SimulationParams;
  onParamChange: <K extends keyof SimulationParams>(key: K, value: SimulationParams[K]) => void;
  telemetry: AeroTelemetry;
  isPaused: boolean;
  onOpenWebGL?: () => void;
  onOpenModelInspector?: () => void;
  customGlbCalibration?: AeroCalibration | null;
}

interface CameraState {
  distance: number;
  theta: number; // Azimuth
  phi: number;   // Elevation
  target: Vertex3D;
}

/**
 * Maps aerodynamic local pressure coefficient Cp to a scientific CFD colormap
 * (Royal Blue = Suction peak -> Cyan -> Emerald -> Amber -> Crimson Stagnation)
 */
function getCfdHeatmapColor(cp: number, isStalled: boolean): string {
  if (isStalled) return '#ef4444'; // Boundary layer turbulent separation
  // Clamp Cp to range -2.8 (extreme suction) to +1.0 (stagnation)
  const norm = Math.max(0, Math.min(1, (cp - (-2.8)) / 3.8));
  if (norm < 0.22) return '#0284c7'; // Deep Suction Royal Blue
  if (norm < 0.42) return '#00f0ff'; // Suction Peak Electric Cyan
  if (norm < 0.62) return '#10b981'; // Attached Laminar Emerald
  if (norm < 0.82) return '#f59e0b'; // Dynamic Compression Amber
  return '#ef4444'; // Dynamic Ram Stagnation Crimson
}

export const WindTunnelCanvas3D: React.FC<WindTunnelCanvas3DProps> = ({
  params,
  onParamChange,
  telemetry,
  isPaused,
  onOpenWebGL,
  onOpenModelInspector,
  customGlbCalibration = null,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameIdRef = useRef<number | null>(null);

  // Spherical Camera (Distance, Azimuth, Elevation)
  const cameraStateRef = useRef<CameraState>({
    distance: 18,
    theta: 0.85,  // Azimuth (radians)
    phi: 0.38,    // Elevation (radians)
    target: { x: 0, y: 0, z: 0 },
  });

  // Dragging for 3D Camera Orbit or Pitch control
  const isDraggingRef = useRef(false);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const isShiftDragRef = useRef(false);

  // Cinematic 360 Auto-Orbit Mode
  const [isAutoOrbit, setIsAutoOrbit] = useState(false);

  // Active camera preset button
  const [activePreset, setActivePreset] = useState<'side' | 'iso' | 'top' | 'chase' | 'front'>('iso');

  // Real Vertex Surface Field built from current procedural aircraft geometry
  const surfaceField = useMemo(() => {
    const baseMesh = getAircraft3DModel(params.modelType, params.flaps_deg, 0, 350, 0);
    return AircraftSurfaceField.fromProceduralMesh(baseMesh);
  }, [params.modelType, params.flaps_deg, params.customAirfoilVersion]);

  // Lagrangian PIV tracer pool & unsteady simulation clock for 2D-projected fallback renderer
  const CANVAS_PIV_COUNT = 1200;
  const pivPoolRef = useRef<{
    initialized: boolean;
    modelKey: string;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    inner: Uint8Array;
  }>({
    initialized: false,
    modelKey: '',
    x: new Float32Array(CANVAS_PIV_COUNT),
    y: new Float32Array(CANVAS_PIV_COUNT),
    z: new Float32Array(CANVAS_PIV_COUNT),
    inner: new Uint8Array(CANVAS_PIV_COUNT),
  });
  const simTimeRef = useRef<number>(0);
  const lastPerfRef = useRef<number>(performance.now());

  // Sync Audio with simulation speed & stall
  useEffect(() => {
    if (params.audio_enabled) {
      windTunnelAudio.start();
      windTunnelAudio.update(params.airspeed_kts, telemetry.mach, telemetry.isStalled);
    } else {
      windTunnelAudio.stop();
    }
  }, [params.audio_enabled, params.airspeed_kts, telemetry.mach, telemetry.isStalled]);

  // Camera preset selector
  const setCameraPreset = (preset: 'side' | 'iso' | 'top' | 'chase' | 'front') => {
    setActivePreset(preset);
    setIsAutoOrbit(false);
    const cam = cameraStateRef.current;
    switch (preset) {
      case 'side':
        cam.theta = 0.0;
        cam.phi = 0.05;
        cam.distance = 18;
        break;
      case 'iso':
        cam.theta = 0.85;
        cam.phi = 0.38;
        cam.distance = 18;
        break;
      case 'top':
        cam.theta = 0.0;
        cam.phi = 1.55;
        cam.distance = 19;
        break;
      case 'chase':
        cam.theta = 3.14;
        cam.phi = 0.25;
        cam.distance = 16;
        break;
      case 'front':
        cam.theta = 0.0;
        cam.phi = 0.0;
        cam.distance = 16;
        break;
    }
  };

  // 3D Matrix and Vector Math Utilities
  const project3Dto2D = useCallback((
    v: Vertex3D,
    camX: number,
    camY: number,
    camZ: number,
    viewMatrix: number[][],
    focalLength: number,
    cx: number,
    cy: number
  ) => {
    // Relative to camera
    const rx = v.x - camX;
    const ry = v.y - camY;
    const rz = v.z - camZ;

    // Multiply by camera rotation matrix
    const vx = rx * viewMatrix[0][0] + ry * viewMatrix[0][1] + rz * viewMatrix[0][2];
    const vy = rx * viewMatrix[1][0] + ry * viewMatrix[1][1] + rz * viewMatrix[1][2];
    const vz = rx * viewMatrix[2][0] + ry * viewMatrix[2][1] + rz * viewMatrix[2][2];

    if (vz <= 0.2) return null; // Behind camera plane

    const screenX = cx + (vx * focalLength) / vz;
    const screenY = cy - (vy * focalLength) / vz; // Flip Y for screen space

    return { x: screenX, y: screenY, depth: vz };
  }, []);

  // Main 3D Render Loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;
    const focalLength = Math.min(width, height) * 1.35;
    const now = Date.now();
    const perfNow = performance.now();
    const dtReal = Math.min(0.05, Math.max(0.001, (perfNow - lastPerfRef.current) * 0.001));
    lastPerfRef.current = perfNow;
    if (!isPaused) {
      simTimeRef.current += dtReal;
    }

    // 1. Calculate Camera Position & View Matrix
    const cam = cameraStateRef.current;
    if (isAutoOrbit && !isDraggingRef.current) {
      cam.theta += 0.005; // Smooth cinematic fly-around rotation
    }

    const camX = cam.target.x + cam.distance * Math.cos(cam.phi) * Math.sin(cam.theta);
    const camY = cam.target.y + cam.distance * Math.sin(cam.phi);
    const camZ = cam.target.z + cam.distance * Math.cos(cam.phi) * Math.cos(cam.theta);

    // Forward vector (Target - Eye)
    const fx = cam.target.x - camX;
    const fy = cam.target.y - camY;
    const fz = cam.target.z - camZ;
    const fLen = Math.hypot(fx, fy, fz) || 1;
    const fNorm = { x: fx / fLen, y: fy / fLen, z: fz / fLen };

    // Right vector (Forward x Up [0, 1, 0])
    const rx = -fNorm.z;
    const ry = 0;
    const rz = fNorm.x;
    const rLen = Math.hypot(rx, rz) || 1;
    const rNorm = { x: rx / rLen, y: 0, z: rz / rLen };

    // True Up vector (Right x Forward)
    const ux = rNorm.y * fNorm.z - rNorm.z * fNorm.y;
    const uy = rNorm.z * fNorm.x - rNorm.x * fNorm.z;
    const uz = rNorm.x * fNorm.y - rNorm.y * fNorm.x;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    const uNorm = { x: ux / uLen, y: uy / uLen, z: uz / uLen };

    const viewMatrix = [
      [rNorm.x, rNorm.y, rNorm.z],
      [uNorm.x, uNorm.y, uNorm.z],
      [fNorm.x, fNorm.y, fNorm.z],
    ];

    // 2. Clear Background (--dark: #0D1114)
    ctx.fillStyle = '#0D1114';
    ctx.fillRect(0, 0, width, height);

    // 3. Render Dynamic Wind Tunnel Coordinate Grid Floor (Vibrant Cyan & Indigo)
    ctx.strokeStyle = 'rgba(30, 58, 95, 0.45)';
    ctx.lineWidth = 1;
    const floorY = -4.5;
    for (let gx = -16; gx <= 16; gx += 4) {
      const p1 = project3Dto2D({ x: gx, y: floorY, z: -8 }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      const p2 = project3Dto2D({ x: gx, y: floorY, z: 8 }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      if (p1 && p2) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
    for (let gz = -8; gz <= 8; gz += 4) {
      const p1 = project3Dto2D({ x: -16, y: floorY, z: gz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      const p2 = project3Dto2D({ x: 16, y: floorY, z: gz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      if (p1 && p2) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // Honeycomb Inlet on Left (-X = -16) in Glowing Cyan
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    for (let hy = -4; hy <= 4; hy += 2) {
      const p1 = project3Dto2D({ x: -16, y: hy, z: -6 }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      const p2 = project3Dto2D({ x: -16, y: hy, z: 6 }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
      if (p1 && p2) {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // 4. 3D Fluid Velocity Field Parameters (for Smoke Streamlines, PIV Particles & Quiver)
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
      timeSec: simTimeRef.current,
      streamlineResolution: params.streamline_resolution ?? 1.0,
      surfaceField,
      calibration: params.modelType === 'custom_glb' ? customGlbCalibration : null,
    };

    // 4a. Realistic Smoke Streamlines & Unsteady Streaklines (RK2 Biot-Savart + Prandtl Boundary Layer)
    if (params.show_streamlines) {
      const requestedLines = Math.min(48, Math.max(2, Math.round(params.streamline_count ?? 18)));
      const seeds: SmokeRakeSeed[] = FluidDynamics3D.buildSmokeRakeSeeds(
        surfaceField,
        fluid3DParams,
        params.rake_spread ?? 1.0,
        params.smoke_density,
        requestedLines
      ).slice(0, requestedLines);
      const resScale = Math.max(0.5, Math.min(2.0, params.streamline_resolution ?? 1.0));
      const ds = Math.max(0.16, 0.28 / resScale);
      const steps = Math.round(92 * resScale);
      const densityAlpha = Math.min(0.9, 0.35 + params.smoke_density * 0.42);
      const flowSpeedVis = Math.min(7.0, Math.max(1.2, ((params.airspeed_kts * 0.514444) / 180.0554) * 3.0));

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const seed of seeds) {
        const pts = FluidDynamics3D.traceStreamline(seed, fluid3DParams, steps, ds);
        if (pts.length < 3) continue;

        let arcDist = 0;
        let prevPt = pts[0];
        let prevProj = project3Dto2D(prevPt, camX, camY, camZ, viewMatrix, focalLength, cx, cy);

        for (let i = 1; i < pts.length; i++) {
          const curPt = pts[i];
          arcDist += Math.hypot(curPt.x - prevPt.x, curPt.y - prevPt.y, curPt.z - prevPt.z);
          const curProj = project3Dto2D(curPt, camX, camY, camZ, viewMatrix, focalLength, cx, cy);

          if (prevProj && curProj) {
            const uFrac = i / (pts.length - 1);
            const endFade = Math.min(1, uFrac * 12) * Math.min(1, (1 - uFrac) * 6);
            const wisp = 0.72 + 0.28 * Math.sin(arcDist * 1.45 - simTimeRef.current * flowSpeedVis);
            const segAlpha = densityAlpha * endFade * wisp * (seed.role === 'tip' ? 0.95 : 0.78);

            if (segAlpha > 0.03) {
              const strokeRgb = curPt.isSeparated
                ? '244, 86, 76'
                : seed.role === 'tip' || curPt.vorticity > 1.35
                ? '72, 214, 252'
                : curPt.pressureCoeffClamped < -0.25
                ? '56, 189, 248'
                : curPt.pressureCoeffClamped > 0.22
                ? '245, 168, 52'
                : '214, 236, 255';

              // Outer volumetric smoke halo (widens slowly downstream via viscous diffusion)
              const haloWidth = Math.min(5.0, (1.8 + Math.sqrt(arcDist) * 0.35) * (0.7 + params.smoke_density * 0.45));
              ctx.strokeStyle = `rgba(${strokeRgb}, ${(segAlpha * 0.26).toFixed(3)})`;
              ctx.lineWidth = haloWidth;
              ctx.beginPath();
              ctx.moveTo(prevProj.x, prevProj.y);
              ctx.lineTo(curProj.x, curProj.y);
              ctx.stroke();

              // Inner filament core
              ctx.strokeStyle = `rgba(${strokeRgb}, ${(segAlpha * 0.85).toFixed(3)})`;
              ctx.lineWidth = Math.max(0.9, haloWidth * 0.36);
              ctx.beginPath();
              ctx.moveTo(prevProj.x, prevProj.y);
              ctx.lineTo(curProj.x, curProj.y);
              ctx.stroke();
            }
          }
          prevPt = curPt;
          prevProj = curProj;
        }
      }
      ctx.restore();
    }

    // 4a-bis. Lagrangian PIV Tracer Particles (RK2 stratified advection)
    if (params.show_particles) {
      const pool = pivPoolRef.current;
      const frame = FluidDynamics3D.getDynamicEmitterFrame(
        surfaceField,
        params.rake_spread ?? 1.0,
        params.streamline_resolution ?? 1.0
      );
      const modelKey = `${params.modelType}_${params.flaps_deg}_${params.flowDomainVersion}_${params.rake_spread}`;
      const activeCount = Math.min(
        CANVAS_PIV_COUNT,
        Math.max(20, Math.round(params.particle_count ?? 480))
      );

      if (!pool.initialized || pool.modelKey !== modelKey) {
        const inletX = frame.xSpawn;
        const modelStartX = surfaceField ? surfaceField.minX - 0.5 : -3.2;
        const fillSpan = Math.max(2.0, modelStartX - inletX);
        const clearance = surfaceField ? Math.max(0.08, surfaceField.dMin * 0.38) : 0.12;
        for (let i = 0; i < CANVAS_PIV_COUNT; i++) {
          const isInner = i < Math.round(CANVAS_PIV_COUNT * 0.65);
          const rawPt = {
            x: inletX + Math.random() * fillSpan,
            y: frame.yMid + (Math.random() * 2 - 1) * frame.yHalf * (isInner ? 0.65 : 1.05),
            z: (Math.random() * 2 - 1) * frame.zHalf * (isInner ? 0.72 : 1.05),
          };
          const pt = FluidDynamics3D.constrainToExterior(rawPt, fluid3DParams, clearance);
          pool.x[i] = pt.x;
          pool.y[i] = pt.y;
          pool.z[i] = pt.z;
          pool.inner[i] = isInner ? 1 : 0;
        }
        pool.initialized = true;
        pool.modelKey = modelKey;
      }

      const scratchPos = { x: 0, y: 0, z: 0 };
      const scratchVel: Velocity3DResult = {
        u: 1, v: 0, w: 0, speed: 1, cpIncompressible: 0, pressureCoeff: 0,
        pressureCoeffClamped: 0, vorticity: 0, isSeparated: false,
      };
      const dtPiv = isPaused ? 0 : Math.min(0.04, dtReal * 1.35);
      const spanTotal = Math.max(4.0, frame.xRecycle - frame.xSpawn);

      ctx.save();
      ctx.lineWidth = 1.65;
      ctx.lineCap = 'round';
      for (let i = 0; i < activeCount; i++) {
        let px = pool.x[i];
        let py = pool.y[i];
        let pz = pool.z[i];

        if (!isPaused) {
          FluidDynamics3D.stepParticleRK2(px, py, pz, fluid3DParams, dtPiv, frame.dsMax, scratchPos, scratchVel);
          px = scratchPos.x;
          py = scratchPos.y;
          pz = scratchPos.z;
        } else {
          const vNow = FluidDynamics3D.getVelocity({ x: px, y: py, z: pz }, fluid3DParams);
          scratchVel.u = vNow.u;
          scratchVel.v = vNow.v;
          scratchVel.w = vNow.w;
          scratchVel.speed = vNow.speed;
          scratchVel.pressureCoeffClamped = vNow.pressureCoeffClamped;
          scratchVel.vorticity = vNow.vorticity;
          scratchVel.isSeparated = vNow.isSeparated;
        }

        if (
          px > frame.xRecycle ||
          px < frame.xSpawn - 2.0 ||
          Math.abs(py - frame.yMid) > frame.yHalf * 2.8 ||
          Math.abs(pz) > frame.zHalf * 2.2
        ) {
          const isInner = pool.inner[i] === 1;
          px = frame.xSpawn;
          py = frame.yMid + (Math.random() * 2 - 1) * frame.yHalf * (isInner ? 0.65 : 1.05);
          pz = (Math.random() * 2 - 1) * frame.zHalf * (isInner ? 0.72 : 1.05);
          if (!FluidDynamics3D.isValidEmitterSeed(px, py, pz, fluid3DParams)) {
            py = frame.yMid + (py >= frame.yMid ? 1 : -1) * Math.max(0.8, frame.yHalf);
          }
        }

        pool.x[i] = px;
        pool.y[i] = py;
        pool.z[i] = pz;

        const invS = scratchVel.speed > 1e-4 ? 1 / scratchVel.speed : 1;
        const tailLen = Math.min(0.85, Math.max(0.1, scratchVel.speed * 0.14));
        const pHead = project3Dto2D({ x: px, y: py, z: pz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        const pTail = project3Dto2D(
          {
            x: px - scratchVel.u * invS * tailLen,
            y: py - scratchVel.v * invS * tailLen,
            z: pz - scratchVel.w * invS * tailLen,
          },
          camX, camY, camZ, viewMatrix, focalLength, cx, cy
        );
        if (pHead && pTail) {
          const lifeIn = Math.min(1, Math.max(0, (px - frame.xSpawn) / (0.12 * spanTotal)));
          const lifeOut = Math.min(1, Math.max(0, (frame.xRecycle - px) / (0.15 * spanTotal)));
          const alpha = Math.min(lifeIn, lifeOut) * Math.min(0.95, 0.45 + params.smoke_density * 0.4);
          if (alpha > 0.04) {
            const rgb = scratchVel.isSeparated
              ? '244, 86, 76'
              : scratchVel.vorticity > 1.35
              ? '72, 214, 252'
              : scratchVel.pressureCoeffClamped < -0.25
              ? '56, 189, 248'
              : '165, 232, 252';
            ctx.strokeStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(pTail.x, pTail.y);
            ctx.lineTo(pHead.x, pHead.y);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // 4b. Vector Quiver Grid Overlay (when show_quiver is active)
    if (params.show_quiver) {
      ctx.save();
      ctx.lineWidth = 1.3;
      for (let qx = -8; qx <= 10; qx += 3.0) {
        for (let qy = -1.6; qy <= 2.4; qy += 1.3) {
          for (let qz = -4.5; qz <= 4.5; qz += 3.0) {
            const vel = FluidDynamics3D.getVelocity({ x: qx, y: qy, z: qz }, fluid3DParams);
            const s = vel.speed || 1;
            const len = Math.min(1.5, 0.45 + s * 0.4);
            const p0 = project3Dto2D({ x: qx, y: qy, z: qz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
            const p1 = project3Dto2D(
              { x: qx + (vel.u / s) * len, y: qy + (vel.v / s) * len, z: qz + (vel.w / s) * len },
              camX, camY, camZ, viewMatrix, focalLength, cx, cy
            );
            if (p0 && p1) {
              ctx.strokeStyle = vel.isSeparated
                ? 'rgba(239, 68, 68, 0.78)'
                : vel.pressureCoeffClamped < -0.5
                ? 'rgba(56, 189, 248, 0.78)'
                : vel.pressureCoeffClamped > 0.2
                ? 'rgba(245, 158, 11, 0.78)'
                : 'rgba(52, 211, 153, 0.7)';
              ctx.beginPath();
              ctx.moveTo(p0.x, p0.y);
              ctx.lineTo(p1.x, p1.y);
              ctx.stroke();
            }
          }
        }
      }
      ctx.restore();
    }

    // 5. Dynamic 3D Model Transformation & Aeroelastic Buffet Vibration
    // Fully dynamic model responds to flaps, aoa trim, airspeed, and lift force
    const rawModel = getAircraft3DModel(
      params.modelType, 
      params.flaps_deg, 
      params.angle_of_attack, 
      params.airspeed_kts, 
      telemetry.lift_N
    );
    
    // Dynamic aeroelastic buffet trembles the aircraft pitch in high-alpha or stall
    const buffetShake = telemetry.isStalled 
      ? Math.sin(now * 0.04) * 1.5 + Math.cos(now * 0.07) * 0.95 
      : (params.angle_of_attack > 14 ? Math.sin(now * 0.03) * 0.28 : 0);
    const activeAoA = params.angle_of_attack + buffetShake;

    const pitchRad = (activeAoA * Math.PI) / 180;
    const cosP = Math.cos(pitchRad);
    const sinP = Math.sin(pitchRad);

    // Transform vertices (pitching nose-up about aerodynamic center):
    // In relative wind from left (-X), positive AoA pitches nose (x < 0) UP (+Y) and tail (x > 0) DOWN (-Y)
    const transformedVerts: Vertex3D[] = rawModel.vertices.map((v) => {
      const xRot = v.x * cosP + v.y * sinP;
      const yRot = -v.x * sinP + v.y * cosP;
      return { x: xRot, y: yRot, z: v.z };
    });

    // Project all vertices to screen
    const projectedVerts = transformedVerts.map((v) =>
      project3Dto2D(v, camX, camY, camZ, viewMatrix, focalLength, cx, cy)
    );

    // 6. Dynamic 3D Surface Pressure Colormap & Shading (Painter's Algorithm)
    const lightDir = { x: -0.4, y: 0.85, z: 0.45 };
    const lLen = Math.hypot(lightDir.x, lightDir.y, lightDir.z);
    lightDir.x /= lLen;
    lightDir.y /= lLen;
    lightDir.z /= lLen;

    const renderedFaces = rawModel.faces
      .map((face) => {
        const v0 = transformedVerts[face.indices[0]];
        // Newell normal: correct for concave / near-collinear polygons (delta wings), unlike a 3-point cross product
        const norm = computeFaceNormal(transformedVerts, face.indices);

        let avgZ = 0;
        let valid = true;
        for (const idx of face.indices) {
          const p = projectedVerts[idx];
          if (!p) {
            valid = false;
            break;
          }
          avgZ += p.depth;
        }
        avgZ /= face.indices.length;

        // Diffuse Lambertian Shading
        const dot = Math.max(0, norm.x * lightDir.x + norm.y * lightDir.y + norm.z * lightDir.z);
        const ambient = 0.42;
        const intensity = ambient + 0.58 * dot;

        // Specular Blinn-Phong Highlight
        const viewVec = { x: camX - v0.x, y: camY - v0.y, z: camZ - v0.z };
        const vLen = Math.hypot(viewVec.x, viewVec.y, viewVec.z);
        const vNorm = { x: viewVec.x / (vLen || 1), y: viewVec.y / (vLen || 1), z: viewVec.z / (vLen || 1) };
        const halfX = lightDir.x + vNorm.x;
        const halfY = lightDir.y + vNorm.y;
        const halfZ = lightDir.z + vNorm.z;
        const hLen = Math.hypot(halfX, halfY, halfZ);
        const nDotH = Math.max(0, (norm.x * halfX + norm.y * halfY + norm.z * halfZ) / (hLen || 1));
        const spec = Math.pow(nDotH, face.isCanopy ? 32 : 14) * (face.isCanopy ? 0.8 : 0.35);

        return { face, norm, avgZ, intensity, spec, valid };
      })
      .filter((item) => item.valid);

    // Sort back-to-front
    renderedFaces.sort((a, b) => b.avgZ - a.avgZ);

    // Draw faces with Dynamic Aerodynamic CFD Pressure or Realistic Livery
    ctx.lineWidth = 1;
    for (const item of renderedFaces) {
      const { face, intensity, spec, norm } = item;
      const pts = face.indices.map((i) => projectedVerts[i]!);

      // DYNAMIC COLOR COMPUTATION:
      let dynamicColor = face.baseColor;

      if (face.isCanopy) {
        dynamicColor = face.baseColor; // Canopy glass (iridescent gold/tinted)
      } else if (face.isAfterburner) {
        // Glowing pulsing afterburner flame cone
        dynamicColor = params.airspeed_kts > 450 ? (now % 200 > 100 ? '#f97316' : '#ef4444') : '#78350f';
      } else if (params.show_heatmap) {
        // REAL-TIME CFD SURFACE PRESSURE HEATMAP MODE
        // Local pressure coefficient Cp estimation
        let localCp = 0.0;
        if (norm.x < -0.3) {
          // Stagnation face facing relative wind
          localCp = 0.5 + Math.abs(norm.x) * 0.5;
        } else if (face.isWing || norm.y > 0.05) {
          if (norm.y > 0.05) {
            // Upper suction crest
            const chordFrac = face.chordFraction ?? 0.3;
            const suctionPeak = Math.max(0.3, telemetry.cl) * (1.8 / Math.sqrt(Math.max(0.08, chordFrac)));
            localCp = -suctionPeak;
          } else {
            // Lower compression
            localCp = Math.max(0, telemetry.cl * 0.45);
          }
        } else {
          localCp = norm.y < -0.1 ? 0.3 : -0.2;
        }
        dynamicColor = getCfdHeatmapColor(localCp, telemetry.isStalled);
      } else if (telemetry.isStalled && (face.isWing || norm.y > 0.15)) {
        // Dynamic Stall Warning: Boundary layer separation in incandescent crimson
        dynamicColor = '#ef4444';
      } else if (face.isWing) {
        if (norm.y > 0.05) {
          // Upper surface: Bernoulli Suction (Vibrant Sky Blue / Cyan)
          dynamicColor = telemetry.cl > 0.8 ? '#0284c7' : '#38bdf8';
        } else {
          // Lower surface: Dynamic Compression (Warm Amber)
          dynamicColor = '#f59e0b';
        }
      }

      ctx.save();
      ctx.fillStyle = dynamicColor;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Shadow overlay
      const shadowAlpha = Math.max(0, 1 - intensity) * 0.45;
      if (shadowAlpha > 0.02) {
        ctx.fillStyle = `rgba(0, 0, 0, ${shadowAlpha})`;
        ctx.fill();
      }

      // Specular highlight sheen
      if (spec > 0.05) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.55, spec)})`;
        ctx.fill();
      }

      ctx.restore();
    }

    // 7. Dynamic Supersonic Afterburner Exhaust Plumes with Pulsing Mach Diamonds
    if (params.airspeed_kts >= 480 && rawModel.exhaustPoints) {
      ctx.save();
      for (const ep of rawModel.exhaustPoints) {
        // Rotate exhaust point with aircraft pitch (nose up, tail down)
        const exX = ep.x * cosP + ep.y * sinP;
        const exY = -ep.x * sinP + ep.y * cosP;
        const plumeLen = 2.8 + (params.airspeed_kts / 1000) * 1.5;
        const exTip = { x: exX + plumeLen * cosP, y: exY - plumeLen * sinP, z: ep.z };

        const pBase = project3Dto2D({ x: exX, y: exY, z: ep.z }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        const pTip = project3Dto2D(exTip, camX, camY, camZ, viewMatrix, focalLength, cx, cy);

        if (pBase && pTip) {
          // Fiery supersonic exhaust plume gradient
          const grad = ctx.createLinearGradient(pBase.x, pBase.y, pTip.x, pTip.y);
          grad.addColorStop(0, '#fde047');
          grad.addColorStop(0.3, '#f97316');
          grad.addColorStop(0.7, '#ef4444');
          grad.addColorStop(1, 'rgba(239, 68, 68, 0)');

          ctx.strokeStyle = grad;
          ctx.lineWidth = 7 + Math.sin(now * 0.05) * 2;
          ctx.beginPath();
          ctx.moveTo(pBase.x, pBase.y);
          ctx.lineTo(pTip.x, pTip.y);
          ctx.stroke();

          // Dynamic Mach Shock Diamond Discs inside the supersonic exhaust core
          for (let d = 1; d <= 3; d++) {
            const frac = d * 0.25;
            const diaX = exX + plumeLen * frac * cosP;
            const diaY = exY + plumeLen * frac * sinP;
            const pDia = project3Dto2D({ x: diaX, y: diaY, z: ep.z }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
            if (pDia) {
              ctx.fillStyle = '#67e8f9';
              ctx.beginPath();
              ctx.arc(pDia.x, pDia.y, 2.5 + Math.sin(now * 0.08 + d) * 1, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
      ctx.restore();
    }



    // 10. Dynamic Supersonic Mach Shockwave Cone & Transonic Vapor Cloud (Mach >= 0.92)
    if (params.show_shockwaves && telemetry.mach >= 0.92) {
      const mach = telemetry.mach;
      const noseTip = transformedVerts[0] || { x: -6.0, y: 0, z: 0 };

      // Transonic Vapor Cloud (Prandtl-Glauert Singularity condensation cone near Mach 1)
      if (mach >= 0.92 && mach <= 1.28) {
        const vaporProgress = Math.sin(((mach - 0.92) / 0.36) * Math.PI);
        const vaporAlpha = Math.max(0, Math.min(0.55, vaporProgress * 0.6));
        
        ctx.save();
        ctx.strokeStyle = `rgba(186, 230, 253, ${vaporAlpha})`;
        ctx.fillStyle = `rgba(56, 189, 248, ${vaporAlpha * 0.25})`;
        ctx.lineWidth = 3;

        // Vapor condensation disk behind cockpit
        const vDiskDist = 2.4;
        const vDiskRadius = 2.2 + Math.sin(now * 0.02) * 0.2;
        ctx.beginPath();
        let diskStarted = false;
        for (let a = 0; a <= 20; a++) {
          const angle = (2 * Math.PI * a) / 20;
          const vy = noseTip.y - vDiskDist * sinP + Math.cos(angle) * vDiskRadius * cosP;
          const vz = Math.sin(angle) * vDiskRadius;
          const vx = noseTip.x + vDiskDist * cosP + Math.cos(angle) * vDiskRadius * sinP;

          const proj = project3Dto2D({ x: vx, y: vy, z: vz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
          if (proj) {
            if (!diskStarted) {
              ctx.moveTo(proj.x, proj.y);
              diskStarted = true;
            } else {
              ctx.lineTo(proj.x, proj.y);
            }
          }
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Supersonic Mach Cone Rings (Mach >= 1.0)
      if (mach >= 1.0) {
        const mu = Math.asin(1 / mach); // Mach angle
        ctx.save();
        const shockColor = mach >= 1.5 ? '#f97316' : '#38bdf8';
        ctx.strokeStyle = shockColor;
        ctx.lineWidth = 2.2;
        ctx.shadowColor = shockColor;
        ctx.shadowBlur = 10;

        const ringDistances = [3, 7, 12];
        for (const d of ringDistances) {
          const ringX = noseTip.x + d * cosP;
          const ringY = noseTip.y - d * sinP;
          const rCurrent = d * Math.tan(mu);

          ctx.beginPath();
          let ringStarted = false;
          for (let a = 0; a <= 24; a++) {
            const angle = (2 * Math.PI * a) / 24;
            const vy = ringY + Math.cos(angle) * rCurrent * cosP;
            const vz = Math.sin(angle) * rCurrent;
            const vx = ringX + Math.cos(angle) * rCurrent * sinP;

            const proj = project3Dto2D({ x: vx, y: vy, z: vz }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
            if (proj) {
              if (!ringStarted) {
                ctx.moveTo(proj.x, proj.y);
                ringStarted = true;
              } else {
                ctx.lineTo(proj.x, proj.y);
              }
            }
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 11. Dynamic 3D Aerodynamic Lift & Drag Force Vectors (Proportional & Zero-Lift Aware)
    if (params.show_pressure_vectors) {
      const acPos = { x: 0, y: 0, z: 0 };
      const acProj = project3Dto2D(acPos, camX, camY, camZ, viewMatrix, focalLength, cx, cy);

      if (acProj) {
        const isZeroLift = Math.abs(telemetry.lift_N) < 50 || Math.abs(telemetry.cl) < 0.002;
        const effectiveLiftN = isZeroLift ? 0 : telemetry.lift_N;
        const absEffLift = Math.abs(effectiveLiftN);
        const absDrag = Math.abs(telemetry.drag_N) < 1 ? 0 : Math.abs(telemetry.drag_N);
        const resForce = Math.hypot(absEffLift, absDrag);

        const totalVisualLen =
          resForce >= 1
            ? Math.min(5.8, Math.max(0.45, 1.15 * Math.pow(resForce / 1000, 0.23)))
            : 0;
        const scale = resForce >= 1 ? totalVisualLen / resForce : 0;

        const buffet = !isZeroLift && telemetry.isStalled ? (Math.random() - 0.5) * 0.25 : 0;
        const liftSign = effectiveLiftN >= 0 ? 1 : -1;
        const liftLen = isZeroLift ? 0 : liftSign * Math.max(0.15, absEffLift * scale) + buffet;
        const dragLen = absDrag * scale;

        const liftTip = { x: 0, y: liftLen, z: 0 };
        const liftProj = !isZeroLift
          ? project3Dto2D(liftTip, camX, camY, camZ, viewMatrix, focalLength, cx, cy)
          : null;

        const dragTip = { x: dragLen, y: 0, z: 0 };
        const dragProj = dragLen >= 0.05
          ? project3Dto2D(dragTip, camX, camY, camZ, viewMatrix, focalLength, cx, cy)
          : null;

        ctx.save();
        // Aerodynamic Center Gimbal Marker
        ctx.strokeStyle = '#38bdf8';
        ctx.fillStyle = '#0284c7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(acProj.x, acProj.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 1. Draw Lift Vector Arrow (Hidden at zero lift, inverted downward if L < 0)
        if (liftProj && !isZeroLift) {
          const isUp = liftProj.y < acProj.y;
          const liftColor = telemetry.isStalled ? '#ef4444' : '#10b981';
          ctx.strokeStyle = liftColor;
          ctx.fillStyle = liftColor;
          ctx.lineWidth = 3;

          ctx.beginPath();
          ctx.moveTo(acProj.x, acProj.y);
          ctx.lineTo(liftProj.x, liftProj.y);
          ctx.stroke();

          // Arrowhead
          const angleL = Math.atan2(liftProj.y - acProj.y, liftProj.x - acProj.x);
          ctx.beginPath();
          ctx.moveTo(liftProj.x, liftProj.y);
          ctx.lineTo(liftProj.x - 10 * Math.cos(angleL - Math.PI / 6), liftProj.y - 10 * Math.sin(angleL - Math.PI / 6));
          ctx.lineTo(liftProj.x - 10 * Math.cos(angleL + Math.PI / 6), liftProj.y - 10 * Math.sin(angleL + Math.PI / 6));
          ctx.closePath();
          ctx.fill();

          // Text label
          ctx.font = 'bold 11px ui-monospace, SFMono-Regular, monospace';
          const liftText = `LIFT: ${(telemetry.lift_N / 1000).toFixed(1)} kN`;
          ctx.fillText(liftText, liftProj.x + 8, isUp ? liftProj.y - 6 : liftProj.y + 16);
        }

        // 2. Draw Drag Vector Arrow (Vibrant Amber)
        if (dragProj) {
          const dragColor = '#f59e0b';
          ctx.strokeStyle = dragColor;
          ctx.fillStyle = dragColor;
          ctx.lineWidth = 3;

          ctx.beginPath();
          ctx.moveTo(acProj.x, acProj.y);
          ctx.lineTo(dragProj.x, dragProj.y);
          ctx.stroke();

          // Arrowhead
          const angleD = Math.atan2(dragProj.y - acProj.y, dragProj.x - acProj.x);
          ctx.beginPath();
          ctx.moveTo(dragProj.x, dragProj.y);
          ctx.lineTo(dragProj.x - 10 * Math.cos(angleD - Math.PI / 6), dragProj.y - 10 * Math.sin(angleD - Math.PI / 6));
          ctx.lineTo(dragProj.x - 10 * Math.cos(angleD + Math.PI / 6), dragProj.y - 10 * Math.sin(angleD + Math.PI / 6));
          ctx.closePath();
          ctx.fill();

          // Text label
          ctx.font = 'bold 11px ui-monospace, SFMono-Regular, monospace';
          const dragText = `DRAG: ${(telemetry.drag_N / 1000).toFixed(1)} kN`;
          ctx.fillText(dragText, dragProj.x + 8, dragProj.y + 14);
        }

        ctx.restore();
      }
    }

    // 12. Phase 4 Engineering Annotations (Stagnation, x_tr, x_sep, Bound Vortex Filaments, Downwash)
    if (
      params.show_stagnation_annotation ||
      params.show_transition_annotation ||
      params.show_separation_annotation ||
      params.show_vortex_filaments ||
      params.show_downwash_vectors
    ) {
      const halfSpan = surfaceField?.halfSpan ?? 5.5;
      const isWingOnly =
        params.modelType === 'naca0012' ||
        params.modelType === 'naca2412' ||
        params.modelType === 'validation_wing' ||
        params.modelType === 'custom_airfoil';
      const refZ = isWingOnly ? 0 : halfSpan * 0.42;
      const sec = { leX: -3.0, teX: 3.0, quarterChordX: -1.5, chord: 6.0, yMid: 0, thickness: 0.45 };
      if (surfaceField) surfaceField.getSpanSection(refZ, sec);
      const chord = Math.max(0.6, sec.chord);
      const spanLimit = Math.max(1.0, halfSpan * 0.9);
      const rotPt = (x: number, y: number, z: number): Vertex3D => ({
        x: x * cosP + y * sinP,
        y: -x * sinP + y * cosP,
        z,
      });

      ctx.save();
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, monospace';

      if (params.show_stagnation_annotation) {
        const sx = sec.leX + telemetry.stagnationXc * chord;
        const sy = sec.yMid - Math.sin(pitchRad) * Math.max(0.12, sec.thickness * 0.25);
        const pStag = project3Dto2D(rotPt(sx, sy, isWingOnly ? 0 : refZ), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        if (pStag) {
          ctx.fillStyle = '#f59e0b';
          ctx.strokeStyle = '#fde047';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pStag.x, pStag.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillText(`STAG ${(telemetry.stagnationXc * 100).toFixed(0)}%`, pStag.x + 8, pStag.y - 4);
        }
      }

      if (params.show_transition_annotation) {
        const tx = sec.leX + telemetry.xTransitionUpper * chord;
        const ty = sec.yMid + Math.max(0.18, sec.thickness * 0.5);
        const pA = project3Dto2D(rotPt(tx, ty, -spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        const pB = project3Dto2D(rotPt(tx, ty, spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        if (pA && pB) {
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();
          ctx.fillStyle = '#34d399';
          ctx.fillText(`x_tr ${(telemetry.xTransitionUpper * 100).toFixed(0)}%`, pB.x + 6, pB.y);
        }
      }

      if (params.show_separation_annotation && telemetry.xSeparationUpper < 0.995) {
        const spx = sec.leX + telemetry.xSeparationUpper * chord;
        const spy = sec.yMid + Math.max(0.2, sec.thickness * 0.54);
        const pA = project3Dto2D(rotPt(spx, spy, -spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        const pB = project3Dto2D(rotPt(spx, spy, spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        if (pA && pB) {
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();
          ctx.fillStyle = '#f87171';
          ctx.fillText(`x_sep ${(telemetry.xSeparationUpper * 100).toFixed(0)}%`, pB.x + 6, pB.y + 10);
        }
      }

      if (params.show_vortex_filaments) {
        const pA = project3Dto2D(rotPt(sec.quarterChordX, sec.yMid, -spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        const pB = project3Dto2D(rotPt(sec.quarterChordX, sec.yMid, spanLimit), camX, camY, camZ, viewMatrix, focalLength, cx, cy);
        if (pA && pB) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.8;
          ctx.beginPath();
          ctx.moveTo(pA.x, pA.y);
          ctx.lineTo(pB.x, pB.y);
          ctx.stroke();
          ctx.fillStyle = '#7dd3fc';
          ctx.fillText(`Γ ${telemetry.boundCirculation_m2_s.toFixed(0)} m²/s`, pB.x + 6, pB.y - 6);
        }
      }

      if (params.show_downwash_vectors) {
        const epsRad = (telemetry.downwashAngle_deg * Math.PI) / 180;
        const teWorld = rotPt(sec.teX, sec.yMid, 0);
        const dx = Math.cos(epsRad) * 2.0;
        const dy = -Math.sin(epsRad) * 2.0;
        for (const zPos of [-spanLimit * 0.6, 0, spanLimit * 0.6]) {
          const p0 = project3Dto2D({ x: teWorld.x + 0.5, y: teWorld.y, z: zPos }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
          const p1 = project3Dto2D({ x: teWorld.x + 0.5 + dx, y: teWorld.y + dy, z: zPos }, camX, camY, camZ, viewMatrix, focalLength, cx, cy);
          if (p0 && p1) {
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    // Request next frame
    animFrameIdRef.current = requestAnimationFrame(render);
  }, [params, telemetry, isPaused, isAutoOrbit, project3Dto2D, surfaceField]);

  // Start / restart render loop
  useEffect(() => {
    animFrameIdRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current);
    };
  }, [render]);

  // Handle Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
      }
    };

    handleResize();
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', handleResize);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // Mouse & Touch 3D Camera Orbit Controls & Shift-Drag AoA Pitching
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    isShiftDragRef.current = e.shiftKey;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };

    if (isShiftDragRef.current) {
      // Shift+Drag pitches Angle of Attack directly
      const deltaAoa = -dy * 0.2;
      const newAoa = Math.max(-20, Math.min(35, params.angle_of_attack + deltaAoa));
      onParamChange('angle_of_attack', parseFloat(newAoa.toFixed(1)));
    } else {
      // Orbit camera
      const cam = cameraStateRef.current;
      cam.theta -= dx * 0.008;
      cam.phi = Math.max(-1.45, Math.min(1.45, cam.phi + dy * 0.008));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  // Scroll to Zoom in 3D
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const cam = cameraStateRef.current;
    cam.distance = Math.max(8, Math.min(32, cam.distance + e.deltaY * 0.02));
  };

  return (
    <div className="relative w-full h-full min-h-[220px] sm:min-h-[360px] lg:min-h-[460px] rounded-xl overflow-hidden border border-[var(--border)] bg-[#0D1114] select-none shadow-[var(--shadow-tech)]">
      {/* Real 3D Canvas */}
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        className="w-full h-full block touch-none cursor-grab active:cursor-grabbing"
      />

      {/* Top Left: 3D Aircraft Model Telemetry Overlay */}
      <div className="absolute top-2.5 left-2.5 right-36 sm:right-auto flex flex-col items-start gap-1.5 pointer-events-none">
        <div className="px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg bg-[#151A1E]/95 border border-slate-700/80 flex flex-wrap items-center gap-x-1.5 sm:gap-x-2 gap-y-0.5 text-[11px] sm:text-xs">
          <span className="font-semibold text-slate-100 font-sans">
            {AIRCRAFT_MODELS[params.modelType].name}
          </span>
          <span className="text-slate-500 shrink-0" aria-hidden="true">·</span>
          <span className="text-sky-300 font-mono font-semibold tabular-nums shrink-0">
            α {params.angle_of_attack >= 0 ? '+' : ''}{params.angle_of_attack.toFixed(1)}°
          </span>
          <span className="text-slate-500" aria-hidden="true">·</span>
          <span className="sm:hidden text-slate-300 font-mono text-[10px]">
            Reduced-Order Biot–Savart VLM
          </span>
          <span className="hidden sm:inline text-slate-300 font-mono text-[11px]">
            Reduced-Order Biot–Savart Vortex-Lattice &amp; Approximate SDF Model
          </span>
        </div>

        {telemetry.isStalled && (
          <div className="px-3 py-1.5 rounded-lg bg-red-950/95 border border-red-500/70 flex items-center gap-1.5">
            <Warning weight="duotone" className="w-4 h-4 text-red-400" />
            <span className="text-xs font-bold text-red-100 uppercase tracking-wider font-mono">
              STALL DETECTED
            </span>
          </div>
        )}

        {telemetry.mach >= 1.0 && (
          <div className="px-3 py-1.5 rounded-lg bg-[#151A1E]/95 border border-amber-500/60 flex items-center gap-1.5">
            <Lightning weight="duotone" className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-bold text-amber-200 font-mono tabular-nums">
              MACH {telemetry.mach.toFixed(2)} SHOCK CONE
            </span>
          </div>
        )}

        {params.airspeed_kts >= 480 && (
          <div className="px-3 py-1.5 rounded-lg bg-[#151A1E]/95 border border-orange-500/60 flex items-center gap-1.5">
            <Flame weight="duotone" className="w-4 h-4 text-orange-400" />
            <span className="text-xs font-bold text-orange-200 font-mono">
              AFTERBURNER ACTIVE
            </span>
          </div>
        )}
      </div>

      {/* Top Right: Camera Presets & Dynamic Features */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {onOpenWebGL && (
          <button
            onClick={onOpenWebGL}
            className="px-3 py-1.5 rounded-lg bg-[#1769AA] hover:bg-[#1e7bc4] text-white text-xs font-semibold transition-colors flex items-center gap-1.5"
            title="Switch to Hardware WebGL 3D Engine"
          >
            <Cube weight="duotone" className="w-4 h-4" />
            <span className="hidden sm:inline">WebGL 3D</span>
          </button>
        )}

        {onOpenModelInspector && (
          <button
            onClick={onOpenModelInspector}
            className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-[#151A1E]/95 hover:bg-slate-800 border border-slate-700/80 text-slate-200 hover:text-white text-xs font-semibold transition-colors flex items-center gap-1.5"
            title="Inspect 3D CAD Asset"
          >
            <Cube weight="duotone" className="w-4 h-4 text-sky-400" />
            <span className="hidden md:inline">Inspect CAD</span>
          </button>
        )}

        <div className="hidden sm:flex items-center gap-1 p-1 rounded-lg bg-[#151A1E]/95 border border-slate-700/80">
          <button
            onClick={() => setCameraPreset('side')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              activePreset === 'side' ? 'bg-[#1769AA] text-white' : 'text-slate-300 hover:text-white'
            }`}
          >
            Profile
          </button>
          <button
            onClick={() => setCameraPreset('iso')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              activePreset === 'iso' ? 'bg-[#1769AA] text-white' : 'text-slate-300 hover:text-white'
            }`}
          >
            Isometric
          </button>
          <button
            onClick={() => setCameraPreset('top')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              activePreset === 'top' ? 'bg-[#1769AA] text-white' : 'text-slate-300 hover:text-white'
            }`}
          >
            Planform
          </button>
          <button
            onClick={() => setCameraPreset('chase')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              activePreset === 'chase' ? 'bg-[#1769AA] text-white' : 'text-slate-300 hover:text-white'
            }`}
          >
            Chase
          </button>
        </div>

        {/* 360 Orbit Toggle */}
        <button
          onClick={() => setIsAutoOrbit((prev) => !prev)}
          className={`p-2 rounded-lg border transition-colors ${
            isAutoOrbit
              ? 'bg-[#1769AA] text-white border-[#1769AA]'
              : 'bg-[#151A1E]/95 text-slate-300 border-slate-700/80 hover:text-white'
          }`}
          title={isAutoOrbit ? 'Stop 360° Orbit' : 'Start 360° Orbit'}
        >
          <CompassRose weight="duotone" className="w-4 h-4" />
        </button>

        {/* Force Vectors Toggle */}
        <button
          onClick={() => onParamChange('show_pressure_vectors', !params.show_pressure_vectors)}
          className={`p-2 rounded-lg border transition-colors ${
            params.show_pressure_vectors
              ? 'bg-[#1769AA] text-white border-[#1769AA]'
              : 'bg-[#151A1E]/95 text-slate-300 border-slate-700/80 hover:text-white'
          }`}
          title={params.show_pressure_vectors ? 'Hide 3D Force Vectors' : 'Show 3D Force Vectors'}
        >
          <ArrowUpRight weight="bold" className="w-4 h-4" />
        </button>

        {/* Audio Toggle */}
        <button
          onClick={() => onParamChange('audio_enabled', !params.audio_enabled)}
          className={`p-2 rounded-lg border transition-colors ${
            params.audio_enabled
              ? 'bg-[#1769AA] text-white border-[#1769AA]'
              : 'bg-[#151A1E]/95 text-slate-300 border-slate-700/80 hover:text-white'
          }`}
          title={params.audio_enabled ? 'Mute Wind Tunnel Audio' : 'Enable Wind Tunnel Audio'}
        >
          {params.audio_enabled ? <SpeakerHigh weight="duotone" className="w-4 h-4" /> : <SpeakerSlash weight="duotone" className="w-4 h-4" />}
        </button>

        {/* Reset Camera */}
        <button
          onClick={() => setCameraPreset('iso')}
          className="p-2 rounded-lg bg-[#151A1E]/95 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-700/80 transition-colors"
          title="Reset Camera"
        >
          <ArrowsClockwise weight="bold" className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom Floating Legend */}
      <div className="absolute bottom-2.5 left-2.5 right-2.5 flex flex-col gap-1.5 pointer-events-none text-[10px] sm:text-xs text-slate-300">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 bg-[#151A1E]/95 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg border border-slate-700/80">
            <span className="hidden sm:inline text-slate-100 font-medium">Canvas 3D</span>
            <span className="hidden sm:inline text-slate-500" aria-hidden="true">·</span>
            <span className="hidden md:inline text-sky-300">Drag to Orbit</span>
            <span className="hidden md:inline text-slate-500" aria-hidden="true">·</span>
            <span className="hidden md:inline text-amber-300">Shift+Drag to Pitch AoA</span>
            <span className="hidden md:inline text-slate-500" aria-hidden="true">·</span>
            <div className="flex items-center gap-1.5 sm:gap-2 md:pl-1 md:border-l md:border-slate-700/80">
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              <span className="text-[10px] sm:text-[11px] text-sky-300 font-mono">Suction</span>
              <span className="w-2 h-2 rounded-full bg-amber-400 ml-0.5" />
              <span className="text-[10px] sm:text-[11px] text-amber-300 font-mono">Press</span>
              {params.show_streamlines && (
                <>
                  <span className="w-2 h-2 rounded-full bg-cyan-300 ml-0.5" />
                  <span className="text-[10px] sm:text-[11px] text-cyan-200 font-mono">Smoke</span>
                </>
              )}
              {params.show_particles && (
                <>
                  <span className="w-2 h-2 rounded-full bg-sky-300 ml-0.5" />
                  <span className="text-[10px] sm:text-[11px] text-sky-200 font-mono">PIV</span>
                </>
              )}
              {params.show_pressure_vectors && (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 ml-0.5" />
                  <span className="text-[10px] sm:text-[11px] text-emerald-300 font-mono">Lift</span>
                  <span className="w-2 h-2 rounded-full bg-amber-500 ml-0.5" />
                  <span className="text-[10px] sm:text-[11px] text-amber-400 font-mono">Drag</span>
                </>
              )}
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2 bg-[#151A1E]/95 px-3 py-1.5 rounded-lg border border-slate-700/80 font-mono tabular-nums shrink-0">
            <Pulse weight="duotone" className="w-4 h-4 text-emerald-400" />
            <span className="text-emerald-300 font-semibold">L/D: {telemetry.ldRatio.toFixed(1)}:1</span>
            <span className="text-slate-500" aria-hidden="true">·</span>
            <span className="text-sky-300">q: {(telemetry.dynamic_pressure_pa / 1000).toFixed(1)} kPa</span>
          </div>
        </div>
      </div>
    </div>
  );
};