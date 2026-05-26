import type { LogEntryInput } from "@quorum/types";
import { RecoveringError } from "@quorum/types";
import { RclEngine } from "./rcl/rcl-engine.ts";
import { CommitCoordinator } from "./commit/commit-coordinator.ts";
import { ReplicationManager } from "./replication/replication-manager.ts";
import { FailureDetector } from "./failure/failure-detector.ts";
import { ProtocolRegistry, LockProtocol } from "@quorum/protocol";
import { ReplayEngine } from "./replay/replay-engine.ts";
import { SnapshotManager } from "./snapshot/snapshot-manager.ts";
import type { CommittedEntry, LogEntry, Outcome, Snapshot, SnapshotMetadata } from "@quorum/types";
import type { ReplicaStub } from "./replication/replication-manager.ts";
import type { ReplayOptions, ReplayResult } from "./replay/replay-engine.ts";

type RuntimeMode = "RECOVERING" | "ACTIVE";

export class CoordinationRuntimeDO {
  private mode: RuntimeMode = "RECOVERING";
  private rclEngine!: RclEngine;
  private commitCoordinator!: CommitCoordinator;
  private replicationManager!: ReplicationManager;
  private failureDetector!: FailureDetector;
  private protocolRegistry!: ProtocolRegistry;
  private replayEngine!: ReplayEngine;
  private snapshotManager!: SnapshotManager;
  private protocolStates: Record<string, unknown> = {};
  private readonly term = 1;
  private readonly epoch = 1;
  private commitIndex = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async initialize(): Promise<void> {
    if (this.mode === "ACTIVE") return;
    await this.state.blockConcurrencyWhile(async () => {
      if (this.mode === "ACTIVE") return;

      // 1. Bootstrap subsystems
      if (!this.rclEngine) {
        this.rclEngine = new RclEngine(this.state.storage.sql);
        this.rclEngine.initialize();
      }

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

      const r1 = this.env.REPLICA.get(this.env.REPLICA.idFromName("replica-1")) as unknown as ReplicaStub;
      const r2 = this.env.REPLICA.get(this.env.REPLICA.idFromName("replica-2")) as unknown as ReplicaStub;
      this.replicationManager.registerReplica("replica-1", r1);
      this.replicationManager.registerReplica("replica-2", r2);

      this.protocolRegistry = new ProtocolRegistry();
      this.protocolRegistry.register(new LockProtocol());

      this.failureDetector = new FailureDetector();
      this.failureDetector.onFailure((event) => {
        if (event.type === "REPLICA_UNRESPONSIVE") {
          // health tracked — quorum adjustment deferred to Phase 1C-ii
        }
      });

      // 2. Wire recovery subsystems
      this.replayEngine = new ReplayEngine(this.rclEngine, this.protocolRegistry);
      this.snapshotManager = new SnapshotManager({
        namespaceId: "default",
        r2Bucket: this.env.QUORUM_STORAGE,
        threshold: 50_000,
        rclEngine: this.rclEngine,
        replicationManager: this.replicationManager,
      });

      // 3. Load latest snapshot (if any)
      const snapshot = await this.snapshotManager.loadLatestSnapshot();
      let replayFromSeq: number;
      if (snapshot) {
        this.protocolStates = this.protocolRegistry.restoreAllSnapshots(
          snapshot.slices,
          snapshot.protocolVersions,
        );
        replayFromSeq = snapshot.seq + 1;
        this.commitIndex = snapshot.seq;
      } else {
        this.protocolStates = {};
        replayFromSeq = 0;
      }

      // 4. Replay delta from snapshot to HEAD
      const replayResult = this.replayEngine.replay({
        fromSeq: replayFromSeq,
        initialState: this.protocolStates,
      });
      this.protocolStates = replayResult.materializedState;
      // Advance commitIndex to the true latest committed seq — replay only
      // advances it for entries with registered executors, but SYSTEM entries
      // (SNAPSHOT_COMPLETE, ENTRY_ROLLBACK) are also committed and count.
      const latestCommittedSeq = this.rclEngine.getLatestCommittedSeq();
      if (latestCommittedSeq > this.commitIndex) {
        this.commitIndex = latestCommittedSeq;
      }

      // 5. Handle uncommitted entries
      const uncommitted = this.rclEngine.getUncommitted();
      for (const entry of uncommitted) {
        if (entry.epoch < this.epoch) {
          // Stale epoch — record and discard
          const rb = this.rclEngine.append({
            input: {
              protocol: "SYSTEM",
              protocolVersion: 1,
              operation: "ENTRY_STALE_EPOCH_DISCARDED",
              resourceKey: "system",
              payload: {
                staleTerm: entry.term,
                currentTerm: this.term,
                discardedSeq: entry.seq,
              },
              idempotencyKey: `stale-discard-${entry.seq}`,
              traceId: "recovery",
              clientId: "kernel",
            },
            term: this.term,
            epoch: this.epoch,
          });
          this.rclEngine.markCommitted(entry.seq, "REJECTED");
          this.rclEngine.markCommitted(rb.seq, "COMMITTED");
          if (rb.seq > this.commitIndex) this.commitIndex = rb.seq;
        } else {
          // Valid epoch — attempt re-replication
          const prevEntries =
            entry.seq > 1
              ? this.rclEngine.getEntries({ fromSeq: entry.seq - 1, limit: 1 })
              : [];
          const prevChecksum = prevEntries[0]?.checksum ?? "";
          await this.replicationManager.replicate({
            entries: [entry],
            leaderEpoch: this.epoch,
            prevSeq: entry.seq - 1,
            prevChecksum,
          });
          // If quorum was achieved, onCommit already fired — check if still uncommitted
          const stillUncommitted = this.rclEngine
            .getUncommitted()
            .some((e) => e.seq === entry.seq);
          if (stillUncommitted) {
            const rb = this.rclEngine.append({
              input: {
                protocol: "SYSTEM",
                protocolVersion: 1,
                operation: "ENTRY_ROLLBACK",
                resourceKey: "system",
                payload: { rolledBackSeq: entry.seq, reason: "QUORUM_UNAVAILABLE" },
                idempotencyKey: `rollback-${entry.seq}`,
                traceId: "recovery",
                clientId: "kernel",
              },
              term: this.term,
              epoch: this.epoch,
            });
            this.rclEngine.markCommitted(entry.seq, "REJECTED");
            this.rclEngine.markCommitted(rb.seq, "COMMITTED");
            if (rb.seq > this.commitIndex) this.commitIndex = rb.seq;
          }
        }
      }

      // 6. Transition to ACTIVE
      this.mode = "ACTIVE";
    });
  }

  async coordinate(input: LogEntryInput): Promise<CommittedEntry> {
    if (this.mode !== "ACTIVE") await this.initialize();
    if (this.mode === "RECOVERING") throw new RecoveringError();

    const entry = this.rclEngine.append({ input, term: this.term, epoch: this.epoch });

    const validation = this.protocolRegistry.validate(input, this.protocolStates);
    if (!validation.valid) {
      this.rclEngine.markCommitted(entry.seq, "REJECTED");
      if (entry.seq > this.commitIndex) this.commitIndex = entry.seq;
      return { ...entry, committed: true, outcome: "REJECTED" };
    }

    const prevSeq = entry.seq - 1;
    const prevEntries =
      prevSeq > 0 ? this.rclEngine.getEntries({ fromSeq: prevSeq, limit: 1 }) : [];
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

    // Trigger snapshot if threshold reached
    await this.snapshotManager.maybeSnapshot(
      entry.seq,
      this.protocolStates,
      this.protocolRegistry,
      this.term,
      this.epoch,
    );

    return { ...entry, committed: true, outcome: "COMMITTED" };
  }

  async fetch(request: Request): Promise<Response> {
    if (this.mode !== "ACTIVE") await this.initialize();
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
    if (this.mode !== "ACTIVE") await this.initialize();
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

  // ── Phase 1C-i replay test helpers ───────────────────────────────────────
  replayMakeEngine(): ReplayEngine {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());
    return new ReplayEngine(this.rclEngine, registry);
  }

  replayRun(opts: ReplayOptions): ReplayResult {
    return this.replayMakeEngine().replay(opts);
  }

  replayApplyEntry(entry: CommittedEntry, states: Record<string, unknown>): Record<string, unknown> {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());
    return registry.apply(entry, states);
  }

  replayReconstructTimeline(fromSeq: number, toSeq: number): CommittedEntry[] {
    return this.replayMakeEngine().reconstructTimeline(fromSeq, toSeq);
  }

  replayVerifyDeterminism(
    fromSeq: number,
    baseState: Record<string, unknown>,
    expectedState: Record<string, unknown>,
  ): boolean {
    return this.replayMakeEngine().verifyDeterminism(fromSeq, baseState, expectedState);
  }

  // ── Phase 1C-i snapshot test helpers ─────────────────────────────────────
  private snapshotMakeManager(threshold = 50): SnapshotManager {
    const repl = new ReplicationManager({ namespaceId: "test-snap", onAck: () => {} });
    return new SnapshotManager({
      namespaceId: "test",
      r2Bucket: this.env.QUORUM_STORAGE,
      threshold,
      rclEngine: this.rclEngine,
      replicationManager: repl,
    });
  }

  snapshotMakeRegistry(): ProtocolRegistry {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());
    return registry;
  }

  async snapshotTake(
    commitSeq: number,
    protocolStates: Record<string, unknown>,
    term: number,
    epoch: number,
  ): Promise<SnapshotMetadata> {
    const registry = this.snapshotMakeRegistry();
    return this.snapshotMakeManager().takeSnapshot(commitSeq, protocolStates, registry, term, epoch);
  }

  async snapshotMaybe(
    currentSeq: number,
    protocolStates: Record<string, unknown>,
    term: number,
    epoch: number,
    threshold: number,
  ): Promise<boolean> {
    const registry = this.snapshotMakeRegistry();
    return this.snapshotMakeManager(threshold).maybeSnapshot(currentSeq, protocolStates, registry, term, epoch);
  }

  async snapshotLoadLatest(): Promise<Snapshot | null> {
    return this.snapshotMakeManager().loadLatestSnapshot();
  }

  async snapshotVerify(metadata: SnapshotMetadata): Promise<boolean> {
    return this.snapshotMakeManager().verifySnapshot(metadata);
  }

  snapshotApplyEntry(entry: CommittedEntry, states: Record<string, unknown>): Record<string, unknown> {
    return this.snapshotMakeRegistry().apply(entry, states);
  }

  snapshotRestoreAll(slices: Snapshot["slices"], protocolVersions: Record<string, number>): Record<string, unknown> {
    return this.snapshotMakeRegistry().restoreAllSnapshots(slices, protocolVersions);
  }
}

interface Env {
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
