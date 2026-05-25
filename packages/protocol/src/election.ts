import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";

export interface ElectionState {
  currentLeader: string | null;
  currentTerm: number;
  leaderLeaseExpiry: number;
  electionWindow: { baseSeq: number; windowSize: number } | null;
  nominations: Array<{ candidateId: string; seq: number; term: number }>;
}

export class ElectionProtocol implements ProtocolExecutor<ElectionState> {
  readonly protocol = "ELECTION";
  readonly version = 1;

  initialState(): ElectionState {
    return {
      currentLeader: null,
      currentTerm: 0,
      leaderLeaseExpiry: 0,
      electionWindow: null,
      nominations: [],
    };
  }

  validate(input: LogEntryInput, state: ElectionState): ValidationResult {
    throw new Error("not implemented");
  }

  apply(entry: CommittedEntry, state: ElectionState): ElectionState {
    throw new Error("not implemented");
  }

  serializeSnapshot(state: ElectionState): SnapshotSlice {
    throw new Error("not implemented");
  }

  restoreSnapshot(slice: SnapshotSlice, _fromVersion: number): ElectionState {
    throw new Error("not implemented");
  }

  static selectWinner(nominations: ElectionState["nominations"]): string | null {
    throw new Error("not implemented");
  }
}
