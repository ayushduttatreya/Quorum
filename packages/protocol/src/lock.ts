import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";

export interface LockState {
  locks: Record<string, {
    holder: string;
    fencingToken: bigint;
    expiresAt: number;
    acquiredSeq: number;
  }>;
}

export class LockProtocol implements ProtocolExecutor<LockState> {
  readonly protocol = "LOCK";
  readonly version = 1;

  initialState(): LockState {
    return { locks: {} };
  }

  validate(input: LogEntryInput, state: LockState): ValidationResult {
    throw new Error("not implemented");
  }

  apply(entry: CommittedEntry, state: LockState): LockState {
    throw new Error("not implemented");
  }

  serializeSnapshot(state: LockState): SnapshotSlice {
    throw new Error("not implemented");
  }

  restoreSnapshot(slice: SnapshotSlice, _fromVersion: number): LockState {
    throw new Error("not implemented");
  }
}
