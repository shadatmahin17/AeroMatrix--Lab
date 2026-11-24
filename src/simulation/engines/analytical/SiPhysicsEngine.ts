import type { SimulationContext, SimulationEngine, ValidationResult } from '../../contracts/SimulationMetadata';
import type { SiPhysicsInput } from '../../contracts/SimulationInput';
import type { SiPhysicsOutput } from '../../contracts/SimulationOutput';
import { AIRCRAFT_MODELS } from '../../../utils/airfoilGenerators';
import { ISA_CONSTANTS } from '../../../lib/aeroPhysics';
import { workerClient } from '../../workers/workerClient';

export class SiPhysicsEngine implements SimulationEngine<SiPhysicsInput, SiPhysicsOutput> {
  public readonly id = 'si-physics';
  public readonly version = '2.0.0';

  public validate(input: SiPhysicsInput): ValidationResult {
    const issues: ValidationResult['issues'] = [];
    if (!AIRCRAFT_MODELS[input.modelType]) {
      issues.push({
        code: 'UNKNOWN_MODEL',
        severity: 'error',
        message: `Unknown aircraft model type "${input.modelType}".`,
      });
    }
    const altM = input.altitudeFt * ISA_CONSTANTS.FT_TO_M;
    if (!Number.isFinite(altM) || altM < 0 || altM > ISA_CONSTANTS.MAX_ALTITUDE_M) {
      issues.push({
        code: 'ISA_OUT_OF_RANGE',
        severity: 'error',
        message: `Altitude must be within 0..20,000 m (got ${altM.toFixed(1)} m).`,
      });
    }
    if (!Number.isFinite(input.airspeedKts) || input.airspeedKts < 0) {
      issues.push({
        code: 'INVALID_AIRSPEED',
        severity: 'error',
        message: 'Airspeed must be finite and >= 0 kts.',
      });
    }
    if (!Number.isFinite(input.angleOfAttackDeg)) {
      issues.push({
        code: 'INVALID_AOA',
        severity: 'error',
        message: 'Angle of attack must be finite.',
      });
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }

  public async run(input: SiPhysicsInput, context: SimulationContext): Promise<SiPhysicsOutput> {
    return workerClient.execute<SiPhysicsOutput>(
      'physics',
      { type: 'RUN_PHYSICS', runId: context.runId, input },
      { signal: context.signal, onProgress: context.onProgress }
    );
  }

  public cancel(runId: string): void {
    workerClient.cancel(runId, 'physics');
  }
}
