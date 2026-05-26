import type { ReplicaAck } from "@quorum/types";

interface CommitCoordinatorOptions {
  replicaCount: number;
  onCommit: (seq: number, replicaId: string) => void;
  currentEpoch?: number;
}

export class CommitCoordinator {
  // kernel always counts as 1 — quorum = floor((replicaCount+1)/2)+1
  private readonly quorumSize: number;
  private readonly acks = new Map<number, Set<string>>();
  private readonly committed = new Set<number>();
  private commitIndex = 0;
  private currentEpoch: number;

  constructor(private readonly opts: CommitCoordinatorOptions) {
    const total = opts.replicaCount + 1; // +1 for kernel
    this.quorumSize = Math.floor(total / 2) + 1;
    this.currentEpoch = opts.currentEpoch ?? 1;
  }

  recordAck(seq: number, ack: ReplicaAck): void {
    if (ack.epoch < this.currentEpoch) return; // stale epoch — discard

    if (!this.acks.has(seq)) {
      this.acks.set(seq, new Set(["__kernel__"])); // kernel implicit ACK
    }
    this.acks.get(seq)!.add(ack.replicaId);

    const ackCount = this.acks.get(seq)!.size;
    if (ackCount >= this.quorumSize && !this.committed.has(seq)) {
      this.committed.add(seq);
      if (seq > this.commitIndex) {
        this.commitIndex = seq;
      }
      this.acks.delete(seq);
      this.opts.onCommit(seq, ack.replicaId);
    }
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  advanceEpoch(epoch: number): void {
    if (epoch > this.currentEpoch) {
      this.currentEpoch = epoch;
    }
  }
}
