import type { LogEntryInput, ConsistencyLevel } from "@quorum/types";
import { RecoveringError } from "@quorum/types";
import { RclEngine } from "./rcl/rcl-engine.ts";
import { CommitCoordinator } from "./commit/commit-coordinator.ts";
import { ReplicationManager } from "./replication/replication-manager.ts";
import { SnapshotManager } from "./snapshot/snapshot-manager.ts";
import { ReplayEngine } from "./replay/replay-engine.ts";
import { FailureDetector } from "./failure/failure-detector.ts";
import { ProtocolRegistry } from "@quorum/protocol";

type RuntimeMode = "RECOVERING" | "ACTIVE";

export class CoordinationRuntimeDO {
  private mode: RuntimeMode = "RECOVERING";
  private rclEngine!: RclEngine;
  private commitCoordinator!: CommitCoordinator;
  private replicationManager!: ReplicationManager;
  private snapshotManager!: SnapshotManager;
  private replayEngine!: ReplayEngine;
  private failureDetector!: FailureDetector;
  private protocolRegistry!: ProtocolRegistry;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async initialize(): Promise<void> {
    throw new Error("not implemented");
  }

  async fetch(request: Request): Promise<Response> {
    throw new Error("not implemented");
  }

  async coordinate(input: LogEntryInput): Promise<import("@quorum/types").CommittedEntry> {
    if (this.mode === "RECOVERING") throw new RecoveringError();
    throw new Error("not implemented");
  }

  async getTopology(): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  private async recover(): Promise<void> {
    throw new Error("not implemented");
  }
}

interface Env {
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
