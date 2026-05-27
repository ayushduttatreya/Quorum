import type { CommittedEntry } from "@quorum/types";
import type { RclSubscriber } from "./rcl-subscriber.ts";

export interface Metrics {
  lockAcquisitionsTotal: Record<string, number>;
  lockContentionEvents: number;
  replicaHealthChanges: number;
}

export class MetricsMaterializer {
  private readonly counts: Metrics = {
    lockAcquisitionsTotal: {},
    lockContentionEvents: 0,
    replicaHealthChanges: 0,
  };
  private readonly contentionPending = new Set<string>();

  constructor(subscriber: RclSubscriber) {
    subscriber.subscribe((entry) => this.processEntry(entry));
  }

  getMetrics(): Metrics {
    return {
      lockAcquisitionsTotal: { ...this.counts.lockAcquisitionsTotal },
      lockContentionEvents: this.counts.lockContentionEvents,
      replicaHealthChanges: this.counts.replicaHealthChanges,
    };
  }

  private processEntry(entry: CommittedEntry): void {
    if (entry.protocol === "LOCK" && entry.operation === "LOCK_ACQUIRE") {
      const key = entry.outcome;
      this.counts.lockAcquisitionsTotal[key] =
        (this.counts.lockAcquisitionsTotal[key] ?? 0) + 1;

      if (entry.outcome === "REJECTED") {
        this.contentionPending.add(entry.resourceKey);
      } else if (entry.outcome === "COMMITTED" && this.contentionPending.has(entry.resourceKey)) {
        this.contentionPending.delete(entry.resourceKey);
        this.counts.lockContentionEvents += 1;
      }
    }

    if (entry.operation === "REPLICA_HEALTH_CHANGE") {
      this.counts.replicaHealthChanges += 1;
    }
  }
}
