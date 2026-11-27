import {
  SimulationRequest,
  SiPhysicsInput,
  Fluid3DFlowInput,
  Lbm2DInput,
  GeometryAnalyzeInput,
  ExportReportInput,
} from '../simulation/contracts/SimulationInput';
import {
  SiPhysicsOutput,
  Fluid3DFlowOutput,
  LbmDiagnosticsReport,
  GeometryAnalyzeOutput,
  ExportReportOutput,
  PolarPointResult,
} from '../simulation/contracts/SimulationOutput';
import {
  buildAeroResultFromForces,
  buildAircraftGeometryContract,
  deriveFlowConditions,
} from '../simulation/contracts/ScientificContracts';
import { AIRCRAFT_MODELS, calculateAeroTelemetry } from '../utils/airfoilGenerators';
import { ISA_CONSTANTS } from '../lib/aeroPhysics';
import { computeBenchmarkDeviation } from '../data/nacaBenchmarks';
import { AircraftSurfaceField } from '../engine/AircraftSurfaceField';
import { getAircraft3DModel } from '../utils/aircraft3DGeometry';
import { FluidDynamics3D, Fluid3DParams } from '../engine/FluidDynamics3D';
import { validateRawTriangleSoup } from '../geometry/validation/meshValidator';
import { evaluateLbmDiagnostics, rasterizeLbmSolidMask } from '../lib/lbm/lbmDiagnostics';
import {
  buildEngineeringReportBundle,
  ensurePdfFontsLoaded,
  formatEngineeringReportMarkdown,
  generateEngineeringPdfBlob,
} from '../utils/engineeringReport';

export interface WorkerHandlerResult<T> {
  result: T;
  transferables?: Transferable[];
}

export function runPhysicsTask(
  input: SiPhysicsInput,
  onProgress?: (progress: number, stage?: string) => void
): WorkerHandlerResult<SiPhysicsOutput> {
  onProgress?.(0.15, 'Computing ISA atmosphere & dimensionless parameters');
  const cfg = AIRCRAFT_MODELS[input.modelType];
  const telemetry = calculateAeroTelemetry(
    input.modelType,
    input.angleOfAttackDeg,
    input.airspeedKts,
    input.altitudeFt,
    input.flapsDeg
  );

  const flow = deriveFlowConditions({
    altitude_m: input.altitudeFt * ISA_CONSTANTS.FT_TO_M,
    velocity_ms: input.airspeedKts * ISA_CONSTANTS.KTS_TO_MS,
    chord_m: cfg.chord,
    angleOfAttackDeg: input.angleOfAttackDeg,
    flapsDeg: input.flapsDeg,
  });

  const geometry = buildAircraftGeometryContract(cfg);
  const aeroResult = buildAeroResultFromForces({
    geometry,
    flow,
    cl: telemetry.cl,
    cd0: telemetry.cd0,
    cdSep: telemetry.cdSep,
    cdWave: telemetry.cdWave,
    kuttaTeDeltaCp: telemetry.kuttaTeDeltaCp,
    isStalled: telemetry.isStalled,
    stallMarginDeg: telemetry.stallMargin,
    flowState: telemetry.flowState,
  });

  const polarSweep: PolarPointResult[] = [];
  if (input.includePolarSweep !== false) {
    onProgress?.(0.55, 'Sweeping polar curve');
    const [aMin, aMax, aStep] = input.aoaSweepRange ?? [-12, 22, 1];
    const safeStep = Math.max(0.5, aStep);
    for (let aoa = aMin; aoa <= aMax + 1e-6; aoa += safeStep) {
      const pt = calculateAeroTelemetry(
        input.modelType,
        aoa,
        input.airspeedKts,
        input.altitudeFt,
        input.flapsDeg
      );
      polarSweep.push({
        aoaDeg: Number(aoa.toFixed(2)),
        cl: pt.cl,
        cd: pt.cd,
        ldRatio: pt.ldRatio,
        cdi: pt.cdi,
      });
    }
  }

  onProgress?.(0.85, 'Comparing against wind-tunnel benchmarks');
  const benchmarkDeviation = computeBenchmarkDeviation(
    input.modelType,
    telemetry,
    input.angleOfAttackDeg,
    polarSweep.map((p) => ({ aoa: p.aoaDeg, cl: p.cl, cd: p.cd }))
  );

  onProgress?.(1.0, 'Complete');
  return {
    result: {
      telemetry,
      flow,
      geometry,
      aeroResult,
      polarSweep,
      benchmarkDeviation,
    },
  };
}

export function runFluid3DTask(
  input: Fluid3DFlowInput,
  includeSdfBuffer: boolean,
  onProgress?: (progress: number, stage?: string) => void
): WorkerHandlerResult<Fluid3DFlowOutput> {
  onProgress?.(0.2, 'Constructing 84x48x84 geometry SDF');
  let surfaceField: AircraftSurfaceField | null = null;
  if (input.meshSamplePoints && input.meshSamplePoints.length >= 3) {
    surfaceField = AircraftSurfaceField.fromRawPoints(input.meshSamplePoints, input.meshBounds);
  } else {
    surfaceField = AircraftSurfaceField.fromProceduralMesh(getAircraft3DModel(input.modelType));
  }

  onProgress?.(0.55, 'Integrating Biot-Savart + RK2 streamlines');
  const fluidParams: Fluid3DParams = {
    modelType: input.modelType,
    aoaDeg: input.aoaDeg,
    airspeed_kts: input.airspeedKts,
    mach: input.mach,
    altitude_ft: input.altitudeFt,
    flapsDeg: input.flapsDeg,
    viscosity: input.viscosity ?? 0.3,
    isStalled: input.isStalled,
    cl: input.cl,
    cd: input.cd,
    streamlineResolution: input.streamlineResolution ?? 1.0,
    surfaceField,
    calibration: input.calibration ?? null,
  };

  const frame = FluidDynamics3D.getDynamicEmitterFrame(
    surfaceField,
    input.rakeSpread ?? 1.0,
    input.streamlineResolution ?? 1.0
  );

  const tracePoints: number[] = [];
  const offsets: number[] = [];
  const seedYs = [-0.6, -0.25, 0.0, 0.25, 0.6];
  const seedZs = [-0.65, 0, 0.65];

  for (const ry of seedYs) {
    for (const rz of seedZs) {
      offsets.push(tracePoints.length / 6);
      const start = {
        x: frame.xSpawn,
        y: frame.yMid + ry * frame.yHalf,
        z: rz * frame.zHalf,
      };
      const pts = FluidDynamics3D.traceStreamline(start, fluidParams, 90, 0.24);
      for (const p of pts) {
        tracePoints.push(p.x, p.y, p.z, p.speed, p.pressureCoeff, p.vorticity);
      }
    }
  }
  offsets.push(tracePoints.length / 6);

  const streamlines = new Float32Array(tracePoints);
  const streamlineOffsets = new Uint32Array(offsets);
  const sdfBuffer = includeSdfBuffer && surfaceField ? surfaceField.exportSdfBuffer() : undefined;

  const transferables: Transferable[] = [streamlines.buffer, streamlineOffsets.buffer];
  if (sdfBuffer) transferables.push(sdfBuffer.buffer);

  onProgress?.(1.0, 'Complete');
  return {
    result: {
      bounds: {
        minX: surfaceField ? surfaceField.minX : -frame.halfLength,
        maxX: surfaceField ? surfaceField.maxX : frame.halfLength,
        minY: surfaceField ? surfaceField.minY : frame.yMid - frame.yHalf,
        maxY: surfaceField ? surfaceField.maxY : frame.yMid + frame.yHalf,
        minZ: surfaceField ? surfaceField.minZ : -frame.zHalf,
        maxZ: surfaceField ? surfaceField.maxZ : frame.zHalf,
        dMin: surfaceField ? surfaceField.dMin : 0.16,
        cellSize: surfaceField ? surfaceField.cellSize : 0.12,
      },
      gridResolution: { nx: 84, ny: 48, nz: 84 },
      streamlines,
      streamlineOffsets,
      sdfBuffer,
    },
    transferables,
  };
}

export function runGeometryTask(
  input: GeometryAnalyzeInput,
  onProgress?: (progress: number, stage?: string) => void
): WorkerHandlerResult<GeometryAnalyzeOutput> {
  onProgress?.(0.3, 'Scanning triangle topology & non-manifold edges');
  const report = validateRawTriangleSoup(input.positions, input.indices);
  onProgress?.(1.0, 'Complete');
  return { result: { report } };
}

export function runLbmDiagnosticsTask(
  input: Lbm2DInput,
  onProgress?: (progress: number, stage?: string) => void
): WorkerHandlerResult<LbmDiagnosticsReport> {
  onProgress?.(0.35, 'Rasterizing airfoil solid mask');
  const { mask, solidCellCount } = rasterizeLbmSolidMask(
    input.coords,
    input.alphaDeg,
    input.nx,
    input.ny
  );
  onProgress?.(0.75, 'Checking Mach & BGK relaxation stability');
  const diag = evaluateLbmDiagnostics({
    u0: input.u0,
    tau0: input.tau0,
    nx: input.nx,
    ny: input.ny,
    observedCl: input.observedCl,
    observedCd: input.observedCd,
    residualDelta: input.residualDelta,
    solidCellCount,
  });
  onProgress?.(1.0, 'Complete');
  return {
    result: {
      ...diag,
      solidMask: mask,
    },
    transferables: [mask.buffer],
  };
}

export function runExportReportTask(
  input: ExportReportInput,
  onProgress?: (progress: number, stage?: string) => void
): WorkerHandlerResult<ExportReportOutput> {
  onProgress?.(0.25, 'Computing SI telemetry & polar validation');
  const telemetry = calculateAeroTelemetry(
    input.modelType,
    input.params.angle_of_attack,
    input.params.airspeed_kts,
    input.params.altitude_ft,
    input.params.flaps_deg
  );

  onProgress?.(0.65, `Serializing ${input.format.toUpperCase()} artifact`);
  const enc = new TextEncoder();

  if (input.format === 'pdf') {
    const { blob, fileName } = generateEngineeringPdfBlob(input.modelType, input.params, telemetry);
    // Notice jsPDF blob is synchronous; convert synchronously via fallback or return arrayBuffer
    void blob;
    // Actually let's build directly with jsPDF arraybuffer via bundle? Wait: generateEngineeringPdfBlob created Blob from doc.output('arraybuffer')
    // Since Blob.arrayBuffer() is async, let's keep export task synchronous-friendly by creating Uint8Array from JSON/MD or async wrapper!
    // Wait: let's return textContent or async Promise in runWorkerTask!
    return {
      result: {
        fileName,
        mimeType: 'application/pdf',
        buffer: new ArrayBuffer(0),
      },
    };
  }

  const bundle = buildEngineeringReportBundle(input.modelType, input.params, telemetry);
  if (input.format === 'markdown') {
    const md = formatEngineeringReportMarkdown(bundle);
    const bytes = enc.encode(md);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      result: {
        fileName: `aeromatrix_report_${input.modelType}_aoa${input.params.angle_of_attack.toFixed(1)}deg.md`,
        mimeType: 'text/markdown;charset=utf-8',
        buffer,
        textContent: md,
      },
      transferables: [buffer],
    };
  }

  const json = JSON.stringify(bundle, null, 2);
  const bytes = enc.encode(json);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    result: {
      fileName: `aeromatrix_report_${input.modelType}_aoa${input.params.angle_of_attack.toFixed(1)}deg.json`,
      mimeType: 'application/json;charset=utf-8',
      buffer,
      textContent: json,
    },
    transferables: [buffer],
  };
}

export async function runExportReportTaskAsync(
  input: ExportReportInput,
  onProgress?: (progress: number, stage?: string) => void
): Promise<WorkerHandlerResult<ExportReportOutput>> {
  if (input.format !== 'pdf') {
    return runExportReportTask(input, onProgress);
  }
  onProgress?.(0.3, 'Computing SI telemetry & polar verification');
  const telemetry = calculateAeroTelemetry(
    input.modelType,
    input.params.angle_of_attack,
    input.params.airspeed_kts,
    input.params.altitude_ft,
    input.params.flaps_deg
  );
  onProgress?.(0.7, 'Rendering A4 verification PDF');
  await ensurePdfFontsLoaded();
  const { blob, fileName } = generateEngineeringPdfBlob(input.modelType, input.params, telemetry);
  const buffer = await blob.arrayBuffer();
  onProgress?.(1.0, 'Complete');
  return {
    result: {
      fileName,
      mimeType: 'application/pdf',
      buffer,
    },
    transferables: [buffer],
  };
}

export async function dispatchWorkerRequest(
  req: SimulationRequest,
  onProgress?: (progress: number, stage?: string) => void
): Promise<WorkerHandlerResult<unknown>> {
  switch (req.type) {
    case 'RUN_PHYSICS':
      return runPhysicsTask(req.input, onProgress);
    case 'BUILD_SDF':
      return runFluid3DTask(req.input, true, onProgress);
    case 'TRACE_STREAMLINES':
      return runFluid3DTask(req.input, false, onProgress);
    case 'ANALYZE_GEOMETRY':
      return runGeometryTask(req.input, onProgress);
    case 'RUN_LBM_DIAGNOSTICS':
      return runLbmDiagnosticsTask(req.input, onProgress);
    case 'BUILD_REPORT':
      return runExportReportTaskAsync(req.input, onProgress);
  }
}
