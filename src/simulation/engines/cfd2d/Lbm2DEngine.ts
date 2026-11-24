import type { SimulationContext, SimulationEngine, ValidationResult } from '../../contracts/SimulationMetadata';
import type { Lbm2DInput } from '../../contracts/SimulationInput';
import type { LbmDiagnosticsReport } from '../../contracts/SimulationOutput';
import { validateAirfoilCoords2D } from '../../../geometry/validation/meshValidator';
import { LBM } from '../../../lib/lbm/tunnel2d.js';
import { workerClient } from '../../workers/workerClient';

export class Lbm2DEngine implements SimulationEngine<Lbm2DInput, LbmDiagnosticsReport> {
  public readonly id = 'lbm-2d';
  public readonly version = '2.0.0';

  public validate(input: Lbm2DInput): ValidationResult {
    const issues: ValidationResult['issues'] = [];
    const coordCheck = validateAirfoilCoords2D(input.coords);
    if (!coordCheck.valid) {
      issues.push({
        code: 'INVALID_AIRFOIL_COORDS',
        severity: 'error',
        message: coordCheck.issues.join(' '),
      });
    }
    if (!Number.isFinite(input.u0) || input.u0 <= 0) {
      issues.push({
        code: 'INVALID_LBM_VELOCITY',
        severity: 'error',
        message: 'Lattice inflow speed u0 must be positive.',
      });
    }
    const ma = input.u0 * Math.sqrt(3);
    if (ma >= 0.3) {
      issues.push({
        code: 'LBM_MACH_LIMIT',
        severity: 'warning',
        message: `LBM Mach Ma = ${ma.toFixed(3)} >= 0.30 compresses beyond incompressible limit.`,
      });
    }
    const tau0 = input.tau0 ?? LBM.TAU0;
    if (tau0 <= 0.505) {
      issues.push({
        code: 'LBM_BGK_STABILITY',
        severity: 'warning',
        message: `Relaxation tau0 = ${tau0.toFixed(4)} <= 0.505 risks BGK instability.`,
      });
    }
    return { valid: issues.every((i) => i.severity !== 'error'), issues };
  }

  public async run(input: Lbm2DInput, context: SimulationContext): Promise<LbmDiagnosticsReport> {
    return workerClient.execute<LbmDiagnosticsReport>(
      'tunnel2d',
      { type: 'RUN_LBM_DIAGNOSTICS', runId: context.runId, input },
      { signal: context.signal, onProgress: context.onProgress }
    );
  }

  public cancel(runId: string): void {
    workerClient.cancel(runId, 'tunnel2d');
  }
}
