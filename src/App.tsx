import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import {
  Wind,
  SlidersHorizontal,
  Pulse,
  ArrowCounterClockwise,
  BookOpenText,
  SpeakerHigh,
  SpeakerSlash,
  Keyboard,
  Cube,
  SidebarSimple,
} from '@phosphor-icons/react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Download,
  Gauge,
  Layers,
  Pause,
  Play,
  Radar,
  RotateCcw,
  Spline,
  TrendingUp,
  User,
  UserCheck,
} from 'lucide-react';

// 3D CFD Workstation Modules
import { SimulationParams } from './types/aerodynamics';
import {
  AIRCRAFT_MODELS,
  calculateAeroTelemetry,
  setCustom3DAirfoilConfig,
  setCustom3DGlbConfig,
} from './utils/airfoilGenerators';
import {
  AeroCalibration,
  BoundingBoxDims,
  computeOrientationMatrixArray,
} from './lib/calibration';
import { ControlsDeck } from './components/ControlsDeck';
import {
  buildCustomGlbAssetFromDoc,
  CustomGlbAsset,
  MeshPcaAnalysis,
} from './components/GlbUploader';
import { WindTunnelCanvas3D } from './components/WindTunnelCanvas3D';
import { WindTunnelCanvasWebGL } from './components/WindTunnelCanvasWebGL';
import { TelemetryHUD } from './components/TelemetryHUD';
import { AeroCharts } from './components/AeroCharts';
import { AeroTheoryModal } from './components/AeroTheoryModal';
import { ModelViewerModal } from './components/ModelViewerModal';
import { probeWebGL2Support } from './utils/webglSupport';
import { syncRuntimeSeoMetadata } from './utils/seo';

// 2D LBM Airfoil Lab Modules
import AirfoilPicker from './components/AirfoilPicker.tsx';
import BenchmarkComparison from './components/BenchmarkComparison.tsx';
import { useSupabase, type AppUser } from './components/SupabaseProvider.tsx';
import ResultsAnalytics from './components/ResultsAnalytics.tsx';
import ShapeEditor2D from './components/ShapeEditor2D.tsx';
import { Alert, ParserBox, SliderField } from './components/ui.tsx';
import ProfilePage from './pages/ProfilePage.tsx';
import { LBM, createWindTunnel2D, lbmNaca4, lbmSimRe } from './lib/lbm/tunnel2d.js';
import { EXAMPLE_AIRFOILS, downloadText, loadExample } from './lib/files.js';
import { parseDatText } from './lib/airfoilParser.js';
import { interpolateNeuroPolar, runNeuroFoilPrediction } from './lib/neurofoil.ts';
import type {
  BenchmarkRunDoc,
  NeutralReferenceData,
  SharedAirfoilDoc,
  SharedGlbModelDoc,
  UserProfileDoc,
} from './lib/airfoilRepository.ts';
import type {
  AirfoilSelection,
  Coord2D,
  TelemetrySample,
  TunnelController,
  TunnelStats,
} from './types/airfoil.ts';

type LabMode = '3d' | '2d';
type PaneTab = 'controls' | 'tunnel' | 'results';

const INITIAL_3D_PARAMS: SimulationParams = {
  modelType: 'f22',
  angle_of_attack: 6.0,
  airspeed_kts: 380,
  altitude_ft: 5000,
  flaps_deg: 0,
  viscosity: 0.35,
  smoke_density: 0.8,
  show_streamlines: true,
  show_particles: true,
  show_heatmap: false,
  show_pressure_vectors: true,
  show_quiver: false,
  show_shockwaves: true,
  audio_enabled: false,
  renderEngine: 'webgl',
  renderShading: 'pbr',
  customAirfoilVersion: 0,
  customGlbVersion: 0,
  customGlbFlipNose: false,
};

const FIELD_MODES: Array<[string, string]> = [
  ['0', 'Velocity'],
  ['1', 'Pressure (Cp)'],
  ['2', 'Vorticity'],
  ['3', 'Smoke'],
];

const FIELD_GUIDE: Array<[string, string, string]> = [
  ['0', 'Velocity', 'Flow speed relative to freestream. Reveals suction peak & wake deficit.'],
  ['1', 'Pressure (Cp)', 'Surface pressure distribution. Cool = suction, warm = stagnation.'],
  ['2', 'Vorticity', 'Shear-layer rotation & trailing-edge vortex shedding.'],
  ['3', 'Smoke', 'Upstream tracer dye streamlines showing separation & eddies.'],
];

const DEFAULT_ALPHA_2D = 6;
const DEFAULT_U0_MM = 60;

interface WorkstationProps {
  labMode: LabMode;
  setLabMode: Dispatch<SetStateAction<LabMode>>;
  // 2D Airfoil shared state
  choice: string;
  setChoice: Dispatch<SetStateAction<string>>;
  airfoil: AirfoilSelection;
  activeCoords: Coord2D[];
  setActiveCoords: Dispatch<SetStateAction<Coord2D[]>>;
  onSelectAirfoil: (next: AirfoilSelection) => void;
  user: AppUser | null;
  userProfile: UserProfileDoc | null;
  benchmarks: BenchmarkRunDoc[];
  sharedAirfoils: SharedAirfoilDoc[];
  cloudError: string | null;
  customRef: NeutralReferenceData | null;
  setCustomRef: Dispatch<SetStateAction<NeutralReferenceData | null>>;
  alpha2D: number;
  setAlpha2D: Dispatch<SetStateAction<number>>;
  fieldMode2D: string;
  setFieldMode2D: Dispatch<SetStateAction<string>>;
  u0Scaled: number;
  setU0Scaled: Dispatch<SetStateAction<number>>;
  samples: TelemetrySample[];
  setSamples: Dispatch<SetStateAction<TelemetrySample[]>>;
  sampleIdRef: MutableRefObject<number>;
  appendSample: (next: TunnelStats) => void;
  tunnelRef: MutableRefObject<TunnelController | null>;
  pendingSavedGlb: CustomGlbAsset | null;
  onConsumePendingSavedGlb: () => void;
}

function UnifiedWorkstation({
  labMode,
  setLabMode,
  choice,
  setChoice,
  airfoil,
  activeCoords,
  setActiveCoords,
  onSelectAirfoil,
  user,
  userProfile,
  benchmarks,
  sharedAirfoils,
  cloudError,
  customRef,
  setCustomRef,
  alpha2D,
  setAlpha2D,
  fieldMode2D,
  setFieldMode2D,
  u0Scaled,
  setU0Scaled,
  samples,
  setSamples,
  sampleIdRef,
  appendSample,
  tunnelRef,
  pendingSavedGlb,
  onConsumePendingSavedGlb,
}: WorkstationProps) {
  // Shared layout state
  const [mobileTab, setMobileTab] = useState<PaneTab>('tunnel');
  const [showLeftSidebar, setShowLeftSidebar] = useState<boolean>(true);
  const [showRightSidebar, setShowRightSidebar] = useState<boolean>(true);
  const [isTheoryOpen, setIsTheoryOpen] = useState<boolean>(false);
  const [isModelViewerOpen, setIsModelViewerOpen] = useState<boolean>(false);

  // 3D CFD state
  const webglSupported = useMemo(() => probeWebGL2Support().supported, []);
  const [params3D, setParams3D] = useState<SimulationParams>(() => ({
    ...INITIAL_3D_PARAMS,
    renderEngine: probeWebGL2Support().supported ? 'webgl' : 'canvas',
  }));
  const [isPaused3D, setIsPaused3D] = useState<boolean>(false);
  const [customGlbAsset, setCustomGlbAsset] = useState<CustomGlbAsset | null>(null);

  // 2D LBM Airfoil state
  const canvas2DRef = useRef<HTMLCanvasElement>(null);
  const [isPaused2D, setIsPaused2D] = useState<boolean>(false);
  const [stepsPerFrame, setStepsPerFrame] = useState<number>(10);
  const [glError2D, setGlError2D] = useState<string | null>(null);
  const [controlsTab2D, setControlsTab2D] = useState<'flow' | 'airfoils' | 'shape'>('flow');
  const [resultsTab2D, setResultsTab2D] = useState<'analytics' | 'neurofoil'>('analytics');
  const [stats2D, setStats2D] = useState<TunnelStats>({
    cl: null,
    cd: null,
    reynolds: Math.round(lbmSimRe(u0Scaled / 1000) / 10) * 10,
    separationPct: 0,
  });

  // Keep latest active 2D state synced for 3D bridge
  const simRe2D = Math.round(lbmSimRe(u0Scaled / 1000) / 10) * 10;
  const neurofoilPrediction = useMemo(
    () => runNeuroFoilPrediction(airfoil.name, activeCoords, stats2D.reynolds),
    [airfoil.name, activeCoords, stats2D.reynolds]
  );

  // Sync runtime SEO metadata
  useEffect(() => {
    syncRuntimeSeoMetadata();
  }, []);

  // Mount/unmount 2D WebGL2 D2Q9 tunnel strictly when in 2D mode so 3D and 2D never compete for GPU contexts
  useEffect(() => {
    if (labMode !== '2d') {
      if (tunnelRef.current) {
        tunnelRef.current.destroy();
        tunnelRef.current = null;
      }
      return;
    }

    const cv = canvas2DRef.current;
    if (!cv) return undefined;

    setGlError2D(null);
    const ctrl = createWindTunnel2D(cv, {
      coords: activeCoords,
      name: airfoil.name,
      alphaDeg: alpha2D,
      u0: u0Scaled / 1000,
      fieldMode: Number(fieldMode2D),
      onStats: (next: TunnelStats) => {
        setStats2D(next);
        appendSample(next);
      },
      onSteps: (s: number) => setStepsPerFrame(s),
      onError: (msg: string) => setGlError2D(msg),
    }) as TunnelController;
    ctrl.setPaused(isPaused2D);
    tunnelRef.current = ctrl;

    return () => {
      ctrl.destroy();
      tunnelRef.current = null;
    };
    // Intentionally mount once per entry into '2d' mode; live parameter updates use controller methods
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labMode, appendSample, tunnelRef]);

  // 3D parameter handlers
  const handleParam3DChange = useCallback(
    <K extends keyof SimulationParams>(key: K, value: SimulationParams[K]) => {
      setParams3D((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const handleReset3D = useCallback(() => {
    setParams3D((prev) => ({
      ...INITIAL_3D_PARAMS,
      renderEngine: webglSupported ? 'webgl' : 'canvas',
      customGlbVersion: prev.customGlbVersion,
      customGlbFlipNose: false,
    }));
    setIsPaused3D(false);
  }, [webglSupported]);

  const computeOrientedBounds = useCallback(
    (bounds: BoundingBoxDims, cal: AeroCalibration): BoundingBoxDims => {
      const m = computeOrientationMatrixArray(cal.noseAxis, cal.upAxis, false);
      const sx = Math.abs(m[0]) * bounds.x + Math.abs(m[4]) * bounds.y + Math.abs(m[8]) * bounds.z;
      const sy = Math.abs(m[1]) * bounds.x + Math.abs(m[5]) * bounds.y + Math.abs(m[9]) * bounds.z;
      const sz = Math.abs(m[2]) * bounds.x + Math.abs(m[6]) * bounds.y + Math.abs(m[10]) * bounds.z;
      return { x: sx || 1, y: sy || 0.3, z: sz || 0.6 };
    },
    []
  );

  const handleCustomGlbReady = useCallback(
    (asset: CustomGlbAsset) => {
      const cal = asset.calibration;
      const orientedBounds = computeOrientedBounds(asset.bounds, cal);
      setCustom3DGlbConfig(asset.fileName, cal, orientedBounds);
      setCustomGlbAsset(asset);

      const suggestedKts = Math.max(20, Math.min(1200, Math.round(cal.cruiseSpeedMs * 1.94384)));
      const suggestedAoa = Math.max(
        cal.aoaMinDeg,
        Math.min(cal.aoaMaxDeg, cal.stallAngleDeg > 0 ? Math.min(4, cal.aoaMaxDeg) : 0)
      );
      const suggestedVisc = Math.max(0.01, Math.min(0.4, Number((cal.viscosity * 0.4).toFixed(2))));

      setParams3D((prev) => ({
        ...prev,
        modelType: 'custom_glb',
        angle_of_attack: suggestedAoa,
        airspeed_kts: suggestedKts,
        flaps_deg: 0,
        viscosity: suggestedVisc,
        customGlbFlipNose: false,
        customGlbVersion: (prev.customGlbVersion || 0) + 1,
      }));
    },
    [computeOrientedBounds]
  );

  useEffect(() => {
    if (!pendingSavedGlb) return;
    handleCustomGlbReady(pendingSavedGlb);
    setLabMode('3d');
    setMobileTab('tunnel');
    onConsumePendingSavedGlb();
  }, [pendingSavedGlb, handleCustomGlbReady, setLabMode, onConsumePendingSavedGlb]);

  const handleCustomGlbCloudLinked = useCallback(
    (fileName: string, doc: SharedGlbModelDoc) => {
      setCustomGlbAsset((prev) =>
        prev && prev.fileName === fileName
          ? {
              ...prev,
              cloudId: doc.id,
              storagePath: doc.storagePath,
              storageUrl: doc.storageUrl,
              uploaderUid: doc.uploaderUid,
            }
          : prev
      );
    },
    []
  );

  const handleCustomGlbCalibrationUpdated = useCallback(
    (cal: AeroCalibration, fallbackUsed: boolean, reason?: string, pca?: MeshPcaAnalysis) => {
      setCustomGlbAsset((prev) => {
        if (!prev) return prev;
        const orientedBounds = computeOrientedBounds(prev.bounds, cal);
        setCustom3DGlbConfig(prev.fileName, cal, orientedBounds);
        return {
          ...prev,
          calibration: cal,
          pca: pca ?? prev.pca,
          fallbackUsed,
          fallbackReason: reason,
        };
      });

      const suggestedKts = Math.max(20, Math.min(1200, Math.round(cal.cruiseSpeedMs * 1.94384)));
      const suggestedVisc = Math.max(0.01, Math.min(0.4, Number((cal.viscosity * 0.4).toFixed(2))));

      setParams3D((prev) => ({
        ...prev,
        modelType: 'custom_glb',
        angle_of_attack: Math.max(cal.aoaMinDeg, Math.min(cal.aoaMaxDeg, prev.angle_of_attack)),
        airspeed_kts: suggestedKts,
        viscosity: suggestedVisc,
        customGlbFlipNose: false,
        customGlbVersion: (prev.customGlbVersion || 0) + 1,
      }));
    },
    [computeOrientedBounds]
  );

  const handleFlipCustomGlbNose = useCallback(() => {
    setParams3D((prev) => ({
      ...prev,
      customGlbFlipNose: !prev.customGlbFlipNose,
    }));
  }, []);

  const handleResetCustomGlbToDefault = useCallback(() => {
    setCustomGlbAsset(null);
    setParams3D((prev) => ({
      ...INITIAL_3D_PARAMS,
      renderEngine: prev.renderEngine ?? (webglSupported ? 'webgl' : 'canvas'),
      customGlbFlipNose: false,
      customGlbVersion: (prev.customGlbVersion || 0) + 1,
    }));
  }, [webglSupported]);

  // 2D parameter handlers
  const handleAlpha2DChange = useCallback(
    (val: number) => {
      setAlpha2D(val);
      tunnelRef.current?.setAlpha(val);
    },
    [setAlpha2D, tunnelRef]
  );

  const handleField2DChange = useCallback(
    (val: string) => {
      setFieldMode2D(val);
      tunnelRef.current?.setField(Number(val));
    },
    [setFieldMode2D, tunnelRef]
  );

  const handleReynolds2DChange = useCallback(
    (val: number) => {
      setU0Scaled(val);
      tunnelRef.current?.setU0(val / 1000);
    },
    [setU0Scaled, tunnelRef]
  );

  const handleTogglePause2D = useCallback(() => {
    setIsPaused2D((prev) => {
      const next = !prev;
      tunnelRef.current?.setPaused(next);
      return next;
    });
  }, [tunnelRef]);

  const handleReset2D = useCallback(() => {
    setAlpha2D(DEFAULT_ALPHA_2D);
    setFieldMode2D('0');
    setU0Scaled(DEFAULT_U0_MM);
    setIsPaused2D(false);
    setActiveCoords(airfoil.coords);
    const t = tunnelRef.current;
    if (t) {
      t.setPaused(false);
      t.setField(0);
      t.setU0(DEFAULT_U0_MM / 1000);
      t.setCoords(airfoil.coords, airfoil.name);
      t.setAlpha(DEFAULT_ALPHA_2D);
      t.resetFlow();
    }
  }, [airfoil, setActiveCoords, setAlpha2D, setFieldMode2D, setU0Scaled, tunnelRef]);

  const handleDownloadDat = useCallback(() => {
    const base = (airfoil.name || 'airfoil').replace(/\.(dat|txt)$/i, '');
    const text =
      `${base}\n` +
      activeCoords.map(([x, y]) => `${x.toFixed(6).padStart(10)} ${y.toFixed(6).padStart(10)}`).join('\n') +
      '\n';
    downloadText(`${base.replace(/[^\w.-]+/g, '_')}.dat`, text);
  }, [airfoil.name, activeCoords]);

  // Cross-Lab Bridge: Send active 2D airfoil (including Bézier edits or .dat uploads) into 3D Wind Tunnel
  const handleSend2DFoilTo3D = useCallback(() => {
    const atZero = interpolateNeuroPolar(neurofoilPrediction.polar, 0);
    setCustom3DAirfoilConfig({
      name: airfoil.name,
      coords: activeCoords.map(([x, y]) => [x, y]),
      cl0: Number(atZero.cl.toFixed(3)),
      alphaZeroLift: Number(neurofoilPrediction.zeroLiftAlpha.toFixed(2)),
      clMax: Number(Math.max(0.8, neurofoilPrediction.maxCl).toFixed(2)),
      cd0: Number(Math.max(0.005, atZero.cd).toFixed(4)),
      stallAngle: Number(Math.max(8, neurofoilPrediction.stallAlpha).toFixed(1)),
    });
    setParams3D((prev) => ({
      ...prev,
      modelType: 'custom_airfoil',
      angle_of_attack: Math.max(-15, Math.min(30, alpha2D)),
      customAirfoilVersion: (prev.customAirfoilVersion || 0) + 1,
    }));
    setLabMode('3d');
    setMobileTab('tunnel');
  }, [activeCoords, airfoil.name, alpha2D, neurofoilPrediction, setLabMode]);

  // Cross-Lab Bridge: Jump from 3D Airfoil controls into 2D LBM Sculptor
  const handleOpen2DFrom3D = useCallback(() => {
    setAlpha2D(Math.max(-20, Math.min(25, params3D.angle_of_attack)));
    setLabMode('2d');
    setControlsTab2D('shape');
    setMobileTab('tunnel');
  }, [params3D.angle_of_attack, setAlpha2D, setLabMode]);

  // Unified Keyboard Shortcuts scoped to active lab mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      if (labMode === '3d') {
        const cal = params3D.modelType === 'custom_glb' && customGlbAsset ? customGlbAsset.calibration : null;
        const aoaMinLimit = cal ? cal.aoaMinDeg : -15;
        const aoaMaxLimit = cal ? cal.aoaMaxDeg : 30;
        const cruiseKts = cal ? Math.round(cal.cruiseSpeedMs * 1.94384) : null;
        const speedMinLimit = cruiseKts ? Math.max(20, Math.round((cruiseKts * 0.35) / 10) * 10) : 20;
        const speedMaxLimit = cruiseKts
          ? Math.min(1200, Math.max(speedMinLimit + 80, Math.round((cruiseKts * 1.8) / 10) * 10))
          : 1200;

        if (e.code === 'Space') {
          e.preventDefault();
          setIsPaused3D((prev) => !prev);
        } else if (e.code === 'ArrowUp') {
          e.preventDefault();
          setParams3D((p) => ({
            ...p,
            angle_of_attack: Math.min(aoaMaxLimit, +(p.angle_of_attack + 0.5).toFixed(1)),
          }));
        } else if (e.code === 'ArrowDown') {
          e.preventDefault();
          setParams3D((p) => ({
            ...p,
            angle_of_attack: Math.max(aoaMinLimit, +(p.angle_of_attack - 0.5).toFixed(1)),
          }));
        } else if (e.code === 'ArrowRight') {
          e.preventDefault();
          setParams3D((p) => ({ ...p, airspeed_kts: Math.min(speedMaxLimit, p.airspeed_kts + 15) }));
        } else if (e.code === 'ArrowLeft') {
          e.preventDefault();
          setParams3D((p) => ({ ...p, airspeed_kts: Math.max(speedMinLimit, p.airspeed_kts - 15) }));
        } else if (e.key === 'r' || e.key === 'R') {
          handleReset3D();
        } else if (e.key === 'm' || e.key === 'M') {
          setParams3D((p) => ({ ...p, audio_enabled: !p.audio_enabled }));
        }
      } else {
        if (e.code === 'Space') {
          e.preventDefault();
          handleTogglePause2D();
        } else if (e.code === 'ArrowUp') {
          e.preventDefault();
          setAlpha2D((prev) => {
            const next = Math.min(25, +(prev + 0.5).toFixed(1));
            tunnelRef.current?.setAlpha(next);
            return next;
          });
        } else if (e.code === 'ArrowDown') {
          e.preventDefault();
          setAlpha2D((prev) => {
            const next = Math.max(-20, +(prev - 0.5).toFixed(1));
            tunnelRef.current?.setAlpha(next);
            return next;
          });
        } else if (e.code === 'ArrowRight') {
          e.preventDefault();
          setU0Scaled((prev) => {
            const next = Math.min(100, prev + 2);
            tunnelRef.current?.setU0(next / 1000);
            return next;
          });
        } else if (e.code === 'ArrowLeft') {
          e.preventDefault();
          setU0Scaled((prev) => {
            const next = Math.max(30, prev - 2);
            tunnelRef.current?.setU0(next / 1000);
            return next;
          });
        } else if (e.key === 'r' || e.key === 'R') {
          handleReset2D();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    labMode,
    params3D.modelType,
    customGlbAsset,
    handleReset3D,
    handleReset2D,
    handleTogglePause2D,
    setAlpha2D,
    setU0Scaled,
    tunnelRef,
  ]);

  // 3D Live Telemetry
  const telemetry3D = useMemo(() => {
    return calculateAeroTelemetry(
      params3D.modelType,
      params3D.angle_of_attack,
      params3D.airspeed_kts,
      params3D.altitude_ft,
      params3D.flaps_deg
    );
  }, [
    params3D.modelType,
    params3D.angle_of_attack,
    params3D.airspeed_kts,
    params3D.altitude_ft,
    params3D.flaps_deg,
    params3D.customAirfoilVersion,
    params3D.customGlbVersion,
  ]);

  const currentModel3D = AIRCRAFT_MODELS[params3D.modelType];

  // 2D Derived State
  const sepPct2D = stats2D.separationPct;
  const isStalled2D = sepPct2D >= 25;
  const flowState2D =
    sepPct2D < 5
      ? { label: 'Attached', color: '#047857', Icon: CheckCircle2 }
      : sepPct2D < 25
        ? { label: `${sepPct2D}% Sep`, color: '#B45309', Icon: AlertTriangle }
        : { label: `Stall (${sepPct2D}%)`, color: '#DC2626', Icon: AlertTriangle };

  const liftToDrag2D =
    stats2D.cl !== null && stats2D.cd !== null && stats2D.cd > 0.001
      ? (stats2D.cl / stats2D.cd).toFixed(2)
      : '—';

  const activeFieldLabel2D =
    FIELD_MODES.find(([value]) => value === fieldMode2D)?.[1] || 'Velocity';

  const profileLabel =
    userProfile?.displayName ||
    user?.displayName?.split(/\s+/)[0] ||
    (user ? 'Profile' : 'Sign in');

  return (
    <div className="h-screen h-[100dvh] w-full overflow-hidden bg-[var(--bg)] text-[var(--text)] flex flex-col font-sans select-none selection:bg-[var(--accent-light)] selection:text-[var(--accent)]">
      <h1 className="sr-only">
        AeroLab - Unified 3D Aircraft CFD &amp; 2D Airfoil Wind Tunnel Workstation
      </h1>

      {/* 1. UNIFIED 3-ZONE TOP HEADER */}
      <header className="h-12 sm:h-14 px-2.5 sm:px-4 pl-[max(0.625rem,env(safe-area-inset-left))] pr-[max(0.625rem,env(safe-area-inset-right))] border-b border-[var(--border)] bg-[var(--nav-bg)] backdrop-blur-md flex items-center justify-between gap-2 z-30 flex-shrink-0">
        {/* Zone 1: Brand Lockup & Compact Status Readout (xl+) */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <div className="flex items-center gap-2">
            <img
              src="/aerolab-logo.png"
              alt="AeroLab"
              className="h-6 sm:h-7 w-auto object-contain shrink-0"
            />
            <span className="hidden md:inline font-script text-xl leading-none text-[#1769AA] pt-0.5 whitespace-nowrap">
              Wind Tunnel
            </span>
          </div>

          <div className="hidden xl:flex items-center gap-2 pl-2.5 border-l border-[var(--border)] text-xs font-mono tabular-nums text-[#5C6670] whitespace-nowrap">
            {labMode === '3d' ? (
              <>
                <span className="font-sans font-semibold text-[#161A1D] max-w-44 truncate">
                  {currentModel3D.name.split(' (')[0]}
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-[#1769AA] font-semibold">
                  M {telemetry3D.mach.toFixed(2)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-[#1769AA] font-semibold">
                  α {params3D.angle_of_attack >= 0 ? '+' : ''}
                  {params3D.angle_of_attack.toFixed(1)}°
                </span>
                <span aria-hidden="true">·</span>
                <span className={telemetry3D.isStalled ? 'text-red-600 font-bold' : 'text-[#5C6670]'}>
                  {telemetry3D.flowState}
                </span>
              </>
            ) : (
              <>
                <span className="font-sans font-semibold text-[#161A1D] max-w-40 truncate">
                  {airfoil.name}
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-[#1769AA] font-semibold">
                  α {alpha2D >= 0 ? '+' : ''}
                  {alpha2D.toFixed(1)}°
                </span>
                <span aria-hidden="true">·</span>
                <span>Re {simRe2D.toLocaleString()}</span>
                <span aria-hidden="true">·</span>
                <span style={{ color: flowState2D.color }} className="font-semibold">
                  {flowState2D.label}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Zone 2: Lab Mode Switcher + Mobile Pane Tabs */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Primary Lab Switcher: 3D Aircraft CFD vs 2D Airfoil Lab */}
          <div
            role="tablist"
            aria-label="Simulation Engine Mode"
            className="flex items-center p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[11px] sm:text-xs shrink-0"
          >
            <button
              type="button"
              role="tab"
              aria-selected={labMode === '3d'}
              onClick={() => setLabMode('3d')}
              className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-md font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                labMode === '3d'
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
            >
              <Box className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden min-[440px]:inline">3D CFD</span>
              <span className="min-[440px]:hidden">3D</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={labMode === '2d'}
              onClick={() => setLabMode('2d')}
              className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-md font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                labMode === '2d'
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
            >
              <Spline className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden min-[440px]:inline">2D Airfoil</span>
              <span className="min-[440px]:hidden">2D</span>
            </button>
          </div>

          {/* Mobile & Tablet Pane Switcher (< lg) */}
          <nav
            aria-label="Mobile workspace panes"
            className="flex lg:hidden items-center p-0.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[11px] shrink-0"
          >
            <button
              type="button"
              onClick={() => setMobileTab('controls')}
              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mobileTab === 'controls'
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
              aria-label="Controls"
            >
              <SlidersHorizontal weight="duotone" className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">Setup</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('tunnel')}
              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mobileTab === 'tunnel'
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
              aria-label="Wind Tunnel"
            >
              <Wind weight="duotone" className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">Tunnel</span>
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('results')}
              className={`px-2 py-1 rounded-md font-semibold flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mobileTab === 'results'
                  ? 'bg-[#1769AA] text-white'
                  : 'text-[#5C6670] hover:text-[#161A1D]'
              }`}
              aria-label="Results"
            >
              <Pulse weight="duotone" className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">Data</span>
            </button>
          </nav>
        </div>

        {/* Zone 3: Workstation Toggles, Modals & Pilot Profile */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {/* Desktop Left/Right Sidebar Toggles */}
          <button
            type="button"
            onClick={() => setShowLeftSidebar((p) => !p)}
            className={`hidden lg:flex px-2 py-1.5 rounded-lg border transition-colors text-xs font-semibold items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              showLeftSidebar
                ? 'bg-[var(--accent-light)] border-[#1769AA]/30 text-[#1769AA]'
                : 'bg-[var(--surface)] border-[var(--border)] text-[#5C6670] hover:text-[#161A1D]'
            }`}
            title={showLeftSidebar ? 'Collapse Left Controls Deck' : 'Expand Left Controls Deck'}
          >
            <SidebarSimple weight={showLeftSidebar ? 'duotone' : 'regular'} className="w-4 h-4" />
            <span className="hidden 2xl:inline text-[11px]">Controls</span>
          </button>

          <button
            type="button"
            onClick={() => setShowRightSidebar((p) => !p)}
            className={`hidden lg:flex px-2 py-1.5 rounded-lg border transition-colors text-xs font-semibold items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              showRightSidebar
                ? 'bg-[var(--accent-light)] border-[#1769AA]/30 text-[#1769AA]'
                : 'bg-[var(--surface)] border-[var(--border)] text-[#5C6670] hover:text-[#161A1D]'
            }`}
            title={showRightSidebar ? 'Collapse Right Results Deck' : 'Expand Right Results Deck'}
          >
            <span className="hidden 2xl:inline text-[11px]">Results</span>
            <SidebarSimple weight={showRightSidebar ? 'duotone' : 'regular'} className="w-4 h-4 scale-x-[-1]" />
          </button>

          <div className="hidden lg:block w-px h-5 bg-[var(--border)] mx-0.5" />

          {labMode === '3d' && (
            <>
              <button
                type="button"
                onClick={() => setIsModelViewerOpen(true)}
                className="p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[#1769AA] text-xs font-semibold text-[#161A1D] hover:text-[#1769AA] transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                title="Inspect 3D GLB CAD Model"
              >
                <Cube weight="duotone" className="w-4 h-4 text-[#1769AA]" />
                <span className="hidden md:inline">CAD</span>
              </button>

              <button
                type="button"
                onClick={() => handleParam3DChange('audio_enabled', !params3D.audio_enabled)}
                className={`hidden sm:flex p-1.5 rounded-lg border transition-colors cursor-pointer ${
                  params3D.audio_enabled
                    ? 'bg-[var(--accent-light)] text-[#1769AA] border-[#1769AA]/40'
                    : 'bg-[var(--surface)] text-[#5C6670] border-[var(--border)] hover:text-[#161A1D]'
                }`}
                title={params3D.audio_enabled ? 'Mute Wind Audio (M)' : 'Enable Wind Audio (M)'}
              >
                {params3D.audio_enabled ? (
                  <SpeakerHigh weight="duotone" className="w-4 h-4" />
                ) : (
                  <SpeakerSlash weight="duotone" className="w-4 h-4" />
                )}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setIsTheoryOpen(true)}
            className="hidden sm:flex p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] hover:border-[#1769AA] text-xs font-semibold text-[#161A1D] hover:text-[#1769AA] transition-colors items-center gap-1.5 whitespace-nowrap cursor-pointer"
            title="Aerodynamics Theory Guide"
          >
            <BookOpenText weight="duotone" className="w-4 h-4 text-[#1769AA]" />
            <span className="hidden lg:inline">Theory</span>
          </button>

          <button
            type="button"
            onClick={labMode === '3d' ? handleReset3D : handleReset2D}
            className="hidden sm:flex p-1.5 rounded-lg text-[#5C6670] hover:text-[#161A1D] bg-[var(--surface)] hover:bg-[var(--bg)] transition-colors border border-[var(--border)] cursor-pointer"
            title="Reset Active Simulation (R)"
          >
            <ArrowCounterClockwise weight="bold" className="w-4 h-4" />
          </button>

          <Link
            to="/profile"
            aria-label="Open pilot profile page"
            className="px-2 sm:px-2.5 py-1.5 rounded-lg text-[11px] sm:text-xs font-semibold bg-[var(--surface)] border border-[var(--border)] text-[#161A1D] hover:border-[#1769AA] hover:text-[#1769AA] transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {user?.photoURL ? (
              <img
                src={user.photoURL}
                alt={profileLabel}
                className="w-4 h-4 rounded-full object-cover shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : user ? (
              <UserCheck size={13} className="text-[#1769AA] shrink-0" aria-hidden="true" />
            ) : (
              <User size={13} className="text-[#1769AA] shrink-0" aria-hidden="true" />
            )}
            <span className="hidden md:inline max-w-24 truncate">{profileLabel}</span>
          </Link>
        </div>
      </header>

      {/* 2. UNIFIED 3-COLUMN WORKSTATION (Controls Left · Tunnel Center · Telemetry/Results Right) */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0 min-w-0 relative pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        {/* LEFT COLUMN: CONTROLS & SETUP */}
        <section
          id="controls"
          aria-label="Simulation Controls"
          className={`
            ${showLeftSidebar ? 'lg:flex lg:w-80 xl:w-[22.5rem] 2xl:w-96' : 'lg:hidden'}
            ${mobileTab === 'controls' ? 'flex flex-1 w-full' : 'hidden'}
            min-w-0 flex-shrink-0 h-full overflow-y-auto overscroll-contain custom-scrollbar lg:border-r border-[var(--border)] bg-[var(--bg)] p-3 sm:p-3.5 pb-8 flex-col gap-3.5 z-20
          `}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal weight="duotone" className="w-4 h-4 text-[#1769AA]" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#161A1D]">
                {labMode === '3d' ? 'Simulation Controls' : 'Airfoil & Flow Controls'}
              </h2>
            </div>
            <span className="text-[11px] font-mono text-[#5C6670]">
              {labMode === '3d' ? '3D Parameters' : activeFieldLabel2D}
            </span>
          </div>

          {labMode === '3d' ? (
            <ControlsDeck
              params={params3D}
              onParamChange={handleParam3DChange}
              isPaused={isPaused3D}
              onTogglePause={() => setIsPaused3D((prev) => !prev)}
              onReset={handleReset3D}
              onOpenTheory={() => setIsTheoryOpen(true)}
              onOpenModelInspector={() => setIsModelViewerOpen(true)}
              onOpen2DLab={handleOpen2DFrom3D}
              customGlbAsset={customGlbAsset}
              onCustomGlbReady={handleCustomGlbReady}
              onCustomGlbCloudLinked={handleCustomGlbCloudLinked}
              onCustomGlbCalibrationUpdated={handleCustomGlbCalibrationUpdated}
              onFlipCustomGlbNose={handleFlipCustomGlbNose}
              onResetCustomGlbToDefault={handleResetCustomGlbToDefault}
            />
          ) : (
            <form onSubmit={(e) => e.preventDefault()} className="flex flex-col gap-3">
              {/* Sub-tabs: Flow | Airfoils | Shape */}
              <div
                role="tablist"
                aria-label="2D Airfoil Control Sections"
                className="grid grid-cols-3 p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[11.5px] gap-0.5 shrink-0"
              >
                {(
                  [
                    { id: 'flow', label: 'Flow', Icon: SlidersHorizontal },
                    { id: 'airfoils', label: 'Airfoils', Icon: Layers },
                    { id: 'shape', label: 'Shape', Icon: Spline },
                  ] as const
                ).map(({ id, label, Icon }) => {
                  const active = controlsTab2D === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setControlsTab2D(id)}
                      className={`py-1.5 px-2 rounded-md font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-[#1769AA] text-white'
                          : 'text-[#5C6670] hover:text-[#161A1D]'
                      }`}
                    >
                      <Icon size={12} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>

              {controlsTab2D === 'flow' && (
                <div className="flex flex-col gap-3">
                  <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-3.5">
                    <div className="flex flex-col gap-2">
                      <SliderField
                        label="Angle of attack"
                        value={alpha2D}
                        min={-20}
                        max={25}
                        step={0.5}
                        onChange={handleAlpha2DChange}
                        format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`}
                      />
                      <div className="grid grid-cols-5 gap-1">
                        {[-5, 0, 6, 12].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={`py-1.5 rounded-md text-[11.5px] font-mono font-semibold border transition-colors cursor-pointer ${
                              Math.abs(alpha2D - preset) < 0.2
                                ? 'bg-[#1769AA] border-[#1769AA] text-white'
                                : 'bg-[var(--bg)] border-[var(--border)] text-[#161A1D] hover:border-[#1769AA]'
                            }`}
                            onClick={() => handleAlpha2DChange(preset)}
                          >
                            {preset}°
                          </button>
                        ))}
                        <button
                          type="button"
                          title={`Jump to NeuroFoil optimal angle (${neurofoilPrediction.optimalAlpha.toFixed(1)}°)`}
                          onClick={() => handleAlpha2DChange(neurofoilPrediction.optimalAlpha)}
                          className={`py-1.5 rounded-md text-[11px] font-mono font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                            Math.abs(alpha2D - neurofoilPrediction.optimalAlpha) < 0.3
                              ? 'bg-[#047857] border-[#047857] text-white'
                              : 'bg-emerald-50 border-emerald-200 text-[#047857] hover:bg-emerald-100'
                          }`}
                        >
                          α* {neurofoilPrediction.optimalAlpha.toFixed(0)}°
                        </button>
                      </div>
                    </div>

                    <div className="pt-2.5 border-t border-[var(--border)]">
                      <SliderField
                        label="Tunnel speed (Re)"
                        value={u0Scaled}
                        min={30}
                        max={100}
                        step={2}
                        onChange={handleReynolds2DChange}
                        format={(v) => `Re ${(Math.round(lbmSimRe(v / 1000) / 10) * 10).toLocaleString()}`}
                      />
                    </div>
                  </div>

                  <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2">
                    <div className="text-[11.5px] font-bold text-[#161A1D]">Field Visualization</div>
                    <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)] overflow-hidden bg-white">
                      {FIELD_GUIDE.map(([modeKey, title, desc]) => {
                        const active = fieldMode2D === modeKey;
                        return (
                          <button
                            key={title}
                            type="button"
                            onClick={() => handleField2DChange(modeKey)}
                            className={`w-full text-left px-3 py-2 transition-colors cursor-pointer ${
                              active ? 'bg-[var(--accent-light)]' : 'hover:bg-[var(--bg)]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className={`text-xs font-bold ${active ? 'text-[#1769AA]' : 'text-[#161A1D]'}`}>
                                {title}
                              </span>
                              {active && (
                                <span className="text-[10.5px] font-mono font-semibold text-[#1769AA]">
                                  Active
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] leading-snug text-[#5C6670] mt-0.5">{desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                        onClick={handleTogglePause2D}
                      >
                        {isPaused2D ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                        <span>{isPaused2D ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                        onClick={handleReset2D}
                      >
                        <RotateCcw size={13} aria-hidden="true" />
                        <span>Reset Flow</span>
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                        onClick={() => tunnelRef.current?.savePng()}
                      >
                        <Download size={13} aria-hidden="true" />
                        <span>Save PNG</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm whitespace-nowrap"
                        onClick={handleDownloadDat}
                      >
                        <Download size={13} aria-hidden="true" />
                        <span>Save .dat</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary-accent btn-sm w-full whitespace-nowrap"
                      onClick={handleSend2DFoilTo3D}
                    >
                      <Box size={13} aria-hidden="true" />
                      <span>Test Wing in 3D Wind Tunnel</span>
                    </button>
                  </div>
                </div>
              )}

              {controlsTab2D === 'airfoils' && (
                <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-2.5">
                  <AirfoilPicker
                    choice={choice}
                    onChoiceChange={setChoice}
                    uploadedFile={airfoil.isCustom ? airfoil.filename : null}
                    onSelectAirfoil={onSelectAirfoil}
                    sharedAirfoils={sharedAirfoils}
                    sharedError={cloudError}
                    activeAirfoil={airfoil}
                    activeCoords={activeCoords}
                    user={user}
                    onUseAsNeutralRef={(refData) => {
                      setCustomRef(refData);
                      setResultsTab2D('neurofoil');
                      setMobileTab('results');
                    }}
                  />
                  {airfoil.isCustom && airfoil.fixes && (
                    <ParserBox filename={airfoil.filename} fixes={airfoil.fixes} />
                  )}
                </div>
              )}

              {controlsTab2D === 'shape' && (
                <div className="antigravity-glass rounded-xl p-3.5 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border)]">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-[#161A1D]">
                      <Spline size={13} className="text-[#1769AA]" aria-hidden="true" />
                      <span>Bézier Geometry Editor</span>
                    </div>
                    <span className="text-[11px] font-mono text-[#5C6670] truncate">{airfoil.name}</span>
                  </div>

                  <ShapeEditor2D
                    sourceCoords={airfoil.coords}
                    foilName={airfoil.name}
                    onCoordsChange={(coords) => {
                      setActiveCoords(coords);
                      tunnelRef.current?.setCoords(coords, airfoil.name);
                    }}
                    onResetSource={() => {
                      setActiveCoords(airfoil.coords);
                      tunnelRef.current?.setCoords(airfoil.coords, airfoil.name);
                    }}
                    onSendTo3D={handleSend2DFoilTo3D}
                  />
                </div>
              )}
            </form>
          )}
        </section>

        {/* CENTER COLUMN: WIND TUNNEL STAGE */}
        <section
          id="wind-tunnel"
          aria-label={labMode === '3d' ? '3D Wind Tunnel Viewport' : '2D Wind Tunnel Viewport'}
          className={`
            ${mobileTab === 'tunnel' ? 'flex flex-1 w-full' : 'hidden lg:flex'}
            flex-1 min-w-0 h-full min-h-0 relative flex-col overflow-hidden bg-[var(--bg)] p-1.5 sm:p-3 gap-2
          `}
        >
          {labMode === '3d' ? (
            <>
              <div className="w-full h-full relative flex-1 min-h-0">
                {params3D.renderEngine !== 'canvas' ? (
                  <WindTunnelCanvasWebGL
                    params={params3D}
                    onParamChange={handleParam3DChange}
                    telemetry={telemetry3D}
                    isPaused={isPaused3D}
                    onFallbackToCanvas={() => handleParam3DChange('renderEngine', 'canvas')}
                    onOpenModelInspector={() => setIsModelViewerOpen(true)}
                    customGlbAsset={customGlbAsset}
                  />
                ) : (
                  <WindTunnelCanvas3D
                    params={params3D}
                    onParamChange={handleParam3DChange}
                    telemetry={telemetry3D}
                    isPaused={isPaused3D}
                    onOpenWebGL={webglSupported ? () => handleParam3DChange('renderEngine', 'webgl') : undefined}
                    onOpenModelInspector={() => setIsModelViewerOpen(true)}
                    customGlbCalibration={customGlbAsset?.calibration ?? null}
                  />
                )}
              </div>

              {/* Mobile/Tablet Quick Pitch & Pause Bar */}
              <div className="lg:hidden flex flex-wrap items-center justify-between gap-1.5 pt-0.5 px-0.5 flex-shrink-0">
                <div className="flex items-center gap-1 bg-[var(--surface)] p-1 rounded-lg border border-[var(--border)] shadow-sm">
                  <span className="text-[10px] text-[var(--text-secondary)] font-mono pl-1 pr-0.5">AoA:</span>
                  {[-5, 0, 5, 15].map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => handleParam3DChange('angle_of_attack', a)}
                      className={`px-2 py-1 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                        Math.abs(params3D.angle_of_attack - a) < 1
                          ? 'bg-[#1769AA] text-white font-semibold'
                          : 'bg-[var(--bg)] text-[var(--text)] hover:text-[#1769AA]'
                      }`}
                    >
                      {a >= 0 ? `+${a}°` : `${a}°`}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMobileTab('results')}
                    className="px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-semibold bg-[var(--surface)] border border-[var(--border)] text-[#1769AA] cursor-pointer"
                  >
                    L/D {telemetry3D.ldRatio.toFixed(1)}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPaused3D((prev) => !prev)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors shadow-sm cursor-pointer ${
                      isPaused3D
                        ? 'bg-amber-500 border-amber-600 text-slate-950 font-bold'
                        : 'bg-[var(--surface)] border-[var(--border)] text-[var(--text)] hover:border-[#1769AA]'
                    }`}
                  >
                    {isPaused3D ? 'Resume' : 'Pause'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="tunnel-stage flex-1 min-h-0 w-full">
                <div className="tunnel-card rounded-xl border border-[var(--border)] bg-[var(--dark)] flex flex-col overflow-hidden shadow-[var(--shadow-tech)]">
                  <div className="px-3 py-2 border-b border-[var(--dark-surface)] flex items-center justify-between gap-2 flex-shrink-0 bg-[#11161A]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Wind weight="duotone" className="w-4 h-4 text-[#38BDF8] shrink-0" />
                      <span className="text-xs sm:text-sm font-bold text-slate-100 truncate">
                        2D LBM Wind Tunnel
                      </span>
                      <span className="hidden sm:inline text-slate-600" aria-hidden="true">·</span>
                      <span className="hidden sm:inline text-xs font-mono text-slate-400 truncate">
                        {airfoil.name} · {activeFieldLabel2D}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="hidden md:inline text-[11px] font-mono tabular-nums text-slate-400 mr-1">
                        {isPaused2D ? 'Paused' : `${stepsPerFrame} steps/f`}
                      </span>
                      <button
                        type="button"
                        onClick={handleTogglePause2D}
                        className="px-2.5 py-1 rounded-md text-[11px] sm:text-xs font-semibold bg-[#1B2228] hover:bg-[#252E36] text-slate-200 border border-slate-700/70 transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        {isPaused2D ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
                        <span>{isPaused2D ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => tunnelRef.current?.savePng()}
                        className="px-2.5 py-1 rounded-md text-[11px] sm:text-xs font-semibold bg-[#1769AA] hover:bg-[#12568C] text-white transition-colors flex items-center gap-1 whitespace-nowrap cursor-pointer"
                      >
                        <Download size={12} aria-hidden="true" />
                        <span className="hidden min-[420px]:inline">Save PNG</span>
                      </button>
                    </div>
                  </div>

                  {glError2D && (
                    <div className="p-2.5 flex-shrink-0">
                      <Alert kind="error">{glError2D}</Alert>
                    </div>
                  )}

                  <canvas
                    ref={canvas2DRef}
                    width={640}
                    height={320}
                    className="tunnel-canvas bg-[#0D1114]"
                  />

                  <div className="px-3 py-1.5 border-t border-[var(--dark-surface)] flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400 flex-shrink-0 bg-[#11161A]">
                    <span className="truncate">640 × 320 D2Q9 Smagorinsky LES</span>
                    <span className="shrink-0">
                      α = {alpha2D.toFixed(1)}° · Re ≈ {simRe2D.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Mobile KPI Strip + Quick Bar */}
              <div className="lg:hidden flex flex-col gap-2 flex-shrink-0">
                <div className="grid grid-cols-4 divide-x divide-[var(--border)] antigravity-glass rounded-lg overflow-hidden [@media(max-height:520px)]:hidden">
                  <div className="px-2 py-1.5 text-center">
                    <div className="text-[10px] font-semibold text-[#5C6670]">CL</div>
                    <div className="text-xs font-bold font-mono tabular-nums text-[#161A1D]">
                      {stats2D.cl === null ? '—' : stats2D.cl.toFixed(2)}
                    </div>
                  </div>
                  <div className="px-2 py-1.5 text-center">
                    <div className="text-[10px] font-semibold text-[#5C6670]">CD</div>
                    <div className="text-xs font-bold font-mono tabular-nums text-[#161A1D]">
                      {stats2D.cd === null ? '—' : stats2D.cd.toFixed(3)}
                    </div>
                  </div>
                  <div className="px-2 py-1.5 text-center">
                    <div className="text-[10px] font-semibold text-[#5C6670]">L/D</div>
                    <div className="text-xs font-bold font-mono tabular-nums text-[#1769AA]">
                      {liftToDrag2D}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileTab('results')}
                    className="px-2 py-1.5 text-center cursor-pointer"
                  >
                    <div className="text-[10px] font-semibold text-[#5C6670]">Flow</div>
                    <div
                      className="text-[11px] font-bold font-mono truncate"
                      style={{ color: flowState2D.color }}
                    >
                      {flowState2D.label}
                    </div>
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1 bg-[var(--surface)] p-1 rounded-lg border border-[var(--border)]">
                    <span className="text-[10.5px] text-[var(--text-secondary)] font-mono pl-1 pr-0.5">AoA:</span>
                    {[-5, 0, 6, 12].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handleAlpha2DChange(preset)}
                        className={`px-2 py-1 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                          Math.abs(alpha2D - preset) < 0.3
                            ? 'bg-[#1769AA] text-white font-semibold'
                            : 'bg-[var(--bg)] text-[var(--text)] hover:text-[#1769AA]'
                        }`}
                      >
                        {preset}°
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <select
                      aria-label="Field view"
                      value={fieldMode2D}
                      onChange={(e) => handleField2DChange(e.target.value)}
                      className="px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-[var(--surface)] border border-[var(--border)] text-[var(--text)]"
                    >
                      {FIELD_MODES.map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleReset2D}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] cursor-pointer"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* RIGHT COLUMN: TELEMETRY, POLARS & ANALYTICS */}
        <section
          id="telemetry-results"
          aria-label="Flight Telemetry & Results"
          className={`
            ${showRightSidebar ? 'lg:flex lg:w-88 xl:w-[410px] 2xl:w-[430px]' : 'lg:hidden'}
            ${mobileTab === 'results' ? 'flex flex-1 w-full' : 'hidden'}
            min-w-0 flex-shrink-0 h-full overflow-y-auto overscroll-contain custom-scrollbar lg:border-l border-[var(--border)] bg-[var(--bg)] p-3 sm:p-3.5 pb-8 flex-col gap-3.5 z-20
          `}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <div className="flex items-center gap-2">
              <Pulse weight="duotone" className="w-4 h-4 text-[#1769AA]" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#161A1D]">
                {labMode === '3d' ? 'Telemetry & Polars' : 'Results & NeuroFoil'}
              </h2>
            </div>
            <span className="text-[11px] font-mono text-[#5C6670] truncate">
              {labMode === '3d' ? 'Vortex Lattice' : `${airfoil.name} · ${alpha2D.toFixed(1)}°`}
            </span>
          </div>

          {labMode === '3d' ? (
            <>
              <TelemetryHUD
                telemetry={telemetry3D}
                aoaDeg={params3D.angle_of_attack}
                modelType={params3D.modelType}
                params={params3D}
              />

              <AeroCharts
                modelType={params3D.modelType}
                currentAoa={params3D.angle_of_attack}
                airspeedKts={params3D.airspeed_kts}
                altitudeFt={params3D.altitude_ft}
                flapsDeg={params3D.flaps_deg}
                telemetry={telemetry3D}
                customGlbVersion={params3D.customGlbVersion}
              />

              <div className="antigravity-glass p-3.5 rounded-xl text-xs text-[#5C6670] flex flex-col gap-2 leading-relaxed">
                <div className="flex items-center gap-2 text-[#161A1D] font-semibold">
                  <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[#1769AA]/16 to-[#0EA5E9]/14 ring-1 ring-[#1769AA]/20 flex items-center justify-center text-[#1769AA]">
                    <Wind weight="duotone" className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-[#161A1D] font-bold text-xs">Vortex &amp; Vertex Flow Law</span>
                </div>
                <p className="text-[11px] leading-relaxed text-[#5C6670]">
                  Streamlines and PIV streaks are integrated with RK2 midpoint advection through a 3D Biot-Savart horseshoe vortex lattice coupled to real surface vertex normals for boundary tangential slip.
                  {telemetry3D.isStalled ? (
                    <span className="text-red-700 font-medium block mt-2 p-2 rounded-lg bg-red-50 border border-red-200">
                      Critical angle of attack exceeded. Adverse pressure gradients have detached the boundary layer, shedding unsteady von Kármán wake vortices.
                    </span>
                  ) : (
                    <span className="text-[#161A1D] block mt-1.5 font-medium">
                      Attached circulation Γ remains steady; Lamb-Oseen wingtip vortices trail downstream from actual spanwise tips.
                    </span>
                  )}
                </p>
              </div>
            </>
          ) : (
            <>
              {/* 4-Metric Live LBM KPI Grid */}
              <div className="antigravity-glass rounded-xl overflow-hidden shrink-0">
                <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border)]">
                  <div className="p-2.5">
                    <div className="text-[10.5px] font-semibold text-[#5C6670]">Lift (CL)</div>
                    <div className="text-base font-bold font-mono tabular-nums text-[#161A1D] mt-0.5">
                      {stats2D.cl === null ? '—' : stats2D.cl.toFixed(2)}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[10.5px] font-semibold text-[#5C6670]">Drag (CD)</div>
                    <div className="text-base font-bold font-mono tabular-nums text-[#161A1D] mt-0.5">
                      {stats2D.cd === null ? '—' : stats2D.cd.toFixed(3)}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[10.5px] font-semibold text-[#5C6670]">Glide (L/D)</div>
                    <div className="text-base font-bold font-mono tabular-nums text-[#1769AA] mt-0.5">
                      {liftToDrag2D}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[10.5px] font-semibold text-[#5C6670]">Reynolds</div>
                    <div className="text-base font-bold font-mono tabular-nums text-[#161A1D] mt-0.5">
                      {simRe2D.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="px-3 py-2 border-t border-[var(--border)] bg-[var(--bg)] flex items-center justify-between gap-2 text-xs">
                  <span
                    className="inline-flex items-center gap-1.5 font-semibold"
                    style={{ color: flowState2D.color }}
                  >
                    <flowState2D.Icon size={14} aria-hidden="true" />
                    <span>{flowState2D.label}</span>
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-[#5C6670]">
                    {sepPct2D}% chord · {activeCoords.length} pts
                  </span>
                </div>
              </div>

              <div
                role="tablist"
                aria-label="2D Results Views"
                className="grid grid-cols-2 p-0.5 rounded-lg bg-[var(--surface)] border border-[var(--border)] text-[11.5px] gap-0.5 shrink-0"
              >
                {(
                  [
                    { id: 'analytics', label: 'Analytics', Icon: TrendingUp },
                    { id: 'neurofoil', label: 'NeuroFoil', Icon: Radar },
                  ] as const
                ).map(({ id, label, Icon }) => {
                  const active = resultsTab2D === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setResultsTab2D(id)}
                      className={`py-1.5 px-2 rounded-md font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                        active
                          ? 'bg-[#1769AA] text-white'
                          : 'text-[#5C6670] hover:text-[#161A1D]'
                      }`}
                    >
                      <Icon size={12} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>

              {resultsTab2D === 'analytics' && (
                <ResultsAnalytics
                  samples={samples}
                  airfoilName={airfoil.name}
                  neutralRef={customRef || neurofoilPrediction.asReference}
                  bestBenchmark={benchmarks[0] || null}
                  onRecordSnapshot={() => appendSample(stats2D)}
                  onClearSamples={() => {
                    sampleIdRef.current = 0;
                    setSamples([]);
                  }}
                />
              )}

              {resultsTab2D === 'neurofoil' && (
                <BenchmarkComparison
                  stats={stats2D}
                  alpha={alpha2D}
                  airfoil={airfoil}
                  benchmarks={benchmarks}
                  neurofoilPrediction={neurofoilPrediction}
                  customRef={customRef}
                  onCustomRefChange={setCustomRef}
                  onJumpToAlpha={handleAlpha2DChange}
                  user={user}
                />
              )}
            </>
          )}
        </section>
      </main>

      {/* 3. QUIET WORKSTATION STATUS FOOTER */}
      <footer className="min-h-7 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:px-4 border-t border-[var(--border)] bg-[var(--surface)] flex items-center justify-between gap-2 text-[11px] text-[#5C6670] z-30 flex-shrink-0 overflow-hidden">
        <div className="hidden xl:flex items-center gap-2 whitespace-nowrap">
          <div className="flex items-center gap-1 text-[#161A1D] font-semibold">
            <Keyboard weight="duotone" className="w-3.5 h-3.5 text-[#1769AA]" />
            <span>Hotkeys:</span>
          </div>
          <span className="font-mono text-[10px] bg-[var(--bg)] border border-[var(--border)] px-1.5 rounded text-[#161A1D]">Space</span> Pause
          <span className="font-mono text-[10px] bg-[var(--bg)] border border-[var(--border)] px-1.5 rounded text-[#161A1D]">↑/↓</span> Pitch AoA
          <span className="font-mono text-[10px] bg-[var(--bg)] border border-[var(--border)] px-1.5 rounded text-[#161A1D]">←/→</span> {labMode === '3d' ? 'Airspeed' : 'Re Speed'}
          {labMode === '3d' && (
            <>
              <span className="font-mono text-[10px] bg-[var(--bg)] border border-[var(--border)] px-1.5 rounded text-[#161A1D]">M</span> Audio
            </>
          )}
          <span className="font-mono text-[10px] bg-[var(--bg)] border border-[var(--border)] px-1.5 rounded text-[#161A1D]">R</span> Reset
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 font-mono text-[10px] text-[#5C6670] tabular-nums whitespace-nowrap">
          {labMode === '3d' ? (
            <>
              <span className="hidden min-[380px]:inline">ISA Std Atm</span>
              <span className="hidden min-[380px]:inline text-[var(--border)]" aria-hidden="true">·</span>
              <span>FL{params3D.altitude_ft.toLocaleString()}</span>
              <span className="text-[var(--border)]" aria-hidden="true">·</span>
              <span>ρ = {telemetry3D.air_density_kg_m3.toFixed(3)} kg/m³</span>
            </>
          ) : (
            <>
              <span>640 × 320 D2Q9</span>
              <span className="text-[var(--border)]" aria-hidden="true">·</span>
              <span>{isStalled2D ? 'Separated Wake' : 'Attached Flow'}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-[#5C6670] text-[10.5px] whitespace-nowrap">
          <button
            type="button"
            onClick={() => setIsTheoryOpen(true)}
            className="hidden sm:inline hover:text-[#1769AA] font-medium transition-colors cursor-pointer"
          >
            Theory Guide
          </button>
          <span className="hidden sm:inline text-[var(--border)]" aria-hidden="true">·</span>
          <span className="font-medium text-[#161A1D]">Develop by Shadat Hossen Mahin</span>
          <span className="text-[var(--border)]" aria-hidden="true">·</span>
          <span className="font-mono text-[#5C6670]">@2026</span>
        </div>
      </footer>

      {/* Shared Theory & 3D CAD Inspector Modals */}
      <AeroTheoryModal isOpen={isTheoryOpen} onClose={() => setIsTheoryOpen(false)} />

      <ModelViewerModal
        isOpen={isModelViewerOpen}
        onClose={() => setIsModelViewerOpen(false)}
        activeModelType={params3D.modelType}
        onSelectModel={(modelType) => handleParam3DChange('modelType', modelType)}
        onApplyToWindTunnel={(modelType) => {
          handleParam3DChange('modelType', modelType);
          setLabMode('3d');
        }}
      />
    </div>
  );
}

export default function App() {
  const [labMode, setLabMode] = useState<LabMode>('3d');
  const tunnelRef = useRef<TunnelController | null>(null);
  const userSelectedAirfoilRef = useRef(false);

  const [choice, setChoice] = useState('naca0012.dat');
  const [airfoil, setAirfoil] = useState<AirfoilSelection>(() => ({
    name: 'NACA 0012',
    filename: 'naca0012.dat',
    coords: lbmNaca4(0, 4, 12, 60),
    fixes: null,
    isCustom: false,
  }));
  const [activeCoords, setActiveCoords] = useState<Coord2D[]>(() => lbmNaca4(0, 4, 12, 60));

  const {
    user,
    userProfile,
    authReady,
    authBusy,
    authError,
    authNotice,
    isSupabaseReady,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    enterLocalPilotMode,
    signOut,
    updateProfile,
    sharedAirfoils,
    sharedGlbModels,
    benchmarks,
    cloudError,
  } = useSupabase();
  const [pendingSavedGlb, setPendingSavedGlb] = useState<CustomGlbAsset | null>(null);

  const [customRef, setCustomRef] = useState<NeutralReferenceData | null>(null);
  const [alpha2D, setAlpha2D] = useState(DEFAULT_ALPHA_2D);
  const [fieldMode2D, setFieldMode2D] = useState('0');
  const [u0Scaled, setU0Scaled] = useState(DEFAULT_U0_MM);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const alphaRef = useRef(alpha2D);
  const airfoilNameRef = useRef(airfoil.name);
  const fieldModeRef = useRef(fieldMode2D);
  const sampleIdRef = useRef(0);
  alphaRef.current = alpha2D;
  airfoilNameRef.current = airfoil.name;
  fieldModeRef.current = fieldMode2D;

  const appendSample = useCallback((nextStats: TunnelStats) => {
    if (nextStats.cl === null || nextStats.cd === null) return;
    sampleIdRef.current += 1;
    const sep = nextStats.separationPct;
    const stateLabel = sep < 5 ? 'Attached' : sep < 25 ? 'Sep' : 'Stall';
    const fieldLabel = FIELD_MODES.find(([v]) => v === fieldModeRef.current)?.[1] || 'Velocity';
    const ld = nextStats.cd > 0.001 ? nextStats.cl / nextStats.cd : null;
    const row: TelemetrySample = {
      id: sampleIdRef.current,
      airfoil: airfoilNameRef.current,
      alpha: alphaRef.current,
      reynolds: nextStats.reynolds,
      cl: nextStats.cl,
      cd: nextStats.cd,
      ld,
      separationPct: sep,
      stateLabel,
      fieldLabel,
      timestamp: new Date().toISOString(),
    };
    setSamples((prev) => (prev.length >= 180 ? [...prev.slice(-179), row] : [...prev, row]));
  }, []);

  // Load initial NACA 0012 .dat coordinates
  useEffect(() => {
    let alive = true;
    loadExample('naca0012.dat')
      .then((txt) => {
        if (!alive || userSelectedAirfoilRef.current) return;
        const { coords, fixes } = parseDatText(txt);
        setAirfoil({
          name: 'NACA 0012',
          filename: 'naca0012.dat',
          coords,
          fixes,
          isCustom: false,
        });
        setActiveCoords(coords);
        tunnelRef.current?.setCoords(coords, 'NACA 0012');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleSelectAirfoil = useCallback((next: AirfoilSelection) => {
    userSelectedAirfoilRef.current = true;
    setAirfoil(next);
    setActiveCoords(next.coords);
    tunnelRef.current?.setCoords(next.coords, next.name);
  }, []);

  const handleApplyRun = useCallback(
    async (run: BenchmarkRunDoc) => {
      setLabMode('2d');
      const clampedAlpha = Math.max(-20, Math.min(25, Number(run.alpha) || DEFAULT_ALPHA_2D));
      setAlpha2D(clampedAlpha);
      tunnelRef.current?.setAlpha(clampedAlpha);
      if (Number.isFinite(run.reynolds) && run.reynolds > 0) {
        const lbmConstants = LBM as typeof LBM & { NU: number; CHORD_L: number };
        const targetU0 = (run.reynolds * lbmConstants.NU) / lbmConstants.CHORD_L;
        const scaled = Math.max(30, Math.min(100, Math.round(targetU0 * 1000)));
        setU0Scaled(scaled);
        tunnelRef.current?.setU0(scaled / 1000);
      }

      const targetId = (run.airfoilId || '').trim();
      const targetName = (run.airfoilName || '').trim().toLowerCase();
      const matchedShared = sharedAirfoils.find(
        (a) => a.id === targetId || a.name.toLowerCase() === targetName
      );
      if (matchedShared) {
        try {
          const { coords, fixes } = parseDatText(matchedShared.coordsText);
          setChoice(`cloud:${matchedShared.id}`);
          handleSelectAirfoil({
            id: matchedShared.id,
            name: matchedShared.name,
            filename: matchedShared.filename,
            coords,
            fixes,
            isCustom: false,
            isShared: true,
            uploaderName: matchedShared.uploaderName,
          });
          return;
        } catch {
          // fall through to bundled check
        }
      }

      const matchedExample = EXAMPLE_AIRFOILS.find(
        ([label, file]) => file === targetId || label.toLowerCase() === targetName
      );
      if (matchedExample) {
        try {
          const txt = await loadExample(matchedExample[1]);
          const { coords, fixes } = parseDatText(txt);
          setChoice(matchedExample[1]);
          handleSelectAirfoil({
            id: matchedExample[1],
            name: matchedExample[0],
            filename: matchedExample[1],
            coords,
            fixes,
            isCustom: false,
            isShared: false,
          });
        } catch {
          // keep current airfoil if example fetch fails
        }
      }
    },
    [sharedAirfoils, handleSelectAirfoil]
  );

  const handleLoadGlbModelFromProfile = useCallback(async (doc: SharedGlbModelDoc) => {
    const asset = await buildCustomGlbAssetFromDoc(doc);
    setPendingSavedGlb(asset);
    setLabMode('3d');
  }, []);

  const handleConsumePendingSavedGlb = useCallback(() => {
    setPendingSavedGlb(null);
  }, []);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <UnifiedWorkstation
            labMode={labMode}
            setLabMode={setLabMode}
            choice={choice}
            setChoice={setChoice}
            airfoil={airfoil}
            activeCoords={activeCoords}
            setActiveCoords={setActiveCoords}
            onSelectAirfoil={handleSelectAirfoil}
            user={user}
            userProfile={userProfile}
            benchmarks={benchmarks}
            sharedAirfoils={sharedAirfoils}
            cloudError={cloudError}
            customRef={customRef}
            setCustomRef={setCustomRef}
            alpha2D={alpha2D}
            setAlpha2D={setAlpha2D}
            fieldMode2D={fieldMode2D}
            setFieldMode2D={setFieldMode2D}
            u0Scaled={u0Scaled}
            setU0Scaled={setU0Scaled}
            samples={samples}
            setSamples={setSamples}
            sampleIdRef={sampleIdRef}
            appendSample={appendSample}
            tunnelRef={tunnelRef}
            pendingSavedGlb={pendingSavedGlb}
            onConsumePendingSavedGlb={handleConsumePendingSavedGlb}
          />
        }
      />
      <Route
        path="/profile"
        element={
          <ProfilePage
            user={user}
            userProfile={userProfile}
            authReady={authReady}
            authBusy={authBusy}
            authError={authError}
            authNotice={authNotice}
            cloudError={cloudError}
            isSupabaseReady={isSupabaseReady}
            onSignInWithEmail={signInWithEmail}
            onSignUpWithEmail={signUpWithEmail}
            onSignInWithGoogle={signInWithGoogle}
            onEnterLocalMode={enterLocalPilotMode}
            onSignOut={signOut}
            onUpdateProfile={updateProfile}
            sharedAirfoils={sharedAirfoils}
            sharedGlbModels={sharedGlbModels}
            benchmarks={benchmarks}
            onLoadAirfoil={(loaded) => {
              setChoice(loaded.choice);
              handleSelectAirfoil(loaded);
              setLabMode('2d');
            }}
            onLoadGlbModel={handleLoadGlbModelFromProfile}
            onApplyRun={handleApplyRun}
          />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
