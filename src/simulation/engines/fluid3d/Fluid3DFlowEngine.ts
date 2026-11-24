import type { SimulationContext, SimulationEngine, ValidationResult } from '../../contracts/SimulationMetadata';
import type { Fluid3DFlowInput } from '../../contracts/SimulationInput';
import type { Fluid3DFlowOutput } from '../../contracts/SimulationOutput';
import { workerClient } from '../../workers/workerClient';

export class Fluid3DFlowEngine implements SimulationEngine<Fluid3DFlowInput, Fluid3DFlowOutput> {
  public readonly id = 'fluid-3d';
  public readonly version = '2.0.0';

  public validate(input: Fluid3DFlowInput): ValidationResult {
    const issues: ValidationResult['issues'] = [];
    if (!Number.isFinite(input.aoaDeg) || !Number.isFinite(input.airspeedKts)) {
      issues.push({
        code: 'INVALID_FLOW_STATE',
        severity: 'error',
        message: 'Fluid3D requires finite AoA and airspeed.',
      });
    }
    if (input.mach > 0.7) {
      issues.push({
        code: 'VLM_COMPRESSIBILITY_WARNING',
        severity: 'warning',
        message: `Mach ${input.mach.toFixed(2)} > 0.70: 3D reduced-order VLM omits transonic shock-boundary interaction.`,
      });
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }

  public async run(input: Fluid3DFlowInput, context: SimulationContext): Promise<Fluid3DFlowOutput> {
    return workerClient.execute<Fluid3DFlowOutput>(
      'fluid3d',
      { type: 'BUILD_SDF', runId: context.runId, input },
      { signal: context.signal, onProgress: context.onProgress }
    );
  }

  public cancel(runId: string): void {
    workerClient.cancel(runId, 'fluid3d');
  }
}
