export type AircraftModelType = 
  | 'f22' 
  | 'airliner' 
  | 'naca2412' 
  | 'naca0012' 
  | 'custom_airfoil'
  | 'custom_glb'
  | 'concorde' 
  | 'cylinder';

export interface AircraftModelConfig {
  id: AircraftModelType;
  name: string;
  category: 'Fighter' | 'Commercial' | 'Airfoil' | 'Supersonic' | 'Bluff Body';
  description: string;
  wingspan: number; // meters
  chord: number; // meters
  sweepDeg?: number; // quarter-chord sweep angle in degrees
  oswaldEfficiency?: number; // Oswald span efficiency factor e (0 < e <= 1)
  thicknessRatio?: number; // max thickness-to-chord t/c
  camberRatio?: number; // max camber-to-chord m/c
  stallAngle: number; // degrees
  cl0: number; // nominal 2D section lift coefficient at 0 deg AoA
  alphaZeroLift?: number; // zero-lift angle of attack in degrees
  clMax: number;
  cd0: number; // parasitic drag preset
  flapCapable: boolean;
  supersonicCapable: boolean;
  glbPath?: string;
  hasGlbModel?: boolean;
}

export type VisualMode = 
  | 'streamlines' 
  | 'particles' 
  | 'heatmap' 
  | 'pressure' 
  | 'vectors' 
  | 'all';

export interface SimulationParams {
  modelType: AircraftModelType;
  angle_of_attack: number; // degrees (-20 to +35)
  airspeed_kts: number; // knots (40 to 1400)
  altitude_ft: number; // feet (0 to 50000)
  flaps_deg: number; // degrees (0 to 40)
  viscosity: number; // simulation visual viscosity
  smoke_density: number; // smoke trail thickness
  show_streamlines: boolean;
  show_particles: boolean;
  show_heatmap: boolean;
  show_pressure_vectors: boolean;
  show_quiver: boolean;
  show_shockwaves: boolean;
  audio_enabled: boolean;
  renderEngine?: 'webgl' | 'canvas';
  renderShading?: 'pbr' | 'wireframe' | 'cfdHeatmap' | 'xray';
  customAirfoilVersion?: number;
  customGlbVersion?: number;
  customGlbFlipNose?: boolean;
  customGlbYawDeg?: number;
  // Visual 3D/2D Engineering Annotations
  show_stagnation_annotation?: boolean;
  show_transition_annotation?: boolean;
  show_separation_annotation?: boolean;
  show_vortex_filaments?: boolean;
  show_downwash_vectors?: boolean;
}

export type CompressibilityRegime =
  | 'incompressible'
  | 'prandtl-glauert'
  | 'transonic-limit';

export type ReynoldsRegime =
  | 'laminar-dominated'
  | 'transitional-regime'
  | 'turbulent-dominated';

export interface RegimeWarning {
  code:
    | 'MACH_COMPRESSIBLE'
    | 'MACH_TRANSONIC_LIMIT'
    | 'MACH_SUPERSONIC'
    | 'KNUDSEN_NON_CONTINUUM';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
}

export interface ChordwiseCpStation {
  xc: number;
  cpUpper: number;
  cpLower: number;
  cpUpperIncomp: number;
  cpLowerIncomp: number;
  cfUpper: number;
  cfLower: number;
}

export interface AeroTelemetry {
  cl: number; // Total Lift coefficient
  cd: number; // Exact sum: cd0 + cdi + cdSep + cdWave
  ldRatio: number; // Lift-to-drag
  lift_N: number; // Lift force in Newtons
  drag_N: number; // Drag force in Newtons
  reynolds: number; // Re = rho * V_inf * c / mu
  reynoldsRegime: ReynoldsRegime; // Reynolds-number regime indicator (NOT a solved transition location)
  reynoldsRegimeLabel: string;
  mach: number; // M_inf = V_inf / a
  knudsen: number; // Kn = (M_inf / Re) * sqrt(gamma * pi / 2)
  dynamic_pressure_pa: number; // q_inf = 1/2 rho V_inf^2 (Pa)
  air_density_kg_m3: number; // rho (kg/m^3)

  // ISA & Regime Validity (SI)
  altitude_m: number; // meters (0..20000)
  airspeed_ms: number; // true airspeed (m/s)
  temperature_K: number; // static temperature T (K)
  pressure_Pa: number; // static pressure P (Pa)
  dynamic_viscosity_Pa_s: number; // Sutherland viscosity mu (Pa*s)
  speed_of_sound_ms: number; // a = sqrt(gamma * R * T) (m/s)
  prandtlGlauertFactor: number; // 1 / sqrt(1 - M^2) for 0.3 < M <= 0.7
  compressibilityRegime: CompressibilityRegime;
  continuumValid: boolean; // Kn <= 0.01
  regimeWarnings: RegimeWarning[];

  // Surface Cp Split & Circulation Metrics
  clUpper: number; // Integrated upper surface lift: int (-Cp_upper) d(x/c)
  clLower: number; // Integrated lower surface lift: int (+Cp_lower) d(x/c)
  suctionPercentage: number; // Upper share of lift from surrogate Cp integration
  compressionPercentage: number; // Lower share of lift from surrogate Cp integration
  surfacePressureSplitMode: 'integrated-surrogate-cp' | 'illustrative-split';
  kuttaTeDeltaCp: number; // Trailing-edge |Cp_lower(1) - Cp_upper(1)|
  equivalentCirculation_m2_s: number; // Gamma_eq = 0.5 * V_inf * c * CL (inferred from total lift)
  ellipticRootCirculation_m2_s: number; // Gamma_0 = (2/pi) * V_inf * c * CL (elliptic vortex-model peak)
  boundCirculation_m2_s: number; // Alias of equivalentCirculation_m2_s for backward compatibility
  kuttaLift_N: number; // Equivalent lift rho * V_inf * Gamma_eq * b (consistency identity with CL)
  pressureLiftCheck_N: number; // L_p = q_inf * S * (clUpper + clLower) (quadrature check)

  aspectRatio: number; // AR = b^2 / S
  oswaldEfficiency: number; // Oswald span efficiency e
  inducedAlpha_deg: number; // alpha_i = CL / (pi * e * AR) in degrees
  downwashAngle_deg: number; // Far-field Trefftz downwash epsilon = 2 * alpha_i in degrees

  // Drag Decomposition: CD = cd0 + cdi + cdSep + cdWave
  cd0: number; // Preset parasitic / profile drag + flap increment
  cdi: number; // Induced vortex drag CL^2 / (pi * e * AR)
  cdSep: number; // Boundary-layer separation / stall drag (empirical)
  cdWave: number; // Transonic / supersonic wave drag (empirical)

  // Empirical/Heuristic Boundary-Layer & Flat-Plate Reference Estimates
  xTransitionUpper: number; // Empirical transition estimate x_tr / c on upper surface (0..1)
  xTransitionLower: number; // Empirical transition estimate x_tr / c on lower surface (0..1)
  xSeparationUpper: number; // Empirical separation onset estimate x_sep / c (0..1)
  stagnationXc: number; // Estimated leading-edge stagnation location x_stag / c
  skinFrictionDrag_cdf: number; // Integrated Blasius + Schlichting Cf(x) flat-plate reference CD,f
  laminarFlatPlateCfMean: number; // Blasius plate-averaged Cf_bar = 1.328 / sqrt(Re)
  turbulentFlatPlateCfMean: number; // Schlichting plate-averaged Cf_bar = 0.074 / Re^0.2
  maxAdversePressureGrad: number; // Peak upper adverse pressure gradient max(dCp / d(x/c))
  boundaryLayerRegime: 'Fully Laminar' | 'Transitional' | 'Turbulent Attached' | 'Separated';

  isStalled: boolean;
  stallMargin: number; // degrees before stall
  flowState: 'Laminar' | 'Attached Turbulent' | 'Incipient Stall' | 'Deep Stall' | 'Transonic Shock' | 'Supersonic Wave';
  solverModel: string; // Explicit reduced-order model identifier
}

export interface Point2D {
  x: number;
  y: number;
}

export interface PolygonSurfacePoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  isUpper: boolean;
  chordFraction: number; // 0 (leading edge) to 1 (trailing edge)
}
