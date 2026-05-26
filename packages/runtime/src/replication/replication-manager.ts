import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  ReplicaAck,
  ReplicaHealthRecord,
  LogEntry,
} from "@quorum/types";

interface ReplicaStub {
  appendEntries(req: AppendEntriesRequest): Promise<AppendEntriesResponse>;
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
  private readonly degradeThreshold: number;

  constructor(private readonly opts: ReplicationManagerOptions) {
    this.degradeThreshold = opts.degradeThreshold ?? 3;
  }

  registerReplica(replicaId: string, stub: ReplicaStub): void {
    this.replicas.set(replicaId, stub);
    this.health.set(replicaId, {
      replicaId,
      lastAckedSeq: 0,
      lastAckedEpoch: 0,
      health: "active",
      consecutiveFailures: 0,
    });
  }

  async replicate(opts: ReplicateOptions): Promise<void> {
    const req: AppendEntriesRequest = {
      entries: opts.entries,
      leaderEpoch: opts.leaderEpoch,
      prevSeq: opts.prevSeq,
      prevChecksum: opts.prevChecksum,
      namespaceId: this.opts.namespaceId,
    };

    const calls = [...this.replicas.entries()].map(async ([replicaId, stub]) => {
      try {
        const res = await stub.appendEntries(req);
        this.handleResponse(replicaId, res);
      } catch {
        this.recordFailure(replicaId);
      }
    });

    await Promise.allSettled(calls);
  }

  getHealth(replicaId: string): ReplicaHealthRecord | undefined {
    return this.health.get(replicaId);
  }

  getAllHealth(): ReplicaHealthRecord[] {
    return [...this.health.values()];
  }

  private handleResponse(replicaId: string, res: AppendEntriesResponse): void {
    const record = this.health.get(replicaId);
    if (!record) return;

    if (res.ok) {
      record.consecutiveFailures = 0;
      record.health = "active";
      record.lastAckedSeq = res.ack.seq;
      record.lastAckedEpoch = res.ack.epoch;
      this.opts.onAck(res.ack.seq, res.ack);
    } else {
      this.recordFailure(replicaId);
    }
  }

  private recordFailure(replicaId: string): void {
    const record = this.health.get(replicaId);
    if (!record) return;
    record.consecutiveFailures += 1;
    if (record.consecutiveFailures >= this.degradeThreshold) {
      record.health = "degraded";
    }
  }
}
