export interface ActiveRunHandle {
  runId: string;
  engineId: string;
  controller: AbortController;
  startedAtMs: number;
}

export class SimulationScheduler {
  private activeRuns = new Map<string, ActiveRunHandle>();
  private latestRunByEngine = new Map<string, string>();
  private sequence = 0;

  public nextRunId(engineId: string): string {
    this.sequence += 1;
    return `${engineId}-${Date.now().toString(36)}-${this.sequence}`;
  }

  public startRun(
    engineId: string,
    options?: { supersedePreviousForEngine?: boolean; customRunId?: string }
  ): ActiveRunHandle {
    if (options?.supersedePreviousForEngine) {
      const prevRunId = this.latestRunByEngine.get(engineId);
      if (prevRunId) {
        this.cancelRun(prevRunId);
      }
    }

    const runId = options?.customRunId ?? this.nextRunId(engineId);
    const controller = new AbortController();
    const handle: ActiveRunHandle = {
      runId,
      engineId,
      controller,
      startedAtMs: Date.now(),
    };

    this.activeRuns.set(runId, handle);
    this.latestRunByEngine.set(engineId, runId);
    return handle;
  }

  public finishRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  public cancelRun(runId: string): boolean {
    const handle = this.activeRuns.get(runId);
    if (!handle) return false;
    handle.controller.abort();
    this.activeRuns.delete(runId);
    return true;
  }

  public getActiveRuns(): ActiveRunHandle[] {
    return Array.from(this.activeRuns.values());
  }
}
