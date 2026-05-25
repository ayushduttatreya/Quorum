import type { LogEntry, CommittedEntry } from "@quorum/types";

interface ReplayOptions {
  fromSeq: number;
  toSeq?: number;
  dryRun?: boolean;
  namespaceId: string;
}

interface ReplayResult {
  entriesReplayed: number;
  finalSeq: number;
  materializedState: Record<string, unknown>;
  diverged: boolean;
}

export class ReplayEngine {
  async replay(opts: ReplayOptions): Promise<ReplayResult> {
    throw new Error("not implemented");
  }

  async verifyDeterminism(namespaceId: string, fromSeq: number): Promise<boolean> {
    throw new Error("not implemented");
  }

  async reconstructTimeline(
    namespaceId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<CommittedEntry[]> {
    throw new Error("not implemented");
  }
}
