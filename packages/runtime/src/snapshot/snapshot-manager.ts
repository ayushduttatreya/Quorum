import type { Snapshot, SnapshotMetadata } from "@quorum/types";

interface SnapshotManagerOptions {
  namespaceId: string;
  r2Bucket: R2Bucket;
  threshold: number;
}

export class SnapshotManager {
  constructor(private readonly opts: SnapshotManagerOptions) {}

  async maybeSnapshot(currentSeq: number): Promise<boolean> {
    throw new Error("not implemented");
  }

  async takeSnapshot(commitSeq: number, state: unknown): Promise<SnapshotMetadata> {
    throw new Error("not implemented");
  }

  async loadLatestSnapshot(): Promise<Snapshot | null> {
    throw new Error("not implemented");
  }

  async verifySnapshot(metadata: SnapshotMetadata): Promise<boolean> {
    throw new Error("not implemented");
  }

  async archiveSegment(startSeq: number, endSeq: number, entries: import("@quorum/types").LogEntry[]): Promise<string> {
    throw new Error("not implemented");
  }

  async listSnapshots(): Promise<SnapshotMetadata[]> {
    throw new Error("not implemented");
  }
}
