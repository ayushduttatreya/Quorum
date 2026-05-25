import type { CommittedEntry, LogEntryInput, SnapshotSlice } from "@quorum/types";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  outcome: import("@quorum/types").Outcome;
}

export interface ProtocolExecutor<S = unknown> {
  readonly protocol: string;
  readonly version: number;
  validate(input: LogEntryInput, state: S): ValidationResult;
  apply(entry: CommittedEntry, state: S): S;
  serializeSnapshot(state: S): SnapshotSlice;
  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): S;
  initialState(): S;
}
