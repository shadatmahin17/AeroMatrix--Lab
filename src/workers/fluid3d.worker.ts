import type { SimulationRequest } from '../simulation/contracts/SimulationInput';
import type { SimulationResponse } from '../simulation/contracts/SimulationOutput';
import { runFluid3DTask } from './handlers';

const postWorkerMessage = self.postMessage.bind(self) as (
  message: SimulationResponse,
  transfer?: Transferable[]
) => void;

self.onmessage = (event: MessageEvent<SimulationRequest>) => {
  const req = event.data;
  if (!req || (req.type !== 'BUILD_SDF' && req.type !== 'TRACE_STREAMLINES')) return;

  try {
    const { result, transferables } = runFluid3DTask(
      req.input,
      req.type === 'BUILD_SDF',
      (progress, stage) => {
        postWorkerMessage({ type: 'PROGRESS', runId: req.runId, progress, stage });
      }
    );
    const done: SimulationResponse = { type: 'RESULT', runId: req.runId, result };
    if (transferables && transferables.length > 0) {
      postWorkerMessage(done, transferables);
    } else {
      postWorkerMessage(done);
    }
  } catch (err) {
    postWorkerMessage({
      type: 'ERROR',
      runId: req.runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
