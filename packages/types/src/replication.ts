import type { LogEntry } from "./log-entry.ts";

export interface AppendEntriesRequest {
  entries: LogEntry[];
  leaderEpoch: number;
  prevSeq: number;
  prevChecksum: string;
  namespaceId: string;
}

export interface ReplicaAck {
  seq: number;
  epoch: number;
  checksum: string;
  snapshotBase: number;
  replicaId: string;
}

export type AppendEntriesResponse =
  | { ok: true; ack: ReplicaAck }
  | { ok: false; reason: "GAP_DETECTED"; lastKnownSeq: number }
  | { ok: false; reason: "STALE_EPOCH"; replicaEpoch: number }
  | { ok: false; reason: "CHECKSUM_MISMATCH"; expectedChecksum: string };

export interface ReplicaHealthRecord {
  replicaId: string;
  lastAckedSeq: number;
  lastAckedEpoch: number;
  health: "active" | "degraded" | "snapshot_recovery";
  consecutiveFailures: number;
}
