import type { ReplicaAck } from "@quorum/types";

interface CommitCoordinatorOptions {
  replicaCount: number;
  onCommit: (seq: number, replicaId: string) => void;
  currentEpoch?: number;
}

export class CommitCoordinator {
  private readonly quorumSize: number;
  private commitIndex = 0;
  private currentEpoch: number;

  constructor(private readonly opts: CommitCoordinatorOptions) {
    const total = opts.replicaCount + 1;
    this.quorumSize = Math.floor(total / 2) + 1;
    this.currentEpoch = opts.currentEpoch ?? 1;
  }

  recordAck(seq: number, ack: ReplicaAck): void {
    throw new Error("not implemented");
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  advanceEpoch(epoch: number): void {
    throw new Error("not implemented");
  }
}
