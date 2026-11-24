export type {
  AircraftModelType,
  AircraftModelConfig,
  SimulationParams,
  VisualMode,
} from '../../types/aerodynamics';
export {
  AIRCRAFT_MODELS,
  getNominalPresetState,
  setCustom3DGlbConfig,
  setCustom3DAirfoilConfig,
} from '../../utils/airfoilGenerators';
export {
  CANONICAL_COORDINATE_SYSTEM,
  buildAircraftGeometryContract,
  type AircraftGeometry,
  type CoordinateSystemSpec,
} from '../../simulation/contracts/ScientificContracts';
