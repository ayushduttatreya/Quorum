export type FailureEvent =
  | { type: "REPLICA_UNRESPONSIVE"; replicaId: string }
  | { type: "REPLICA_RECOVERED"; replicaId: string }
  | { type: "KERNEL_EVICTION_DETECTED" }
  | { type: "QUORUM_DEGRADED"; reachable: number; required: number };

export class FailureDetector {
  private readonly listeners: ((event: FailureEvent) => void)[] = [];
  private readonly degradeThreshold: number;

  constructor(opts: { degradeThreshold?: number } = {}) {
    this.degradeThreshold = opts.degradeThreshold ?? 3;
  }

  onFailure(listener: (event: FailureEvent) => void): void {
    this.listeners.push(listener);
  }

  reportReplicaFailure(replicaId: string, consecutiveFailures: number): void {
    if (consecutiveFailures >= this.degradeThreshold) {
      this.emit({ type: "REPLICA_UNRESPONSIVE", replicaId });
    }
  }

  reportReplicaRecovery(replicaId: string): void {
    this.emit({ type: "REPLICA_RECOVERED", replicaId });
  }

  isQuorumReachable(replicaCount: number, activeCount: number): boolean {
    const total = replicaCount + 1; // +1 for kernel
    const required = Math.floor(total / 2) + 1;
    return activeCount + 1 >= required; // +1 for kernel itself
  }

  checkAndEmitQuorum(replicaCount: number, activeCount: number): boolean {
    const reachable = this.isQuorumReachable(replicaCount, activeCount);
    if (!reachable) {
      const total = replicaCount + 1;
      const required = Math.floor(total / 2) + 1;
      this.emit({ type: "QUORUM_DEGRADED", reachable: activeCount + 1, required });
    }
    return reachable;
  }

  private emit(event: FailureEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
