import type { AppendEntriesRequest, ReplicaAck, ReplicaHealthRecord, LogEntry } from "@quorum/types";

interface ReplicaStub {
  appendEntries(req: AppendEntriesRequest): Promise<import("@quorum/types").AppendEntriesResponse>;
}

interface ReplicateOptions {
  entries: LogEntry[];
  leaderEpoch: number;
  prevSeq: number;
  prevChecksum: string;
}

interface ReplicationManagerOptions {
  namespaceId: string;
  onAck: (seq: number, ack: ReplicaAck) => void;
  degradeThreshold?: number;
  maxLagSeq?: number;
}

export class ReplicationManager {
  private readonly replicas = new Map<string, ReplicaStub>();
  private readonly health = new Map<string, ReplicaHealthRecord>();

  constructor(private readonly opts: ReplicationManagerOptions) {}

  registerReplica(replicaId: string, stub: ReplicaStub): void {
    throw new Error("not implemented");
  }

  async replicate(opts: ReplicateOptions): Promise<void> {
    throw new Error("not implemented");
  }

  getHealth(replicaId: string): ReplicaHealthRecord | undefined {
    return this.health.get(replicaId);
  }

  getAllHealth(): ReplicaHealthRecord[] {
    return [...this.health.values()];
  }
}
