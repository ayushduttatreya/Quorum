export type FailureEvent =
  | { type: "REPLICA_UNRESPONSIVE"; replicaId: string }
  | { type: "REPLICA_RECOVERED"; replicaId: string }
  | { type: "KERNEL_EVICTION_DETECTED" }
  | { type: "QUORUM_DEGRADED"; reachable: number; required: number };

export class FailureDetector {
  private listeners: ((event: FailureEvent) => void)[] = [];

  onFailure(listener: (event: FailureEvent) => void): void {
    this.listeners.push(listener);
  }

  reportReplicaFailure(replicaId: string, consecutiveFailures: number): void {
    throw new Error("not implemented");
  }

  reportReplicaRecovery(replicaId: string): void {
    throw new Error("not implemented");
  }

  isQuorumReachable(replicaCount: number, activeCount: number): boolean {
    throw new Error("not implemented");
  }

  private emit(event: FailureEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
