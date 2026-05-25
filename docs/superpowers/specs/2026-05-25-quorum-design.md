# QUORUM — System Design Specification

**Version:** 0.1.0  
**Date:** 2026-05-25  
**Status:** Design Complete — Pre-Implementation  
**Positioning:** Replay-native coordination runtime for edge-distributed systems.

---

## Table of Contents

1. [Core Identity & Invariant](#1-core-identity--invariant)
2. [Deployment Model](#2-deployment-model)
3. [Component Architecture](#3-component-architecture)
4. [Write Path & Commit Pipeline](#4-write-path--commit-pipeline)
5. [Consistency Model & Read Path](#5-consistency-model--read-path)
6. [Protocol Layer](#6-protocol-layer)
   - 6.1 Distributed Lock
   - 6.2 Lease
   - 6.3 Leader Election
   - 6.4 QUORUM Flow (Replayable Workflows)
7. [Replication Mechanics](#7-replication-mechanics)
8. [Snapshot Architecture](#8-snapshot-architecture)
9. [Recovery Semantics](#9-recovery-semantics)
10. [Observability & Tracing](#10-observability--tracing)
11. [CLI & Self-Deploy Story](#11-cli--self-deploy-story)
12. [Chaos Engineering](#12-chaos-engineering)
13. [Benchmarking Strategy](#13-benchmarking-strategy)
14. [Known Constraints & Honest Tradeoffs](#14-known-constraints--honest-tradeoffs)
15. [Correctness Properties](#15-correctness-properties)
16. [Security & Multi-Tenancy](#16-security--multi-tenancy)
17. [Cost Characteristics](#17-cost-characteristics)
18. [Federation Roadmap](#18-federation-roadmap)
19. [Scope Boundaries](#19-scope-boundaries)

---

## 1. Core Identity & Invariant

### What QUORUM Is

QUORUM is a **self-deploying edge-native coordination runtime** built on Cloudflare Workers and Durable Objects. It provides distributed coordination primitives — locks, leases, leader election, replicated state — as infrastructure that provisions itself into your Cloudflare account and is consumed via direct Durable Object RPC from your Workers.

QUORUM is not a workflow engine. It is the substrate that makes deterministic distributed coordination possible on serverless edge infrastructure. QUORUM Flow (replayable workflows) is a protocol layer built on top — not the core product.

### The Canonical Invariant

> **The Replicated Coordination Log (RCL) is the authoritative causal timeline. Every observable state in QUORUM is a deterministic function of the RCL. There is no other source of truth.**

Consequences of this invariant:

- A lock "held" means an unmatched `LOCK_ACQUIRE` entry exists in the RCL with no subsequent `LOCK_RELEASE` or `LOCK_EXPIRE`.
- A leader "elected" means the last `LEADER_ESTABLISHED` entry in the RCL names that node.
- A workflow "in-flight" means its execution history is a contiguous subsequence of RCL entries.
- Recovery from any failure means replaying the RCL from last valid snapshot to HEAD.
- Observability is a materialized view over the RCL — not separately instrumented.

This invariant eliminates dual-truth systems. Metrics, traces, replay, debugging, and recovery all derive from one causal spine. They cannot diverge.

### Positioning

QUORUM is not "Raft on Workers." That framing misses the actual innovation. Traditional Raft was designed for long-lived processes on known machines competing for leadership. Durable Objects change every assumption: globally unique singletons, event-driven execution, durable state, deterministic serialization, no process affinity.

QUORUM exploits those guarantees rather than fighting them. The DO's single-writer serialization *is* the consensus. The DO's eviction *is* the crash model. The RCL's append-only semantics *is* the WAL. The innovation is **replay-native coordination semantics adapted for serverless edge infrastructure** — not a protocol port.

---

## 2. Deployment Model

### Self-Deploying SDK (Hybrid Model)

QUORUM installs as an npm package that provisions its own Durable Object topology into the user's Cloudflare account at deploy time. Coordination calls happen over direct DO RPC stubs — zero HTTP network hops, zero serialization overhead beyond the RPC layer.

```bash
npm install @quorum/sdk
npx quorum init      # scaffold wrangler bindings, migrations, namespace config
npx quorum deploy    # provision CoordinationRuntimeDO + ReplicaDOs, initialize RCL
```

Then inside a Worker:

```ts
import { Quorum } from "@quorum/sdk";

const quorum = new Quorum(env);

await quorum.lock("payment-123", async () => {
  // globally coordinated, linearizable execution
});
```

### Why Not a Standalone Service

A centralized HTTP coordination service would reintroduce the latency and single-point failure properties that edge-native architecture exists to avoid. Every `fetch()` hop adds ~5–50ms depending on region. More critically, it removes the architectural advantage of co-located DO RPC — the fundamental mechanism that makes sub-millisecond coordination semantics possible on Cloudflare.

### Why Not a Pure SDK

A pure library shifts all infrastructure complexity (wrangler config, bindings, migrations, namespace management, topology upgrades) onto the developer. More importantly, it makes QUORUM a library rather than a runtime — losing the substrate identity that distinguishes it from helper utilities.

The self-deploying model positions QUORUM as **infrastructure that materializes inside your account**, analogous to how Prisma Accelerate, Supabase, or Temporal Cloud provision runtime infrastructure.

---

## 3. Component Architecture

### High-Level Topology

```
┌─────────────────────────────────────────────────────────────┐
│                       QUORUM SDK                            │
│  quorum.lock() / quorum.lease() / quorum.elect()            │
│  quorum.workflow() / quorum.replay() / quorum.subscribe()   │
└────────────────────────────┬────────────────────────────────┘
                             │ Workers RPC (Direct DO stub)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                  CoordinationRuntimeDO                      │
│                                                             │
│  ┌───────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │   RCL Engine  │  │Commit Coordinator│  │ Protocol     │  │
│  │ Append Pipeline│  │ Quorum Tracker  │  │ Registry     │  │
│  │ Seq Allocator │  │ Commit Index    │  │ (Lock/Lease/ │  │
│  │ Log Persistence│  │ ACK Aggregation │  │  Election/   │  │
│  └───────┬───────┘  └────────┬────────┘  │  Workflow)   │  │
│          │                   │           └──────────────┘  │
│  ┌───────▼───────────────────▼──────────────────────────┐  │
│  │              State Machine Runtime                    │  │
│  │  Executes protocol transitions atomically vs SQLite  │  │
│  └───────────────────────────┬──────────────────────────┘  │
│                              │                              │
│  ┌───────────────┐  ┌────────▼────────┐  ┌──────────────┐  │
│  │ Replication   │  │  Replay Engine  │  │ Snapshot Mgr │  │
│  │ Manager       │  │ Deterministic   │  │ Compaction   │  │
│  │               │  │ Replayer        │  │ R2 archival  │  │
│  └───────┬───────┘  └─────────────────┘  └──────┬───────┘  │
│          │                                       │          │
│  ┌───────▼───────┐  ┌─────────────────┐         │          │
│  │ Failure       │  │ Observability   │         │          │
│  │ Detector      │  │ Hooks           │         │          │
│  └───────────────┘  └─────────────────┘         │          │
└──────────┬──────────────────────────────────────┼──────────┘
           │ RPC                                  │ R2 write
    ┌──────┴──────┐                     ┌─────────▼──────────┐
    │  ReplicaDOs │                     │    R2 Storage      │
    │ (x2 or x4)  │                     │  snapshots/        │
    │             │                     │  segments/         │
    │  Deterministic                    │  effects/          │
    │  replication│                     └────────────────────┘
    │  peers      │
    └─────────────┘
```

### CoordinationRuntimeDO

The authoritative coordination engine. Owns the RCL, sequences all operations, executes state machine transitions atomically against SQLite, manages the commit pipeline, drives replication, triggers snapshots, and serves the SDK.

Internal subsystems:

| Subsystem | Responsibility |
|---|---|
| RCL Engine | Append pipeline, sequence allocation, log persistence in SQLite |
| Commit Coordinator | Quorum tracking, commit index advancement, ACK aggregation |
| Protocol Registry | Routes log entries to protocol executors (Lock, Lease, Election, Workflow) |
| State Machine Runtime | Executes protocol transitions atomically against SQLite materialized state |
| Replay Engine | Deterministic replayer, timeline reconstruction, snapshot-based recovery |
| Replication Manager | Fan-out RPC to ReplicaDOs, health tracking, gap-fill |
| Snapshot Manager | Compaction triggers, R2 archival, stabilization windows |
| Failure Detector | Replica health monitoring, eviction detection, RECOVERING mode |
| Observability Hooks | Emits committed entries to metrics/tracing subscribers (never on commit path) |

**Runtime modes:** `RECOVERING` (rejects writes, bounded reads only) → `ACTIVE` (normal operation).

### ReplicaDOs

Deterministic replication peers. Not passive mirrors — they validate sequence continuity, maintain snapshot lineage, participate in recovery reconstruction, and serve read-replica queries.

Responsibilities:
- Validate `prevSeq` and `prevChecksum` on incoming replication RPCs (lineage verification)
- Persist committed entries with sequence integrity
- Acknowledge replication with `{ seq, epoch, checksum, snapshotBase, replicaId }`
- Respond to `SNAPSHOT_RECOVERY` instruction from kernel when lag exceeds `maxReplicaLagSeq`
- Expose replay cursors for observability subscribers
- Serve eventual/sequential consistency reads

### Protocol Registry

Protocols (Lock, Lease, Election, Workflow) are **state machine interpreters registered in the Protocol Registry**, not hardcoded subsystems. Each protocol implements:

```ts
interface ProtocolExecutor<S, O> {
  readonly protocol: string;
  readonly version: number;
  validate(op: O, state: S): ValidationResult;
  apply(op: O, state: S, entry: CommittedEntry): S;
  serializeSnapshot(): SnapshotSlice;
  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): S;
}
```

This abstraction enables protocol evolution, custom coordination primitives, and version-safe replay.

---

## 4. Write Path & Commit Pipeline

### Full Write Path

```
1.  SDK constructs operation with idempotencyKey = client-generated UUID
2.  SDK calls CoordinationRuntimeDO stub via Workers RPC
3.  RCL Engine: Sequence Allocator assigns seq (atomic SQLite insert, UNCOMMITTED)
4.  Protocol Registry: validate operation against current materialized state
    → REJECTED: commit REJECTED outcome entry, return error to SDK
    → ACCEPTED: continue
5.  Replication Manager: fan-out parallel RPC to N ReplicaDOs
    → replicaDO.appendEntries({ entries, leaderEpoch, prevSeq, prevChecksum })
6.  ReplicaDOs: validate lineage, persist, return ACK { seq, epoch, checksum, snapshotBase, replicaId }
7.  Commit Coordinator: await ⌊N/2⌋+1 ACKs (kernel counts as 1)
8.  Commit index advances; entry marked COMMITTED in SQLite
9.  State Machine Runtime: Protocol executor applies transition to materialized state
10. Observability Hooks: emit trace span + metric event (async, never blocks)
11. SDK: receives committed result
```

**Critical ordering:** append → replicate → quorum ACK → commit index advance → mark COMMITTED → apply state machine → emit event. Commit means durability + quorum acceptance. Application is separate.

### Idempotency

Every operation carries a client-generated `idempotencyKey`. The RCL Engine deduplicates on insert — duplicate keys return the original committed result. Retries are safe across DO hibernation and eviction.

### Fencing Tokens

```
fencingToken = (term << 32) | seq
```

Globally monotonic across failover and replica promotion. Downstream systems must reject operations with tokens lower than the last seen. This is the standard fencing pattern (Kleppmann §8) applied natively.

### Log Entry Schema (SQLite)

```sql
CREATE TABLE log_entries (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  term             INTEGER NOT NULL,
  epoch            INTEGER NOT NULL,
  wall_clock_ts    INTEGER NOT NULL,  -- observational metadata only
  protocol         TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  operation        TEXT NOT NULL,
  resource_key     TEXT NOT NULL,
  payload          BLOB NOT NULL,
  checksum         TEXT NOT NULL,
  committed        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_resource_key    ON log_entries(resource_key);
CREATE INDEX idx_protocol        ON log_entries(protocol, operation);
CREATE INDEX idx_committed_seq   ON log_entries(committed, seq);
```

**Logical vs wall time:** `seq` is the authoritative causality ordering. `wall_clock_ts` is observational metadata — replay reconstructs the exact causal structure and protocol progression of the original execution; timing durations reflect committed event timestamps but do not guarantee original runtime latency precision.

---

## 5. Consistency Model & Read Path

### Write Consistency

QUORUM provides **linearizable writes** within a coordination namespace. Single authoritative sequencer + synchronous quorum commit = total ordered committed writes in real time.

### Read Consistency Modes

| Mode | Served From | Guarantee | Latency |
|---|---|---|---|
| `eventual` | Any ReplicaDO | May temporarily observe stale committed entries until replica convergence | Lowest |
| `sequential` | ReplicaDO with minimum commit-seq fence | Monotonically increasing — you never go backward | Low |
| `linearizable` | CoordinationRuntimeDO directly | Read-your-writes; reflects global commit index | Higher |

**Precision:** Once a write ACKs to the SDK, all subsequent linearizable reads are guaranteed to observe it. Sequential reads are guaranteed to observe monotonically increasing committed state. Eventual reads may temporarily observe stale committed state until replica convergence.

### CAP Position

QUORUM is explicitly **CP on the write path**. During a partition where the kernel cannot reach quorum, writes block. This is the correct trade for coordination primitives — a lock service that silently accepts writes during a partition is useless. The `eventual` read mode trades consistency for availability on the read path only, for use cases that can tolerate it.

### Namespace Isolation

**A namespace is the unit of total ordering.** All coordination operations within a namespace are totally ordered by the RCL. Cross-namespace ordering is not guaranteed. This boundary is the shard boundary, consistency boundary, and failure boundary for future federation.

### Cursor-Based Subscriptions

```ts
const stream = await quorum.subscribe({
  namespace: "payments",
  fromSnapshot: "latest",   // load nearest snapshot first
  fromSeq: snapshotSeq,     // then replay delta to HEAD
  protocols: ["LOCK", "ELECTION"],
  consistency: "sequential",
});
// → AsyncIterator<CommittedEntry>
// → transitions to live stream at HEAD after catching up
```

Subscriptions are the read primitive for QUORUM Flow — workflows reconstruct state by replaying committed entries from a known snapshot, not by querying materialized tables. Materialized state is disposable; the log is canonical.

---

## 6. Protocol Layer

### Determinism Contract

Protocol executors are **strictly deterministic**. They must not:
- Call `Date.now()` or `performance.now()` directly
- Use `Math.random()` or any non-deterministic source
- Perform unordered async operations
- Depend on external mutable state during replay

All timestamps originate from committed log metadata (`wall_clock_ts`). All randomness derives from deterministic seeds: `hash(namespace, resourceKey, seq, attempt)`. External side effects are mediated through effect records (see §6.4).

Every `LogEntry` carries `{ protocol, protocolVersion, operation, ... }`. Replay always uses the executor version active at `commitSeq`. The Protocol Registry is immutable-append — upgrades add new versions, old replays use old executors.

### 6.1 Distributed Lock

**State machine:** `UNLOCKED → LOCKED { holder, fencingToken, expiresAt } → UNLOCKED`

**RCL entry types:** `LOCK_ACQUIRE { outcome: COMMITTED | REJECTED }`, `LOCK_RELEASE`, `LOCK_EXPIRE`

**Write flow:**
```
1. SDK: quorum.lock("payment-123", { ttl: 30_000 })
2. Validate against materialized state:
   → LOCKED with non-expired token: commit LOCK_ACQUIRE { outcome: REJECTED, conflictInfo }
   → UNLOCKED: replicate, quorum commit
3. Commit LOCK_ACQUIRE { outcome: COMMITTED, fencingToken: (term<<32)|seq, expiresAt: wallClockTs+ttl }
4. Apply: set lock state to LOCKED
5. SDK: receives { fencingToken, expiresAt }
```

**The RCL never contains partial intent.** Only finalized outcomes are committed. `REJECTED` outcomes are committed entries — they are part of the contention history and audit trail.

**Expiry:** The Lease Manager appends `LOCK_EXPIRE { fencingToken, seq }` when monotonic log time passes `expiresAt`. Expiry is a log entry — replayable, observable, not a timer side effect.

### 6.2 Lease

**State machine:** `AVAILABLE → HELD { holder, epoch, expiresAt } → AVAILABLE`

**Key distinction from Lock:** Leases are renewable and carry an epoch that increments on each renewal, preventing the ABA problem where a slow client renews an expired lease re-acquired by another.

**RCL entry types:** `LEASE_ACQUIRE`, `LEASE_RENEW { mustMatchEpoch }`, `LEASE_RELEASE`, `LEASE_EXPIRE`

**Renewal rule:** `LEASE_RENEW` commits only if `entry.epoch === currentLeaseEpoch`. Post-expiry renewal attempts with stale epoch are committed as `LEASE_RENEW { outcome: REJECTED, reason: EPOCH_MISMATCH }`. Client must re-acquire.

**Heartbeat semantics:**
```
renewInterval = floor(ttl / 3)
deterministicJitter = hash(namespace, leaseId, epoch) % floor(ttl / 10)
effectiveRenewInterval = renewInterval + deterministicJitter
```

Deterministic jitter (not random) avoids synchronized renewal storms during replay.

### 6.3 Leader Election

**State machine:** `CANDIDATE_POOL → ELECTION_OPEN → ELECTION_RESOLVED → LEADER_ESTABLISHED { leader, term, leaseExpiry } → LEADER_EXPIRED`

**Leadership model:** Lease-based, not vote-based. The DO's single-writer guarantee eliminates split-vote within a namespace. The challenge is leader failure detection and deterministic replacement.

**Election window:** Sequence-bounded, not time-bounded.

```
ELECTION_OPEN { baseSeq, windowSize: 64 }   ← committed when Failure Detector fires
  ... nominations arrive ...
ELECTION_CLOSE committed at seq = baseSeq + windowSize
```

This makes elections replay-safe: identical nomination set = identical winner, deterministically.

**Candidate selection:** Sort nominations by `(term, seq, candidateId)` — lowest seq wins (first in total order wins). Pure function of log entries.

**Leadership tenure:** Leader holds a Lease (§6.2). Lease expiry = `LEADER_EXPIRED` entry = new election round opens.

### 6.4 QUORUM Flow (Replayable Workflows)

Workflows are the Protocol Registry's most complex interpreter. A workflow is a **named DAG of steps**, the topology committed at `WORKFLOW_STARTED` time — immutable causal history.

**State machine:** `WORKFLOW_STARTED → STEP_N_SCHEDULED → STEP_N_EXECUTING → STEP_N_COMPLETE → ... → WORKFLOW_COMPLETE | WORKFLOW_FAILED | WORKFLOW_COMPENSATING`

**Core replay gate invariant:**

> A step executes if and only if no `STEP_COMPLETE { workflowId, stepId }` entry exists in the RCL.

This is a pure function of the log — no separate state table needed.

**Step readiness:** `ready(stepId) = allDependencies(stepId).every(dep => STEP_COMPLETE(dep) ∈ RCL)`. Parallel steps (no ordering edge) are scheduled in deterministic order: lexicographic by `stepId` when both become ready at the same seq.

**Side effect isolation:**

```
STEP_EXECUTING committed
→ check: does STEP_EFFECT_RECORDED { effectId, stepId } exist in RCL?
  YES → use recorded result; skip external call
  NO  → execute external call
       → append STEP_EFFECT_RECORDED {
           effectId: sha256(workflowId + stepId + retryCount),
           stepId,
           effectType,
           effectChecksum,
           effectPointer: "r2://effects/{workflowId}/{effectId}",
           status
         }
       → then append STEP_COMPLETE
```

Large result payloads go to R2. The RCL stores coordination metadata only, not arbitrary payloads.

**Deterministic retry backoff:**
```
backoffMs = baseDelay * 2^attempt + deterministicJitter(namespace, workflowId, attempt)
```
Where `deterministicJitter = hash(namespace + workflowId + attempt) % floor(baseDelay * 0.1)`.

**Compensation:** On `WORKFLOW_FAILED`, the runtime walks `STEP_COMPLETE` entries in reverse `seq` order, appending `STEP_COMPENSATE { stepId }` for each. The full compensation history lives in the RCL.

---

## 7. Replication Mechanics

### ReplicaRegistry

`CoordinationRuntimeDO` maintains:
```ts
type ReplicaRecord = {
  replicaId: string;
  doStub: DurableObjectStub;
  lastAckedSeq: number;
  lastAckedEpoch: number;
  health: "active" | "degraded" | "snapshot_recovery";
  consecutiveFailures: number;
};
```

### Replication Flow

```
committed log entry
→ Replication Manager: parallel RPC to all replicas
  replicaDO.appendEntries({ entries, leaderEpoch, prevSeq, prevChecksum })
→ each ReplicaDO validates:
    prevSeq matches tail (gap detection)
    prevChecksum matches (corruption detection)
    leaderEpoch >= lastSeenEpoch (stale leader rejection)
→ ReplicaDO persists entries, returns ACK { seq, epoch, checksum, snapshotBase, replicaId }
→ Commit Coordinator aggregates ACKs
→ once ⌊N/2⌋+1 ACKs: commit index advances
→ lagging replicas receive gap-fill: entries from lastAckedSeq+1
```

### Replica Health & Bounded Staleness

- After `consecutiveFailures` threshold (default 3): replica marked `DEGRADED`. Kernel continues replication attempts but excludes from quorum calculation temporarily.
- `REPLICA_HEALTH_CHANGE { replicaId, from, to }` committed to RCL — operational topology becomes replayable state.
- If `replicaLag > maxReplicaLagSeq` (default 10,000 entries): replica enters `SNAPSHOT_RECOVERY` — abandons replay chain, rehydrates from latest R2 snapshot. Bounded recovery cost enforced.

### Dynamic Quorum

Operator can commit `REPLICA_DECOMMISSION { replicaId }` for permanently unavailable replicas. Quorum recalculates over remaining replicas. Quorum size never drops below 2 (kernel + 1 replica) without explicit `UNSAFE_SINGLE_NODE_MODE` flag — degraded guarantees are explicit, never silent.

---

## 8. Snapshot Architecture

### Trigger

Snapshot Manager triggers when hot SQLite log exceeds `snapshotThreshold` entries (default 50,000). Non-blocking: snapshot process runs while kernel continues serving.

### Snapshot Process

```
1. Read: current commit index N, materialized state
2. Serialize: each ProtocolExecutor.serializeSnapshot() → SnapshotSlice
3. Compose: { seq: N, term, epoch, protocolVersions, slices, checksum }
4. Write to R2: "snapshots/{namespace}/snap_{seq}_{checksum}.bin"
5. Commit: SNAPSHOT_COMPLETE { seq: N, r2Key, checksum, protocolVersions }
   → snapshot itself becomes causal history
6. Stabilization window: await all active replicas ACK SNAPSHOT_ADOPTED { replicaId, seq }
   + configurable retention period
7. Only then: DELETE SQLite entries 0 → N-1
8. Archive: SQLite entries 0 → N serialized to R2 as
   "segments/{namespace}/seg_{startSeq}_{endSeq}.log"
   before deletion
```

**Snapshot stabilization prevents premature compaction.** Compaction only after quorum replica adoption and retention window — never immediately after R2 write.

### Snapshot Contents

Full materialized state of all protocol executors at seq N, composed from per-protocol `SnapshotSlice` objects. Includes `protocolVersions` map — replay after this snapshot uses these executor versions.

### Snapshot Compatibility Validation

On restore:
```
snapshot.protocolVersions checked against runtime executor compatibility matrix
→ COMPATIBLE: proceed
→ INCOMPATIBLE: attempt previous snapshot + segment replay
→ NO COMPATIBLE BASELINE: startup fails with explicit diagnostic error
```

### Snapshot Replay Contract (First-Class Invariant)

```
snapshot(seq=N) + replay(entries N+1 → HEAD) ≡ full replay(0 → HEAD)
```

Snapshot tests must verify this equivalence, not assume it.

---

## 9. Recovery Semantics

### Runtime Mode Transitions

```
DO activation → RECOVERING (rejects writes, bounded reads only)
  → load snapshot, replay delta
  → validate snapshot compatibility
  → verify no quorum violations
→ ACTIVE (normal operation)
```

### Scenario: Normal Hibernation Recovery

```
DO reactivates
→ reads latest SNAPSHOT_COMPLETE from SQLite (or R2 if SQLite empty)
→ loads snapshot from R2, validates checksum and protocolVersions
→ each ProtocolExecutor.restoreSnapshot(slice, version)
→ replays SQLite entries from snapshotSeq+1 → HEAD
→ reconstructs materialized state
→ transitions RECOVERING → ACTIVE
```

### Scenario: UNCOMMITTED Entries on Reactivation

```
scan SQLite for committed = FALSE entries
→ validate epoch against current term
→ epoch valid + replicas reachable: attempt re-replication, advance commit if quorum achieved
→ quorum unachievable: append ENTRY_ROLLBACK { seq, reason }
→ epoch stale: append ENTRY_STALE_EPOCH_DISCARDED { seq, staleTerm, currentTerm }
   → never silently discarded — all recoveries produce observable entries
```

### Scenario: Replica Divergence (Gap Detected)

```
ReplicaDO receives appendEntries where prevSeq > its tail
→ return GAP_DETECTED { lastKnownSeq }
→ kernel sends gap-fill from lastKnownSeq+1
→ if gap spans compacted region: replica fetches latest R2 snapshot,
  enters SNAPSHOT_RECOVERY, rehydrates
```

### Scenario: Snapshot Corruption

```
R2 snapshot checksum fails verification
→ fall back to previous snapshot + segment replay
→ if all snapshots corrupt: full log replay from segments (correct but expensive)
→ SNAPSHOT_CORRUPTION { r2Key, expectedChecksum, actualChecksum } emitted
```

### Recovery Fencing

During `RECOVERING` state: all write RPCs receive `RUNTIME_RECOVERING` error. Clients must retry with backoff. The SDK handles this transparently. Recovery fencing prevents mutation races during replay.

### Memory Pressure Handling

Durable Objects have bounded memory. Replay can balloon unboundedly without constraints:
- Bounded in-memory replay windows: replay iterates in chunks, not loaded entirely
- Streaming snapshot reconstruction: `restoreSnapshot` is a streaming operation
- Chunked replay iterators: `replayEntries(fromSeq, toSeq, chunkSize)`
- Lazy workflow hydration: workflow step graph loaded on demand, not eagerly materialized
- Protocol-owned memory budgeting: each executor declares `maxMemoryHint()`

---

## 10. Observability & Tracing

### Philosophy

**The RCL is the observability primitive.** Observability is a materialized view over the causal timeline — not separately instrumented metrics bolted onto hot paths.

```
RCL (committed entries, async subscription)
   │
   ├── Metrics Materializer → Prometheus/OTEL counters + histograms
   ├── Trace Emitter        → OTEL spans reconstructed from causal chains
   └── Timeline Builder     → replay-native debugging timeline
```

All observability consumers:
- Maintain independent replay cursors
- Never block the commit path
- Are eventually consistent over the RCL
- Recover from checkpoints, not seq 0

**Observability lag does not affect coordination correctness.**

### Distributed Tracing

Each SDK call carries a `traceId` committed as part of the `LogEntry`. The Trace Emitter reconstructs OTEL spans from committed entries:

```
LOCK_ACQUIRE committed (t=logTs+0ms)   → span: "quorum.lock.acquire" start
  replica_1 ACK                        → span event: "replica_ack" { replicaId }
  replica_2 ACK                        → span event: "replica_ack" { replicaId }
  quorum reached                       → span event: "quorum_commit"
  state transition applied             → span end
```

Workflow traces are span trees across all steps, causally linked through `traceId` and `workflowId`.

**Replay-native debugging:** Replaying any historical window produces the exact causal structure and protocol progression of the original execution. Timing durations reflect committed event timestamps — not original runtime latency.

### Metrics

All metrics derived from RCL subscriber. Metrics materializer checkpoints `lastProcessedSeq` and aggregation state — recovers from checkpoint, not seq 0.

```
quorum_lock_acquisitions_total         { namespace, outcome }
quorum_lock_contention_duration_ms     { namespace } — p50/p95/p99
quorum_quorum_commit_latency_ms        { namespace, replicaCount } — p50/p99
quorum_replication_lag_entries         { replicaId, namespace }
quorum_snapshot_compaction_duration_ms { namespace }
quorum_workflow_step_duration_ms       { namespace, stepId }
quorum_election_duration_ms            { namespace }
quorum_uncommitted_rollbacks_total     { namespace, reason }
quorum_replica_health_status           { replicaId, status }
quorum_rcl_entries_total               { namespace }
quorum_recovering_mode_duration_ms     { namespace }
```

### Trace Retention

- Hot traces (last 24h): DO storage
- Summarized historical traces: R2 under `traces/{namespace}/{date}/`
- Full replay-native reconstruction: available for any window within segment retention period
- Compaction-aware: trace archival coordinates with log segment archival

---

## 11. CLI & Self-Deploy Story

### CLI Command Hierarchy

```
quorum dev
  replay    --namespace --from --to [--dry-run]
  benchmark --namespace --ops --scenario
  simulate  --scenario
  determinism-check --namespace --fromSeq

quorum ops
  topology  [--namespace] [--watch]
  snapshot  list|create|verify --namespace
  recover   --namespace
  chaos     --scenario --namespace [--duration]
```

### Key Commands

**`quorum dev replay --dry-run`:** Reconstructs state, verifies determinism, emits no effects. Determinism verification: run workflow → persist RCL → replay from snapshot → reconstruct final state → byte-compare materialized state → fail if divergence.

**`quorum dev determinism-check`:** First-class determinism verification harness. Runs against a namespace, replays from snapshot, verifies `snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)`.

**`quorum ops topology`:**
```
QUORUM TOPOLOGY — namespace: payments
┌─────────────────────────────────────────────────────────┐
│ Kernel   [ACTIVE]   seq: 84,231  term: 3  epoch: 7      │
│ Replica1 [ACTIVE]   lag: 0       last_ack: 84,231       │
│ Replica2 [ACTIVE]   lag: 2       last_ack: 84,229       │
│ Replica3 [DEGRADED] lag: 847     → SNAPSHOT_RECOVERY    │
└─────────────────────────────────────────────────────────┘
Quorum: 2/3 healthy. Writes: NORMAL. Reads: NORMAL.
```

**`quorum init`** generates wrangler.toml bindings, DO migrations, R2 bucket config, typed `env.d.ts`.

**`quorum deploy`** runs migrations, provisions replica topology (3 ReplicaDOs per namespace default), initializes RCL with genesis entry `CLUSTER_INITIALIZED { term: 1, epoch: 1, config }`.

---

## 12. Chaos Engineering

### Philosophy

Chaos in QUORUM is **protocol-level scenario execution**, not random fault injection. Each scenario is a deterministic sequence of RCL events and runtime state manipulations producing a specific failure condition. Scenarios are replayable.

### Scenarios

| Scenario | Injects | Verifies |
|---|---|---|
| `leader-eviction` | Forces DO eviction mid-write (UNCOMMITTED entry exists) | Recovery time, rollback behavior, RECOVERING mode |
| `replica-partition` | Blocks replication RPC to N replicas | Quorum degradation, REPLICA_HEALTH_CHANGE entries, write behavior |
| `slow-replica` | Adds artificial latency to replica RPC | Tail latency amplification, quorum commit degradation |
| `split-epoch` | Injects stale-epoch replication attempt | Epoch rejection, ENTRY_STALE_EPOCH_DISCARDED, no state corruption |
| `snapshot-corruption` | Overwrites R2 snapshot with corrupt bytes | Checksum detection, fallback replay, correctness preservation |
| `quorum-degraded` | Kills N-1 replicas | UNSAFE_SINGLE_NODE_MODE behavior, explicit degradation signal |
| `replay-divergence` | Injects nondeterministic executor behavior | Determinism verification failure detection |

### Invariant Assertions

Every chaos scenario validates these invariants post-execution:

```
✓ No committed entry lost
✓ Commit index monotonically increasing
✓ No duplicate fencing token issued
✓ Replay equivalence preserved: snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)
✓ No stale epoch accepted as valid commit
✓ Snapshot lineage preserved
✓ No externally visible write without quorum commit
✓ RECOVERING mode entered before any write accepted post-reactivation
```

Chaos becomes **protocol verification**, not fault observation.

### Chaos Report Output

Each run produces:
- Timeline of committed RCL entries during scenario
- Recovery duration (wall time + entry count)
- Invariant assertion results (pass/fail with evidence)
- Diff of materialized state before/after chaos

---

## 13. Benchmarking Strategy

### Philosophy

QUORUM benchmarks prioritize **coordinated tail latency analysis**. Reported p99 values include replica wake-up, Durable Object activation, and snapshot recovery overhead — not merely steady-state hot-path execution. Benchmarks are honest observed baselines, not guaranteed SLO targets. Results vary significantly by deployment region, contention level, and runtime warm/cold state.

All benchmarks are run in explicitly stated conditions:
- `local-region`: kernel and replicas co-located in same Cloudflare colo
- `cross-region`: replicas in geographically distinct colos
- `cold-start`: first request after DO hibernation
- `warm`: steady-state hot-path after 60s warmup

### Core Benchmarks

| Benchmark | Measures | Reported |
|---|---|---|
| Lock acquisition latency | `lock()` round-trip, no contention, warm | p50/p95/p99/p999 |
| Lock contention throughput | ops/sec, N concurrent acquirers on same key | Linear degradation curve |
| Quorum commit latency | append → commit index advance, 2-of-3, warm | p50/p99, local vs cross-region |
| Replication lag under load | replica lag (entries) at 1k/5k/10k ops/min | lag percentiles |
| Snapshot compaction | 50k-entry compaction cycle duration | wall time + pause impact |
| Recovery time — eviction | DO activation → ACTIVE state | snapshot load + replay time |
| Workflow throughput | steps/sec, 10-step linear workflow | baseline + regression tracking |
| Replay cold-start | snapshot load + 10k entry replay | wall time |

### Benchmark Output Format (Structured JSON)

Results committed to `benchmarks/results/YYYY-MM-DD-{scenario}.json` for regression tracking. Human-readable summary printed to stdout.

### Coordinated Omission Awareness

Benchmarks use coordinated omission correction (HDR Histogram methodology). Reported latencies reflect true tail behavior under load, not artificially compressed distributions from constant-throughput measurement.

---

## 14. Known Constraints & Honest Tradeoffs

This section deliberately documents where QUORUM breaks, scales poorly, or makes uncomfortable tradeoffs. Infrastructure systems earn trust through honesty about limitations.

**Single-namespace hot-key bottleneck.** Total ordering within a namespace means all writes through one `CoordinationRuntimeDO`. High-contention resources (a single global lock acquired at 10k/s) will hit DO serialization limits. Mitigation: namespace-level sharding, but that defers to Phase 2 federation.

**Durable Object placement is platform-controlled.** Cloudflare determines where a DO runs. Cross-region replication latency is unavoidable for globally distributed deployments. There is no mechanism to pin a coordination namespace to a specific region.

**Replay cost scales with causal history size.** Large workflow histories or long-lived namespaces with infrequent snapshots will have expensive recovery paths. The snapshot threshold is tunable but not eliminable.

**Workflow determinism constrains runtime APIs.** Protocol executors cannot call `Date.now()`, `Math.random()`, or make unmediated external calls. This is the correct constraint for replay safety, but it is genuinely limiting for workflows that need wall-clock scheduling.

**Snapshot stabilization increases storage retention cost.** The stabilization window before compaction means QUORUM retains more log history than strictly necessary. This is the correct trade for recoverability but has storage cost implications at scale.

**Cross-namespace workflows require explicit coordination.** QUORUM Flow workflows that span multiple namespaces cannot rely on single-RCL total ordering. Cross-namespace saga/compensation patterns require explicit design.

**Observability subscriber lag.** Under high write throughput, observability consumers (metrics, tracing) may lag. Derived views are eventually consistent over the RCL. Operators must not rely on real-time metric accuracy for latency-sensitive decisions.

**Large-scale namespace federation is future work.** Phase 1 handles single-group coordination. Multi-group partitioning and cross-namespace routing are Phase 2/3 features, not current scope.

---

## 15. Correctness Properties

These are the formal safety and liveness properties QUORUM guarantees. They are not aspirational — each has a corresponding chaos test that verifies it under fault injection.

### Safety Properties

**S1 — Committed entry durability.** No entry that has received quorum commit acknowledgement may be lost, even under `CoordinationRuntimeDO` eviction, replica failure, or snapshot compaction. Proof surface: `leader-eviction` chaos scenario with invariant assertion "no committed entry lost."

**S2 — Commit index monotonicity.** The commit index never decreases. Advancing, then retreating the commit index would allow committed entries to be "uncommitted" — this is impossible by construction: commit index advances only in the Commit Coordinator on quorum ACK receipt, and the RCL Engine rejects any seq ≤ current commit index as a duplicate.

**S3 — Mutual exclusion.** At most one valid lock holder exists per resource key at any committed seq. Proof surface: materialized lock state is a pure function of the RCL — two simultaneous `LOCK_ACQUIRE { outcome: COMMITTED }` entries for the same resource key at overlapping `[acquireSeq, releaseSeq]` ranges is structurally impossible because validation runs atomically within the single-writer DO before any replication.

**S4 — Fencing token global monotonicity.** `fencingToken = (term << 32) | seq` is strictly increasing across the lifetime of a namespace, including across DO evictions and term increments. A token from term T is always greater than any token from term T-1.

**S5 — Replay equivalence.** `snapshot(seq=N) + replay(entries N+1 → HEAD) ≡ full replay(0 → HEAD)`. Any two replay paths from a common ancestor produce identical materialized state. Proof surface: `quorum dev determinism-check`.

**S6 — No stale epoch commits.** An entry with epoch E cannot be committed in a context where the current epoch is E' > E. The Commit Coordinator validates epoch on every ACK before advancing the commit index.

**S7 — Protocol executor determinism.** For any committed log prefix, executing the Protocol Registry's state machine produces the same materialized state on every node, every time. Enforced by: no wall-clock reads, no randomness, no unordered async in executors. Verified by determinism diff testing.

### Liveness Properties

These hold under the assumption of eventual network reachability. QUORUM makes no liveness guarantees under permanent partitions — it is CP.

**L1 — Write progress.** If the `CoordinationRuntimeDO` can reach quorum (⌊N/2⌋+1 replicas), a write eventually commits or returns an explicit rejection.

**L2 — Replica convergence.** If a replica recovers network connectivity, it eventually converges to the kernel's commit index via gap-fill or snapshot recovery.

**L3 — Election resolution.** If a leader lease expires and candidates exist, a new `LEADER_ESTABLISHED` entry is eventually committed within the election window (`baseSeq + windowSize` entries).

**L4 — Recovery completion.** A `CoordinationRuntimeDO` that activates in `RECOVERING` mode eventually transitions to `ACTIVE`, provided a valid snapshot or log segment baseline exists in R2 or SQLite.

### Properties QUORUM Does NOT Claim

- **Byzantine fault tolerance.** QUORUM assumes non-Byzantine failures — crashed or partitioned nodes, not actively malicious ones.
- **Cross-namespace total ordering.** Operations in different namespaces have no ordering relationship.
- **Real-time liveness bounds.** QUORUM does not guarantee coordination within a wall-clock deadline. Platform scheduling, DO placement, and region latency introduce unavoidable variance.

---

## 16. Security & Multi-Tenancy

Security is not bolted on. It derives from the same namespace boundary that defines total ordering.

### Namespace-Scoped Authorization

Every SDK call carries a signed `NamespaceToken`:

```ts
type NamespaceToken = {
  namespaceId: string;
  permissions: ("read" | "write" | "admin")[];
  issuedAt: number;
  expiresAt: number;
  signature: string;   // HMAC-SHA256 over (namespaceId + permissions + issuedAt + expiresAt)
};
```

The `CoordinationRuntimeDO` validates the token's HMAC on every RPC before any log access. Tokens are scoped to a namespace — a token for namespace `payments` cannot read or write `inventory`. Admin tokens are required for topology mutations (`REPLICA_DECOMMISSION`, `CLUSTER_INITIALIZED`).

### Replay & Subscription Authorization

Subscription cursors require a read-scoped token for the target namespace. The `fromSeq` parameter cannot access entries before the token's `issuedAt` epoch boundary — historical replay is bounded to the token's authorized window. This prevents a compromised read token from exfiltrating full coordination history.

### Effect Payload Encryption

Workflow effect payloads stored in R2 (`r2://effects/{workflowId}/{effectId}`) are encrypted with AES-256-GCM using a namespace-derived key. The `effectChecksum` in the RCL covers the plaintext — decryption failure is detectable. Encryption keys are never stored in the RCL; they are derived from a namespace secret held in Workers Secrets.

### Namespace Isolation Guarantees

Namespaces are isolated at the DO level — `CoordinationRuntimeDO` instances are namespaced by their DO name (`quorum:{namespaceId}`). There is no shared in-process state between namespaces. A compaction failure, replay error, or security incident in one namespace cannot affect another.

### Rate Limiting & Abuse Prevention

Per-namespace rate limits enforced at the SDK entry point (configurable, default: 1,000 writes/sec per namespace). The `CoordinationRuntimeDO` tracks write rate in a sliding window using DO alarm API. Exceeding the limit returns `RATE_LIMIT_EXCEEDED` — not a silent drop.

### Quota Enforcement

- **Log size quota:** Namespaces that exceed `maxLogSizeBytes` (default: 1GB across hot SQLite + R2 segments) have writes blocked until compaction completes. `QUOTA_EXCEEDED` returned explicitly.
- **Replica count:** Maximum 5 replicas per namespace (Cloudflare DO stub limit consideration).
- **Workflow concurrency:** Maximum concurrent in-flight workflows per namespace is configurable; excess `WORKFLOW_STARTED` operations receive `WORKFLOW_CONCURRENCY_LIMIT`.

### Signed Topology Mutations

`CLUSTER_INITIALIZED`, `REPLICA_DECOMMISSION`, and `UNSAFE_SINGLE_NODE_MODE` entries require an admin-scoped token. Their payload includes a `topologyNonce` — a monotonically increasing counter that prevents replayed topology mutations.

### Snapshot Integrity

R2 snapshot objects are stored with a content hash in the object key (`snap_{seq}_{checksum}.bin`). On restore, the `CoordinationRuntimeDO` recomputes the checksum and rejects mismatches before applying any protocol state. This catches both corruption and substitution attacks.

---

## 17. Cost Characteristics

Infrastructure that ignores cost is infrastructure that doesn't ship. QUORUM's cost model is derived from Cloudflare's public pricing as of the spec date — actual costs vary.

### Cost Drivers

**Durable Object reads/writes (SQLite operations).** Every log append = 1 SQLite write. Commit marking = 1 write. Compaction = N deletes. At 1,000 writes/sec: ~86M DO writes/day. At Cloudflare's pricing, this is the dominant cost driver for write-heavy namespaces.

**Durable Object CPU time.** The `CoordinationRuntimeDO` executes validation, replication fan-out, and state machine transitions per write. CPU time per write is proportional to protocol complexity. Workflow step transitions are more expensive than lock acquisitions.

**R2 storage.** Segments accumulate at `~(entrySize * snapshotThreshold)` per compaction cycle. At 1KB average entry and 50k threshold, each segment is ~50MB. R2 storage is cheap ($0.015/GB/month) but archival at high throughput adds up. Segment retention policy is configurable.

**Replication RPC amplification.** Each write fans out to N replicas. 3-replica setup = 3x DO RPC calls per write. RPC costs within the same Cloudflare account are negligible but contribute to CPU billing.

**R2 operations for snapshot reads.** Recovery reads one snapshot from R2 per DO activation. At default hibernation behavior (eviction after ~10s idle), frequent low-traffic namespaces may pay repeated R2 GET costs. Mitigation: keep-alive pings from SDK for latency-sensitive namespaces.

### Cost Optimization Strategies

- **Increase `snapshotThreshold`** to reduce R2 write frequency at the cost of longer recovery replay.
- **Reduce replica count to 2** (kernel + 1) for non-critical namespaces — halves replication RPC cost.
- **Batch writes** in the SDK: multiple operations can be submitted as a single RCL batch, amortizing per-write overhead.
- **Effect payload compression**: large workflow effect payloads compressed before R2 write.
- **Trace retention TTL**: reducing hot trace window from 24h to 6h cuts DO trace storage cost.

### Cost Anti-Patterns to Avoid

- High-frequency lock acquisitions on short TTLs generate disproportionate RCL entries and DO write volume. Use leases with longer TTLs where possible.
- Workflow DAGs with many short parallel steps generate O(steps) RCL entries per workflow. Batch logically atomic sub-steps.
- Aggressive snapshot thresholds (low `snapshotThreshold`) cause frequent R2 writes + segment archival for minimal replay benefit.

---

## 18. Federation Roadmap

**Current ceiling:** Phase 1 tops out at single-`CoordinationRuntimeDO` total ordering per namespace. A single DO serializing all writes for a namespace is the correct first constraint — it proves correctness before distribution is introduced. Cloudflare's DO write throughput (estimated ~1,000 synchronous writes/sec per isolate) is the practical ceiling for a single namespace under sustained load.

### Phase 1 (Current)

Single `CoordinationRuntimeDO` per namespace. Proven correctness, replay, sequencing, observability. Namespace = total ordering unit. Explicitly single-group — no cross-group coordination, no federation.

### Phase 2 — Namespace Partitioning

**Shard assignment:** A `NamespaceRouterDO` maps namespace → `CoordinationGroupDO` via consistent hashing on `namespaceId`. Each group has its own independent RCL and replica set. Group assignment is committed as a `NAMESPACE_SHARD_ASSIGNED { namespaceId, groupId, assignedAt }` entry in a top-level routing log.

**Migration semantics:** Moving a namespace between groups requires a two-phase handoff:
1. Source group enters `READ_ONLY` mode — writes rejected, reads served
2. Source group flushes all pending replication, creates a migration snapshot
3. Target group imports snapshot, replays delta
4. `NAMESPACE_SHARD_MIGRATED` committed in routing log — clients redirected
5. Source group entries archived to R2, group decommissioned after retention window

**Cross-namespace operations:** Remain explicitly eventual. Applications requiring cross-namespace atomicity must implement saga patterns over QUORUM Flow compensation semantics. QUORUM does not provide distributed transactions across shard groups.

### Phase 3 — Federation (Exploratory)

Cross-group causal links via Lamport timestamps propagated between `CoordinationGroupDO` instances at shard boundaries. Enables cross-namespace causal ordering for observability and replay — not for write coordination. Inter-group replay allows reconstructing causally-related events across shards for debugging.

This phase requires solving distributed snapshot coordination (each group snapshots independently; cross-group consistent cuts are approximated, not exact) and topology rebalancing (live shard migration without service interruption). These are research-grade problems — Phase 3 is intentionally underdefined until Phase 2 is operational and the actual bottlenecks are observed.

---

## 19. Scope Boundaries

QUORUM explicitly is not:

- **A general-purpose event bus.** The RCL is a coordination log, not a message routing system.
- **A message queue.** Cloudflare Queues already exists and handles that primitive correctly.
- **A distributed database.** QUORUM does not provide query engines, indexing, or general-purpose storage.
- **A Temporal clone.** QUORUM Flow is a protocol layer over coordination primitives — not an opinionated workflow platform with its own DSL, SDK semantics, or activity scheduling runtime.
- **A consensus research platform.** QUORUM exploits Durable Objects semantics rather than implementing textbook Raft. It is infrastructure-native, not academically complete.

---

## Repository Structure

```
/apps
  /dashboard          — topology visualization, replay inspector, trace UI
/packages
  /sdk                — @quorum/sdk: client library, TypeScript types
  /cli                — @quorum/cli: quorum dev / quorum ops commands
  /runtime            — CoordinationRuntimeDO, ReplicaDO, state machines
  /protocol           — Protocol executors: Lock, Lease, Election, Workflow
  /observability      — Metrics materializer, trace emitter, timeline builder
/benchmarks           — Benchmark harnesses, results/, regression tracking
/chaos-tests          — Chaos scenarios, invariant assertions, chaos reports
/docs
  /rfcs               — Request for Comments documents
  /adrs               — Architecture Decision Records
  /superpowers
    /specs            — This document and future specs
/examples             — Quickstart, lock patterns, workflow examples
/scripts              — Deploy automation, topology scripts
```

---

*This specification reflects the design as of 2026-05-25. Protocol versions begin at 1. All implementation must be validated against the replay equivalence invariant: `snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)`.*
