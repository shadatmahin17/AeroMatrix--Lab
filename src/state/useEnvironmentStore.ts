import { create } from 'zustand';
import { getNominalPresetState } from '../utils/airfoilGenerators';
import { ISA_CONSTANTS } from '../lib/aeroPhysics';
import { deriveFlowConditions, type FlowConditions } from '../simulation/contracts/ScientificContracts';

interface EnvironmentStoreState {
  angleOfAttackDeg: number;
  airspeedKts: number;
  altitudeFt: number;
  flapsDeg: number;
  flowConditions: FlowConditions;
  setFlightInputs: (patch: {
    angleOfAttackDeg?: number;
    airspeedKts?: number;
    altitudeFt?: number;
    flapsDeg?: number;
    chord_m?: number;
  }) => void;
}

const initialNominal = getNominalPresetState('f22');

export const useEnvironmentStore = create<EnvironmentStoreState>((set, get) => ({
  angleOfAttackDeg: initialNominal.angle_of_attack,
  airspeedKts: initialNominal.airspeed_kts,
  altitudeFt: initialNominal.altitude_ft,
  flapsDeg: initialNominal.flaps_deg,
  flowConditions: deriveFlowConditions({
    altitude_m: initialNominal.altitude_ft * ISA_CONSTANTS.FT_TO_M,
    velocity_ms: initialNominal.airspeed_kts * ISA_CONSTANTS.KTS_TO_MS,
    chord_m: 5.2,
    angleOfAttackDeg: initialNominal.angle_of_attack,
    flapsDeg: initialNominal.flaps_deg,
  }),
  setFlightInputs: (patch) => {
    const cur = get();
    const angleOfAttackDeg = patch.angleOfAttackDeg ?? cur.angleOfAttackDeg;
    const airspeedKts = patch.airspeedKts ?? cur.airspeedKts;
    const altitudeFt = patch.altitudeFt ?? cur.altitudeFt;
    const flapsDeg = patch.flapsDeg ?? cur.flapsDeg;
    const chord_m = patch.chord_m ?? cur.flowConditions.chord;
    set({
      angleOfAttackDeg,
      airspeedKts,
      altitudeFt,
      flapsDeg,
      flowConditions: deriveFlowConditions({
        altitude_m: altitudeFt * ISA_CONSTANTS.FT_TO_M,
        velocity_ms: airspeedKts * ISA_CONSTANTS.KTS_TO_MS,
        chord_m,
        angleOfAttackDeg,
        flapsDeg,
      }),
    });
  },
}));
