export interface NamespaceConfig {
  namespaceId: string;
  replicaCount: number;
  snapshotThreshold: number;
  maxReplicaLagSeq: number;
  degradeThreshold: number;
  electionWindowSize: number;
  defaultLockTtlMs: number;
  defaultLeaseTtlMs: number;
  maxWritesPerSecond: number;
}

export type ConsistencyLevel = "eventual" | "sequential" | "linearizable";

export interface NamespaceToken {
  namespaceId: string;
  permissions: ("read" | "write" | "admin")[];
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
