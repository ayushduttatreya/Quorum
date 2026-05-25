import type { ConsistencyLevel } from "@quorum/types";

export interface LockOptions {
  ttl?: number;
  consistency?: ConsistencyLevel;
  retryCount?: number;
  retryDelayMs?: number;
}

export interface LeaseOptions {
  ttl: number;
  autoRenew?: boolean;
}

export interface ElectionOptions {
  candidateId: string;
  onElected?: () => Promise<void>;
  onDeposed?: () => Promise<void>;
}

export interface WorkflowStep {
  (ctx: WorkflowContext): Promise<unknown>;
}

export interface WorkflowContext {
  input: Record<string, unknown>;
  results: Record<string, unknown>;
  attempt: number;
}

export interface WorkflowOptions {
  steps: Record<string, WorkflowStep>;
  parallelism?: Record<string, string[]>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LockHandle {
  fencingToken: bigint;
  expiresAt: number;
  release(): Promise<void>;
}

export interface LeaseHandle {
  epoch: number;
  expiresAt: number;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface ElectionHandle {
  isLeader(): boolean;
  resign(): Promise<void>;
}
