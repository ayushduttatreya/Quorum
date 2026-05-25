import type { CommittedEntry } from "@quorum/types";

export interface MetricSnapshot {
  lastProcessedSeq: number;
  counters: Record<string, number>;
  histograms: Record<string, number[]>;
}

export class MetricsMaterializer {
  private lastProcessedSeq = 0;

  processEntry(entry: CommittedEntry): void {
    throw new Error("not implemented");
  }

  checkpoint(): MetricSnapshot {
    throw new Error("not implemented");
  }

  restoreFromCheckpoint(snapshot: MetricSnapshot): void {
    throw new Error("not implemented");
  }

  getCounter(name: string, labels?: Record<string, string>): number {
    throw new Error("not implemented");
  }

  getHistogramPercentile(name: string, p: number): number {
    throw new Error("not implemented");
  }
}
