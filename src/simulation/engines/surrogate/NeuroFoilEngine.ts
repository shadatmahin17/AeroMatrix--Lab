import type { SimulationContext, SimulationEngine, ValidationResult } from '../../contracts/SimulationMetadata';
import type { NeuroFoilSurrogateInput } from '../../contracts/SimulationInput';
import type { NeuroFoilSurrogateOutput } from '../../contracts/SimulationOutput';
import { validateAirfoilCoords2D } from '../../../geometry/validation/meshValidator';
import { runNeuroFoilPrediction } from '../../../lib/neurofoil';

export class NeuroFoilEngine implements SimulationEngine<NeuroFoilSurrogateInput, NeuroFoilSurrogateOutput> {
  public readonly id = 'neurofoil';
  public readonly version = '1.2.0';
  private cancelledRuns = new Set<string>();

  public validate(input: NeuroFoilSurrogateInput): ValidationResult {
    const issues: ValidationResult['issues'] = [];
    const coordCheck = validateAirfoilCoords2D(input.coords);
    if (!coordCheck.valid) {
      issues.push({
        code: 'INVALID_AIRFOIL_COORDS',
        severity: 'error',
        message: coordCheck.issues.join(' '),
      });
    }
    if (!Number.isFinite(input.reynolds) || input.reynolds <= 0) {
      issues.push({
        code: 'INVALID_REYNOLDS',
        severity: 'error',
        message: 'Reynolds number must be > 0.',
      });
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }

  public async run(
    input: NeuroFoilSurrogateInput,
    context: SimulationContext
  ): Promise<NeuroFoilSurrogateOutput> {
    if (this.cancelledRuns.has(context.runId) || context.signal?.aborted) {
      throw new Error(`Surrogate run "${context.runId}" cancelled.`);
    }
    context.onProgress?.(0.35, 'Extracting Bezier airfoil geometric features');
    const prediction = runNeuroFoilPrediction(input.airfoilName, input.coords, input.reynolds);
    context.onProgress?.(1.0, 'Surrogate polar ready');
    return { prediction, valid: prediction.polar.length > 0 };
  }

  public cancel(runId: string): void {
    this.cancelledRuns.add(runId);
  }
}
