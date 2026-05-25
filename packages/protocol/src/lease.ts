import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";

export interface LeaseState {
  leases: Record<string, {
    holder: string;
    epoch: number;
    expiresAt: number;
    acquiredSeq: number;
  }>;
}

export class LeaseProtocol implements ProtocolExecutor<LeaseState> {
  readonly protocol = "LEASE";
  readonly version = 1;

  initialState(): LeaseState {
    return { leases: {} };
  }

  validate(input: LogEntryInput, state: LeaseState): ValidationResult {
    throw new Error("not implemented");
  }

  apply(entry: CommittedEntry, state: LeaseState): LeaseState {
    throw new Error("not implemented");
  }

  serializeSnapshot(state: LeaseState): SnapshotSlice {
    throw new Error("not implemented");
  }

  restoreSnapshot(slice: SnapshotSlice, _fromVersion: number): LeaseState {
    throw new Error("not implemented");
  }

  static computeRenewInterval(ttlMs: number, namespaceId: string, leaseId: string, epoch: number): number {
    throw new Error("not implemented");
  }
}
