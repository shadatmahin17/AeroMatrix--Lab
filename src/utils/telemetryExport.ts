import { AeroTelemetry, AircraftModelType, SimulationParams } from '../types/aerodynamics';
import { AIRCRAFT_MODELS, calculateAeroTelemetry } from './airfoilGenerators';

export interface ExportDataPayload {
  telemetry: AeroTelemetry;
  aoaDeg: number;
  modelType: AircraftModelType;
  params: SimulationParams;
  suctionPercentage: number;
  compressionPercentage: number;
  downwashDeg: number;
}

export interface PolarSweepPoint {
  aoa_deg: number;
  cl: number;
  cd: number;
  ld_ratio: number;
  lift_N: number;
  drag_N: number;
  is_stalled: boolean;
  flow_state: string;
}

/**
 * Computes a standardized sweep across the operational AoA envelope (-15 deg to +30 deg)
 */
export function generatePolarSweep(
  modelType: AircraftModelType,
  airspeedKts: number,
  altitudeFt: number,
  flapsDeg: number
): PolarSweepPoint[] {
  const sweep: PolarSweepPoint[] = [];
  for (let a = -15; a <= 30; a = Math.round((a + 1.5) * 10) / 10) {
    const pt = calculateAeroTelemetry(modelType, a, airspeedKts, altitudeFt, flapsDeg);
    sweep.push({
      aoa_deg: a,
      cl: parseFloat(pt.cl.toFixed(4)),
      cd: parseFloat(pt.cd.toFixed(4)),
      ld_ratio: parseFloat(pt.ldRatio.toFixed(2)),
      lift_N: Math.round(pt.lift_N),
      drag_N: Math.round(pt.drag_N),
      is_stalled: pt.isStalled,
      flow_state: pt.flowState,
    });
  }
  return sweep;
}

/**
 * Generates and downloads a complete JSON snapshot file.
 */
export function downloadTelemetryJSON(payload: ExportDataPayload): string {
  const { telemetry } = payload;
  const currentModel = AIRCRAFT_MODELS[payload.modelType];
  const timestamp = new Date().toISOString();
  const polarSweep = generatePolarSweep(
    payload.modelType,
    payload.params.airspeed_kts,
    payload.params.altitude_ft,
    payload.params.flaps_deg
  );

  const aspectRatio = telemetry.aspectRatio || (
    Math.pow(currentModel.wingspan, 2) / (currentModel.wingspan * currentModel.chord)
  );

  const jsonSnapshot = {
    version: '2.0.0',
    generator: 'AeroLab Aerodynamics Simulation & Engineering Laboratory',
    solverModel: telemetry.solverModel,
    timestamp,
    aircraft: {
      id: currentModel.id,
      name: currentModel.name,
      category: currentModel.category,
      description: currentModel.description,
      wingspan_m: currentModel.wingspan,
      chord_m: currentModel.chord,
      reference_area_m2: parseFloat((currentModel.wingspan * currentModel.chord).toFixed(3)),
      aspect_ratio: parseFloat(aspectRatio.toFixed(2)),
      oswald_efficiency: telemetry.oswaldEfficiency,
      stall_angle_deg: currentModel.stallAngle,
      parasite_drag_coefficient_cd0: telemetry.cd0,
    },
    flightConditions: {
      airspeed_kts: payload.params.airspeed_kts,
      airspeed_mps: telemetry.airspeed_ms,
      altitude_ft: payload.params.altitude_ft,
      altitude_m: telemetry.altitude_m,
      angle_of_attack_deg: parseFloat(payload.aoaDeg.toFixed(2)),
      flaps_deg: payload.params.flaps_deg,
      temperature_K: telemetry.temperature_K,
      pressure_Pa: telemetry.pressure_Pa,
      air_density_kg_m3: telemetry.air_density_kg_m3,
      dynamic_viscosity_Pa_s: telemetry.dynamic_viscosity_Pa_s,
      speed_of_sound_mps: telemetry.speed_of_sound_ms,
      mach_number: telemetry.mach,
      dynamic_pressure_pa: telemetry.dynamic_pressure_pa,
      reynolds_number: telemetry.reynolds,
      reynolds_regime_indicator: telemetry.reynoldsRegimeLabel,
      knudsen_number: telemetry.knudsen,
      prandtl_glauert_factor: telemetry.prandtlGlauertFactor,
      compressibility_regime: telemetry.compressibilityRegime,
      continuum_valid: telemetry.continuumValid,
      regime_warnings: telemetry.regimeWarnings,
    },
    telemetryResults: {
      lift_force_N: telemetry.lift_N,
      drag_force_N: telemetry.drag_N,
      lift_coefficient_cl: telemetry.cl,
      cl_upper_integrated: telemetry.clUpper,
      cl_lower_integrated: telemetry.clLower,
      surface_pressure_split_mode: telemetry.surfacePressureSplitMode,
      drag_coefficient_cd: telemetry.cd,
      drag_decomposition: {
        cd0_parasitic: telemetry.cd0,
        cdi_induced: telemetry.cdi,
        cd_separation: telemetry.cdSep,
        cd_wave: telemetry.cdWave,
      },
      lift_to_drag_ratio: telemetry.ldRatio,
      boundary_flow_state: telemetry.flowState,
      is_stalled: telemetry.isStalled,
      stall_margin_deg: telemetry.stallMargin,
      upper_surface_suction_contribution_pct: telemetry.suctionPercentage,
      lower_surface_compression_contribution_pct: telemetry.compressionPercentage,
      kutta_trailing_edge_delta_cp: telemetry.kuttaTeDeltaCp,
      equivalent_circulation_inferred_m2_s: telemetry.equivalentCirculation_m2_s,
      elliptic_vortex_root_circulation_m2_s: telemetry.ellipticRootCirculation_m2_s,
      pressure_integrated_lift_N: telemetry.pressureLiftCheck_N,
      induced_alpha_deg: telemetry.inducedAlpha_deg,
      downwash_deflection_deg: telemetry.downwashAngle_deg,
      empirical_boundary_layer_estimates: {
        regime_indicator: telemetry.boundaryLayerRegime,
        transition_upper_xc_est: telemetry.xTransitionUpper,
        transition_lower_xc_est: telemetry.xTransitionLower,
        separation_upper_xc_est: telemetry.xSeparationUpper,
        stagnation_xc_est: telemetry.stagnationXc,
        skin_friction_drag_cdf_ref: telemetry.skinFrictionDrag_cdf,
        blasius_flat_plate_mean_cf: telemetry.laminarFlatPlateCfMean,
        schlichting_flat_plate_mean_cf: telemetry.turbulentFlatPlateCfMean,
        max_adverse_pressure_gradient: telemetry.maxAdversePressureGrad,
      },
    },
    polarSweepEnvelope: polarSweep,
  };

  const jsonString = JSON.stringify(jsonSnapshot, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8;' });
  const fileName = `aerolab_${currentModel.id}_aoa${payload.aoaDeg >= 0 ? '+' : ''}${payload.aoaDeg.toFixed(1)}deg_m${telemetry.mach.toFixed(2)}.json`;

  triggerDownload(blob, fileName);
  return fileName;
}

/**
 * Generates and downloads a multi-table CSV file containing operational parameters
 * and a full aerodynamic polar sweep.
 */
export function downloadTelemetryCSV(payload: ExportDataPayload): string {
  const { telemetry } = payload;
  const currentModel = AIRCRAFT_MODELS[payload.modelType];
  const timestamp = new Date().toISOString();
  const polarSweep = generatePolarSweep(
    payload.modelType,
    payload.params.airspeed_kts,
    payload.params.altitude_ft,
    payload.params.flaps_deg
  );

  const aspectRatio = telemetry.aspectRatio || (
    Math.pow(currentModel.wingspan, 2) / (currentModel.wingspan * currentModel.chord)
  );

  // Section 1: Snapshot flight parameters
  const paramRows: [string, string, string, string][] = [
    ['# SECTION 1: INSTANTANEOUS FLIGHT SNAPSHOT', '', '', ''],
    ['Metric', 'Value', 'Unit', 'Description'],
    ['Timestamp', timestamp, 'ISO 8601', 'Simulation capture timestamp'],
    ['Solver Model', telemetry.solverModel, '-', 'Explicit reduced-order solver identity'],
    ['Model Identifier', currentModel.id, '-', 'Aircraft model ID'],
    ['Model Full Name', currentModel.name, '-', 'Aircraft designation'],
    ['Category', currentModel.category, '-', 'Aircraft category classification'],
    ['Wingspan (b)', currentModel.wingspan.toString(), 'm', 'Wing tip to tip distance'],
    ['Mean Aerodynamic Chord (c)', currentModel.chord.toString(), 'm', 'Average wing chord length'],
    ['Reference Wing Area (S)', (currentModel.wingspan * currentModel.chord).toFixed(2), 'm2', 'Aerodynamic planform area'],
    ['Aspect Ratio (AR)', aspectRatio.toFixed(2), '-', 'Wing aspect ratio b^2 / S'],
    ['Oswald Span Efficiency (e)', telemetry.oswaldEfficiency.toFixed(3), '-', 'Lifting-line span efficiency factor'],
    ['Angle of Attack (alpha)', payload.aoaDeg.toFixed(2), 'deg', 'Wing chord to relative wind angle'],
    ['Airspeed', payload.params.airspeed_kts.toFixed(1), 'knots', 'Display airspeed'],
    ['True Airspeed (V_inf)', telemetry.airspeed_ms.toFixed(2), 'm/s', 'SI true flow velocity'],
    ['Mach Number (M_inf)', telemetry.mach.toFixed(3), 'M', 'Speed ratio to local speed of sound'],
    ['Prandtl-Glauert Factor', telemetry.prandtlGlauertFactor.toFixed(4), '-', 'Compressibility factor 1/sqrt(1-M^2)'],
    ['Compressibility Regime', telemetry.compressibilityRegime, '-', 'Aerodynamic compressibility regime'],
    ['Test Altitude', payload.params.altitude_ft.toString(), 'ft', 'Display altitude'],
    ['ISA Altitude (h)', telemetry.altitude_m.toFixed(1), 'm', 'SI geopotential altitude (0-20000 m)'],
    ['ISA Temperature (T)', telemetry.temperature_K.toFixed(2), 'K', 'ISA static temperature'],
    ['ISA Pressure (P)', telemetry.pressure_Pa.toString(), 'Pa', 'ISA static pressure'],
    ['Air Density (rho)', telemetry.air_density_kg_m3.toFixed(5), 'kg/m3', 'ISA atmospheric mass density'],
    ['Sutherland Viscosity (mu)', telemetry.dynamic_viscosity_Pa_s.toExponential(4), 'Pa*s', 'Dynamic viscosity via Sutherland Law'],
    ['Speed of Sound (a)', telemetry.speed_of_sound_ms.toFixed(2), 'm/s', 'Local speed of sound sqrt(gamma*R*T)'],
    ['Dynamic Pressure (q_inf)', telemetry.dynamic_pressure_pa.toString(), 'Pa', '0.5 * rho * V_inf^2'],
    ['Reynolds Number (Re)', telemetry.reynolds.toString(), '-', 'rho * V_inf * c / mu'],
    ['Reynolds Regime Indicator', telemetry.reynoldsRegimeLabel, '-', 'Re-based regime indicator (not solved transition)'],
    ['Knudsen Number (Kn)', telemetry.knudsen.toExponential(3), '-', '(M / Re) * sqrt(gamma * pi / 2)'],
    ['Continuum Assumption', telemetry.continuumValid ? 'VALID (Kn <= 0.01)' : 'BREAKDOWN (Kn > 0.01)', '-', 'Continuum validity check'],
    ['Trailing Flaps Deflection', payload.params.flaps_deg.toString(), 'deg', 'High-lift flap angle'],
    ['Lift Coefficient (CL)', telemetry.cl.toFixed(4), '-', 'Total lift coefficient'],
    ['Upper Surface Lift (CL_upper)', telemetry.clUpper.toFixed(4), '-', 'Surrogate Cp integration upper share'],
    ['Lower Surface Lift (CL_lower)', telemetry.clLower.toFixed(4), '-', 'Surrogate Cp integration lower share'],
    ['Pressure Split Mode', telemetry.surfacePressureSplitMode, '-', 'Integrated surrogate Cp vs illustrative split'],
    ['Kutta TE Residual |Delta Cp|', telemetry.kuttaTeDeltaCp.toFixed(4), '-', 'Trailing-edge pressure difference'],
    ['Equivalent Circulation (Gamma_eq)', telemetry.equivalentCirculation_m2_s.toFixed(2), 'm2/s', 'Inferred from total lift: 0.5 * V_inf * c * CL'],
    ['Elliptic Vortex Peak (Gamma_0)', telemetry.ellipticRootCirculation_m2_s.toFixed(2), 'm2/s', 'Spanwise elliptic vortex-model peak: (2/pi)*V_inf*c*CL'],
    ['Integrated Cp Lift Check', telemetry.pressureLiftCheck_N.toString(), 'N', 'q_inf * S * (CL_upper + CL_lower)'],
    ['Total Drag Coefficient (CD)', telemetry.cd.toFixed(4), '-', 'Exact sum: CD0 + CDi + CDsep + CDwave'],
    ['Parasitic Drag (CD0)', telemetry.cd0.toFixed(4), '-', 'Preset zero-lift profile + flap drag'],
    ['Induced Drag (CDi)', telemetry.cdi.toFixed(4), '-', 'CL^2 / (pi * e * AR)'],
    ['Separation Drag (CDsep)', telemetry.cdSep.toFixed(4), '-', 'Empirical boundary-layer stall pressure drag'],
    ['Wave Drag (CDwave)', telemetry.cdWave.toFixed(4), '-', 'Transonic / supersonic wave drag'],
    ['Aerodynamic Efficiency (L/D)', telemetry.ldRatio.toFixed(2), ':1', 'Lift-to-drag glide ratio'],
    ['Total Aerodynamic Lift', telemetry.lift_N.toString(), 'N', 'Total lift force'],
    ['Total Aerodynamic Drag', telemetry.drag_N.toString(), 'N', 'Total drag force'],
    ['Boundary Flow State', telemetry.flowState, '-', 'Flow regime classification'],
    ['Stall Status', telemetry.isStalled ? 'STALLED' : 'ATTACHED', '-', 'Stall flag'],
    ['Stall Margin', telemetry.stallMargin.toFixed(2), 'deg', 'Margin before critical separation'],
    ['Upper Suction Contribution', telemetry.suctionPercentage.toFixed(1), '%', 'Upper pressure split share'],
    ['Lower Compression Contribution', telemetry.compressionPercentage.toFixed(1), '%', 'Lower pressure split share'],
    ['Induced AoA (alpha_i)', telemetry.inducedAlpha_deg.toFixed(2), 'deg', 'CL / (pi * e * AR)'],
    ['Downwash Deflection (epsilon)', telemetry.downwashAngle_deg.toFixed(2), 'deg', 'Far-wake 2 * CL / (pi * e * AR)'],
    ['Empirical BL Regime', telemetry.boundaryLayerRegime, '-', 'Empirical transition & separation indicator'],
    ['Empirical Upper Transition (x_tr/c)', telemetry.xTransitionUpper.toFixed(3), '-', 'Empirical laminar-to-turbulent transition estimate'],
    ['Empirical Lower Transition (x_tr/c)', telemetry.xTransitionLower.toFixed(3), '-', 'Empirical lower surface transition estimate'],
    ['Empirical Separation (x_sep/c)', telemetry.xSeparationUpper.toFixed(3), '-', 'Empirical separation onset estimate'],
    ['Stagnation Point (x_stag/c)', telemetry.stagnationXc.toFixed(3), '-', 'Leading-edge stagnation chord fraction'],
    ['Flat-Plate Skin Friction (CD,f)', telemetry.skinFrictionDrag_cdf.toFixed(5), '-', 'Integrated Blasius + Schlichting Cf(x) reference'],
    ['Blasius Mean Cf_bar', telemetry.laminarFlatPlateCfMean.toFixed(5), '-', '1.328 / sqrt(Re)'],
    ['Schlichting Mean Cf_bar', telemetry.turbulentFlatPlateCfMean.toFixed(5), '-', '0.074 / Re^0.2'],
    ['Peak Adverse dCp/d(x/c)', telemetry.maxAdversePressureGrad.toFixed(2), '-', 'Maximum upper-surface adverse pressure gradient']
  ];

  // Section 2: Polar sweep table
  const sweepHeader: string[] = [
    '# SECTION 2: AERODYNAMIC POLAR SWEEP (-15 deg to +30 deg)',
    '',
    '',
    '',
    '',
    '',
    ''
  ];
  const sweepCols = ['AoA (deg)', 'Lift Coeff (CL)', 'Drag Coeff (CD)', 'Glide Ratio (L/D)', 'Lift Force (N)', 'Drag Force (N)', 'Flow State'];
  const sweepRows = polarSweep.map((pt) => [
    pt.aoa_deg.toFixed(1),
    pt.cl.toFixed(4),
    pt.cd.toFixed(4),
    pt.ld_ratio.toFixed(2),
    pt.lift_N.toString(),
    pt.drag_N.toString(),
    pt.is_stalled ? `STALL (${pt.flow_state})` : pt.flow_state,
  ]);

  const escapeCell = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const formatRows = (rows: string[][]) =>
    rows.map((row) => row.map(escapeCell).join(',')).join('\n');

  const csvContent = [
    formatRows(paramRows),
    '',
    sweepHeader.map(escapeCell).join(','),
    sweepCols.map(escapeCell).join(','),
    formatRows(sweepRows),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const fileName = `aerolab_${currentModel.id}_aoa${payload.aoaDeg >= 0 ? '+' : ''}${payload.aoaDeg.toFixed(1)}deg_m${payload.telemetry.mach.toFixed(2)}.csv`;

  triggerDownload(blob, fileName);
  return fileName;
}

/**
 * Exports an SVG element directly as a vector .svg file.
 */
export function downloadSvgElement(svgElement: SVGSVGElement, baseName: string): string {
  // Clone to avoid modifying the DOM
  const clone = svgElement.cloneNode(true) as SVGSVGElement;

  // Ensure attributes for standalone rendering
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  // Insert background if none exists
  const existingRect = clone.querySelector('rect.export-bg');
  if (!existingRect) {
    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', '#070b14');
    clone.insertBefore(bgRect, clone.firstChild);
  }

  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clone);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const fileName = `${baseName}.svg`;

  triggerDownload(blob, fileName);
  return fileName;
}

/**
 * Renders an SVG element into an in-memory Canvas at high DPI and downloads as PNG.
 */
export function downloadSvgAsPng(
  svgElement: SVGSVGElement,
  baseName: string,
  pixelRatio: number = 2
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const clone = svgElement.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

      // Ensure dark background rect
      const existingRect = clone.querySelector('rect.export-bg');
      if (!existingRect) {
        const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bgRect.setAttribute('width', '100%');
        bgRect.setAttribute('height', '100%');
        bgRect.setAttribute('fill', '#070b14');
        clone.insertBefore(bgRect, clone.firstChild);
      }

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(clone);
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      const viewBox = svgElement.viewBox.baseVal;
      const width = (viewBox && viewBox.width > 0 ? viewBox.width : svgElement.clientWidth || 440) * pixelRatio;
      const height = (viewBox && viewBox.height > 0 ? viewBox.height : svgElement.clientHeight || 190) * pixelRatio;

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to get 2D canvas context'));
          return;
        }

        // Fill background
        ctx.fillStyle = '#070b14';
        ctx.fillRect(0, 0, width, height);

        // Draw image
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Canvas toBlob failed'));
            return;
          }
          const fileName = `${baseName}.png`;
          triggerDownload(blob, fileName);
          resolve(fileName);
        }, 'image/png');
      };

      img.onerror = (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      };

      img.src = url;
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Exports discrete curve point coordinates to CSV.
 */
export function downloadCurveDataCSV(
  points: Array<{ x: number; y: number; label?: string }>,
  xName: string,
  yName: string,
  baseName: string
): string {
  const header = `"${xName}","${yName}","Status/Label"`;
  const rows = points.map(
    (pt) => `"${pt.x.toFixed(4)}","${pt.y.toFixed(4)}","${pt.label || ''}"`
  );
  const csvContent = [header, ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const fileName = `${baseName}_data.csv`;

  triggerDownload(blob, fileName);
  return fileName;
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', fileName);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    if (link.parentNode) {
      link.parentNode.removeChild(link);
    }
    URL.revokeObjectURL(url);
  }, 2000);
}
