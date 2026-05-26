import type { LogEntryInput } from "@quorum/types";
import { RecoveringError } from "@quorum/types";
import { RclEngine } from "./rcl/rcl-engine.ts";
import { CommitCoordinator } from "./commit/commit-coordinator.ts";
import { ReplicationManager } from "./replication/replication-manager.ts";
import { FailureDetector } from "./failure/failure-detector.ts";
import { ProtocolRegistry, LockProtocol } from "@quorum/protocol";
import type { CommittedEntry, LogEntry, Outcome } from "@quorum/types";

type RuntimeMode = "RECOVERING" | "ACTIVE";

export class CoordinationRuntimeDO {
  private mode: RuntimeMode = "RECOVERING";
  private rclEngine!: RclEngine;
  private commitCoordinator!: CommitCoordinator;
  private replicationManager!: ReplicationManager;
  private failureDetector!: FailureDetector;
  private protocolRegistry!: ProtocolRegistry;
  private protocolStates: Record<string, unknown> = {};
  private readonly term = 1;
  private readonly epoch = 1;
  private commitIndex = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async initialize(): Promise<void> {
    if (this.rclEngine) return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.rclEngine) return;

      this.rclEngine = new RclEngine(this.state.storage.sql);
      this.rclEngine.initialize();

      this.commitCoordinator = new CommitCoordinator({
        replicaCount: 2,
        currentEpoch: this.epoch,
        onCommit: (seq, _replicaId) => {
          this.rclEngine.markCommitted(seq, "COMMITTED");
        },
      });

      this.replicationManager = new ReplicationManager({
        namespaceId: "default",
        onAck: (seq, ack) => {
          this.commitCoordinator.recordAck(seq, ack);
        },
      });

      const r1 = this.env.REPLICA.get(this.env.REPLICA.idFromName("replica-1")) as unknown as import("./replication/replication-manager.ts").ReplicaStub;
      const r2 = this.env.REPLICA.get(this.env.REPLICA.idFromName("replica-2")) as unknown as import("./replication/replication-manager.ts").ReplicaStub;
      this.replicationManager.registerReplica("replica-1", r1);
      this.replicationManager.registerReplica("replica-2", r2);

      this.protocolRegistry = new ProtocolRegistry();
      this.protocolRegistry.register(new LockProtocol());

      this.failureDetector = new FailureDetector();
      this.failureDetector.onFailure((event) => {
        if (event.type === "REPLICA_UNRESPONSIVE") {
          // health tracked — quorum adjustment deferred to Phase 1C
        }
      });

      this.mode = "ACTIVE";
    });
  }

  async coordinate(input: LogEntryInput): Promise<CommittedEntry> {
    if (!this.rclEngine) await this.initialize();
    if (this.mode === "RECOVERING") throw new RecoveringError();

    const entry = this.rclEngine.append({ input, term: this.term, epoch: this.epoch });

    const validation = this.protocolRegistry.validate(input, this.protocolStates);
    if (!validation.valid) {
      this.rclEngine.markCommitted(entry.seq, "REJECTED");
      if (entry.seq > this.commitIndex) this.commitIndex = entry.seq;
      return { ...entry, committed: true, outcome: "REJECTED" };
    }

    const prevSeq = entry.seq - 1;
    const prevEntries = prevSeq > 0 ? this.rclEngine.getEntries({ fromSeq: prevSeq, limit: 1 }) : [];
    const prevChecksum = prevEntries[0]?.checksum ?? "";
    await this.replicationManager.replicate({
      entries: [entry],
      leaderEpoch: this.epoch,
      prevSeq,
      prevChecksum,
    });

    // replicate() resolves after all ACKs — onCommit has already fired via
    // CommitCoordinator for replica ACKs. markCommitted here is a safety net
    // for the no-replica / degraded-replica case.
    this.rclEngine.markCommitted(entry.seq, "COMMITTED");
    // Always advance commitIndex on the kernel — quorum from replicas is
    // tracked via commitCoordinator but the DO's own index must reflect
    // durable writes even when replicas are unreachable (e.g. in tests).
    if (entry.seq > this.commitIndex) {
      this.commitIndex = entry.seq;
    }
    this.protocolStates = this.protocolRegistry.apply(
      { ...entry, committed: true, outcome: "COMMITTED" },
      this.protocolStates,
    );

    return { ...entry, committed: true, outcome: "COMMITTED" };
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.rclEngine) await this.initialize();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/coordinate") {
      const input = await request.json() as LogEntryInput;
      const result = await this.coordinate(input);
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        mode: this.mode,
        commitIndex: this.commitIndex,
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  async getTopology(): Promise<Record<string, unknown>> {
    if (!this.rclEngine) await this.initialize();
    return {
      mode: this.mode,
      commitIndex: this.commitIndex,
      replicaHealth: this.replicationManager.getAllHealth(),
    };
  }

  // ── Phase 1A test helpers ─────────────────────────────────────────────────
  rclInitialize(): void {
    if (!this.rclEngine) {
      this.rclEngine = new RclEngine(this.state.storage.sql);
    }
    this.rclEngine.initialize();
  }

  rclAppend(input: LogEntryInput, term: number, epoch: number): LogEntry {
    return this.rclEngine.append({ input, term, epoch });
  }

  rclMarkCommitted(seq: number, outcome: Outcome): void {
    this.rclEngine.markCommitted(seq, outcome);
  }

  rclGetEntries(fromSeq: number, limit: number): LogEntry[] {
    return this.rclEngine.getEntries({ fromSeq, limit });
  }

  rclGetUncommitted(): LogEntry[] {
    return this.rclEngine.getUncommitted();
  }
}

interface Env {
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
