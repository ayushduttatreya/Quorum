export type Protocol = "LOCK" | "LEASE" | "ELECTION" | "WORKFLOW" | "SYSTEM";

export type Operation =
  | "LOCK_ACQUIRE"
  | "LOCK_RELEASE"
  | "LOCK_EXPIRE"
  | "LEASE_ACQUIRE"
  | "LEASE_RENEW"
  | "LEASE_RELEASE"
  | "LEASE_EXPIRE"
  | "ELECTION_OPEN"
  | "ELECTION_CLOSE"
  | "LEADER_ESTABLISHED"
  | "LEADER_EXPIRED"
  | "CLUSTER_INITIALIZED"
  | "SNAPSHOT_COMPLETE"
  | "SNAPSHOT_ADOPTED"
  | "REPLICA_HEALTH_CHANGE"
  | "REPLICA_DECOMMISSION"
  | "ENTRY_ROLLBACK"
  | "ENTRY_STALE_EPOCH_DISCARDED"
  | "WORKFLOW_STARTED"
  | "STEP_SCHEDULED"
  | "STEP_EXECUTING"
  | "STEP_COMPLETE"
  | "STEP_EFFECT_RECORDED"
  | "STEP_RETRY"
  | "STEP_COMPENSATE"
  | "WORKFLOW_COMPLETE"
  | "WORKFLOW_FAILED";

export type Outcome = "COMMITTED" | "REJECTED";

export interface LogEntryInput {
  protocol: Protocol;
  protocolVersion: number;
  operation: Operation;
  resourceKey: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  traceId: string;
  clientId: string;
}

export interface LogEntry extends LogEntryInput {
  seq: number;
  term: number;
  epoch: number;
  wallClockTs: number;
  checksum: string;
  committed: boolean;
}

export interface CommittedEntry extends LogEntry {
  committed: true;
  outcome: Outcome;
  fencingToken?: bigint;
}
