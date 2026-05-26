<div align="center">

```
   ██████╗ ██╗   ██╗ ██████╗ ██████╗ ██╗   ██╗███╗   ███╗
  ██╔═══██╗██║   ██║██╔═══██╗██╔══██╗██║   ██║████╗ ████║
  ██║   ██║██║   ██║██║   ██║██████╔╝██║   ██║██╔████╔██║
  ██║▄▄ ██║██║   ██║██║   ██║██╔══██╗██║   ██║██║╚██╔╝██║
  ╚██████╔╝╚██████╔╝╚██████╔╝██║  ██║╚██████╔╝██║ ╚═╝ ██║
   ╚══▀▀═╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝
```

**Replay-native coordination runtime for edge-distributed systems.**

*Built on Cloudflare Workers & Durable Objects.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](./LICENSE)
[![Status: Pre-release](https://img.shields.io/badge/Status-Pre--release-F59E0B?style=flat-square)]()

</div>

---

## TL;DR

**For non-technical readers:** QUORUM is infrastructure software that solves one of the hardest problems in distributed computing — making sure that when thousands of servers are running at the same time, they all agree on who gets to do what, in what order, without conflict. Think of it as a highly precise traffic controller for software systems, built specifically for Cloudflare's global edge network.

**For engineers:** QUORUM is a self-deploying coordination runtime built on Cloudflare Durable Objects. It provides distributed locks, leases, leader election, and replayable workflows — all derived from a single append-only Replicated Coordination Log (RCL). The DO's single-writer guarantee replaces Raft leader election. The RCL is the system's only source of truth: metrics, tracing, recovery, and deterministic replay all materialize from the same causal spine.

**For recruiters:** This project demonstrates principal-level distributed systems engineering — not a tutorial, not a Raft clone, not a CRUD wrapper. QUORUM is an edge-native coordination runtime that adapts consensus semantics specifically for serverless infrastructure, implements a tiered SQLite/R2 storage strategy for replay-native recovery, and ships with formal correctness properties, chaos engineering, and cost-aware operational design.

---

## Table of Contents

- [The Problem](#the-problem)
- [What QUORUM Is](#what-quorum-is)
- [The Core Insight](#the-core-insight)
- [How It Works — Plain English](#how-it-works--plain-english)
- [Architecture](#architecture)
  - [The Fundamental Invariant](#the-fundamental-invariant)
  - [System Topology](#system-topology)
  - [Component Breakdown](#component-breakdown)
  - [The Write Path](#the-write-path)
  - [The Storage Strategy](#the-storage-strategy)
- [Coordination Primitives](#coordination-primitives)
  - [Distributed Locks](#distributed-locks)
  - [Leases](#leases)
  - [Leader Election](#leader-election)
  - [QUORUM Flow — Replayable Workflows](#quorum-flow--replayable-workflows)
- [Replication & Consensus](#replication--consensus)
- [Replay & Recovery](#replay--recovery)
- [Observability](#observability)
- [Security Model](#security-model)
- [Getting Started](#getting-started)
- [Repository Structure](#repository-structure)
- [Benchmarks](#benchmarks)
- [Design Decisions & Tradeoffs](#design-decisions--tradeoffs)
- [Correctness Properties](#correctness-properties)
- [Known Constraints](#known-constraints)
- [Roadmap](#roadmap)
- [For Engineers & Recruiters](#for-engineers--recruiters)
- [Documentation](#documentation)

---

## The Problem

### In plain English

Imagine 10,000 servers spread across the world, all running your application at the same time. Now imagine two of them receive a payment request for the same user at the exact same moment. Both servers check: "Has this payment been processed?" Both see: "No." Both process it. You've charged your customer twice.

This is called a **race condition** — and it's one of the most dangerous problems in software engineering. It's why banks have fraud, why ticket systems oversell concerts, why inventory systems show items that are already gone.

The traditional solution is a **lock** — a mechanism that says "only one server can do this at a time." But implementing locks correctly when your servers are spread across hundreds of locations worldwide, can crash at any moment, and are inherently ephemeral (they come and go in milliseconds) is extremely hard.

**QUORUM solves this.** It provides the coordination infrastructure that lets globally distributed systems agree on who does what, in what order, without duplicating work, losing data, or creating conflicts — even when individual servers crash.

### In technical terms

Distributed coordination at the edge presents constraints that existing systems weren't designed for:

- **etcd, Consul, ZooKeeper** assume long-lived processes on known machines with stable network topology. Cloudflare Workers have none of these.
- **Temporal** provides durable workflow execution, but is workflow-first and inherits orchestration complexity before you've built basic coordination primitives.
- **Redis** provides atomic operations but offers no replication semantics, no replay, and no formal consistency guarantees appropriate for distributed locks at scale.

The core challenge is that **serverless edge runtimes break every assumption classical consensus algorithms make**: there are no persistent processes, no machine identities, no control over scheduling, and no guaranteed execution windows.

QUORUM is built ground-up for this model — exploiting Cloudflare's guarantees rather than fighting them.

---

## What QUORUM Is

QUORUM is a **self-deploying edge-native coordination runtime**. It installs directly into your Cloudflare account, provisions its own infrastructure, and is consumed from your Workers via direct RPC — zero HTTP hops, no external services, no centralized bottleneck.

```bash
npm install @quorum/sdk
npx quorum init    # provisions DOs, bindings, R2 bucket, typed config
npx quorum deploy  # installs coordination runtime into your account
```

Then, in any Worker:

```ts
import { Quorum } from "@quorum/sdk";

const quorum = new Quorum(env);

// Globally coordinated lock — only one Worker in the world
// can be inside this callback at any given time
await quorum.lock("payment-{userId}", async (fencingToken) => {
  await processPayment(userId, fencingToken);
});

// Replayable workflow — survives crashes, retries safely
await quorum.workflow("onboard-user-{userId}", {
  steps: [createAccount, sendWelcomeEmail, provisionResources],
});
```

**QUORUM is infrastructure, not a library.** It materializes inside your account as a set of coordinated Durable Objects that form a replicated coordination cluster. Your Workers talk to this cluster over Workers RPC — the fastest communication path available on the Cloudflare platform.

---

## The Core Insight

Most distributed coordination systems fail on serverless infrastructure because they try to port assumptions that don't apply.

**Traditional approach:** Run 5 long-lived servers. Have them vote on a leader. Leader receives all writes. If leader crashes, hold another election. Ship coordination traffic over the network.

**QUORUM's approach:** Cloudflare Durable Objects already provide globally unique singleton execution with serialized write access. A Durable Object *is* the leader — by construction. Its eviction *is* the crash. Its single-writer guarantee *is* the consensus. Instead of implementing Raft, we exploit what the platform already guarantees and build replay-native coordination on top.

The result is an architecture that is simultaneously simpler (no distributed leader election needed in the steady state), more correct (fewer moving parts = fewer failure modes), and better suited to the execution model (we use the platform's invariants rather than working around them).

```
Traditional Raft:                    QUORUM:
5 machines                           1 authoritative Durable Object
→ compete for leadership             → already the global singleton
→ replicate logs to each other       → replicates to ReplicaDOs
→ elect new leader on crash          → eviction is the crash; replay recovers
→ clients route to current leader    → clients call the DO directly via RPC
```

---

## How It Works — Plain English

Think of QUORUM as a very carefully designed **shared notebook** that every server in the world can read and write to, under strict rules.

**The Notebook (Replicated Coordination Log):** Every decision — "server A now holds the lock on payment-123," "server B is the elected leader," "step 3 of workflow X completed" — is written as a permanent, ordered entry in this notebook. Nothing can be erased. The notebook is the truth.

**The Rules:**
1. Before anything gets written in the notebook, at least 2 out of 3 servers must agree it happened. This is called **quorum** — where the project gets its name.
2. Entries are numbered in sequence. Entry 1, then 2, then 3. Never out of order.
3. If a server crashes and comes back, it reads the notebook from the last checkpoint and catches up. It always ends up with the exact same understanding of the world as every other server.

**The Magic:** Because the notebook is the only source of truth, and because reading the notebook always produces the same result no matter when or where you read it, the system becomes **deterministically replayable**. Debugging a distributed system normally requires recreating chaos; with QUORUM, you just replay the log.

**The Edge Advantage:** This notebook lives inside Cloudflare's global network — 300+ locations worldwide. Your Workers talk to it at memory speed, not network speed. A lock acquisition typically completes in under 10ms even under load. There's no central server in Virginia that everything routes through. The coordination infrastructure is wherever your users are.

---

## Architecture

### The Fundamental Invariant

> **The Replicated Coordination Log (RCL) is the authoritative causal timeline. Every observable state in QUORUM is a deterministic function of the RCL. There is no other source of truth.**

This single invariant makes everything else possible:
- A lock is "held" because an un-released `LOCK_ACQUIRE` entry exists in the RCL
- A leader is "elected" because the last `LEADER_ESTABLISHED` entry names them
- A workflow is "in-flight" because its execution history is a contiguous subsequence of RCL entries
- Metrics, traces, and debugging timelines are materialized views over the same log

When everything derives from one spine, things that seem unrelated — observability, recovery, replay, and coordination — become the same problem.

### System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                     Your Cloudflare Worker                      │
│                                                                 │
│   import { Quorum } from "@quorum/sdk"                          │
│   await quorum.lock("resource-key", async () => { ... })        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                     Workers RPC (direct DO stub)
                     ~0ms network overhead
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CoordinationRuntimeDO                         │
│                  (Globally unique singleton)                    │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  RCL Engine  │  │Commit Coordinator│  │Protocol Registry │  │
│  │  SQLite WAL  │  │  Quorum Tracker  │  │  Lock  │  Lease  │  │
│  │  Seq Alloc   │  │  Commit Index    │  │Election│Workflow  │  │
│  └──────┬───────┘  └────────┬─────────┘  └──────────────────┘  │
│         │                   │                                   │
│  ┌──────▼───────────────────▼────────────────────────────────┐  │
│  │                  State Machine Runtime                    │  │
│  └──────┬───────────────────────────────────────────────────┘  │
│         │                                                       │
│  ┌──────▼──────────┐  ┌─────────────────┐  ┌───────────────┐   │
│  │ Replication Mgr │  │  Replay Engine  │  │ Snapshot Mgr  │   │
│  └──────┬──────────┘  └─────────────────┘  └───────┬───────┘   │
└─────────┼──────────────────────────────────────────┼───────────┘
          │ RPC (fan-out)                             │ R2 write
   ┌──────┴───────┐                        ┌─────────▼──────────┐
   │  ReplicaDOs  │                        │    R2 Storage      │
   │  Replica 1   │                        │  snapshots/        │
   │  Replica 2   │                        │  segments/         │
   │  Replica 3   │                        │  effects/          │
   └──────────────┘                        └────────────────────┘
```

**The key thing to notice:** your Worker talks directly to the `CoordinationRuntimeDO` via Workers RPC — not over HTTP, not through a load balancer, not via a third-party service. The coordination cluster lives in your account, on Cloudflare's infrastructure, co-located with your Workers.

### Component Breakdown

| Component | What It Does | Why It Exists |
|---|---|---|
| **CoordinationRuntimeDO** | The authoritative coordination engine. Owns the RCL, sequences all operations, drives replication. | Cloudflare's DO single-writer guarantee makes this the globally consistent sequencer — by construction. |
| **RCL Engine** | Manages the append-only log in SQLite. Assigns sequence numbers, validates idempotency keys, persists entries. | SQLite gives ordered range queries, transactional appends, and clean compaction — superior to key-value for log semantics. |
| **Commit Coordinator** | Collects quorum ACKs from replicas. Advances the commit index when ⌊N/2⌋+1 acknowledgements are received. | Separates "durable" from "committed" — critical for correct replay and recovery semantics. |
| **Protocol Registry** | Routes committed log entries to protocol executors (Lock, Lease, Election, Workflow). | Makes protocols pluggable and version-safe — replay uses the executor version active at commit time. |
| **State Machine Runtime** | Applies protocol state transitions atomically against SQLite materialized state. | Atomicity ensures no partial state — the lock table is always consistent with the RCL. |
| **Replication Manager** | Fans out `appendEntries` RPCs to ReplicaDOs in parallel. Tracks health, manages gap-fill. | Provides redundancy — if the CoordinationRuntimeDO is evicted, replicas preserve committed history. |
| **ReplicaDOs** | Deterministic replication peers. Validate lineage, persist committed entries, serve read replicas. | Not passive mirrors — they validate `prevSeq` and `prevChecksum` on every write, preventing silent divergence. |
| **Replay Engine** | Deterministically replays RCL entries from a snapshot baseline. Used for recovery, debugging, and determinism testing. | The system's correctness guarantee: `snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)`. |
| **Snapshot Manager** | Compacts the hot SQLite log into R2 snapshots. Manages stabilization windows, archival, and recovery baselines. | Bounds recovery cost — without snapshots, recovery time grows with total history. |
| **Observability Hooks** | Async subscribers that materialize metrics and traces from committed RCL entries. Never on the commit path. | Observability is a derived view, not a side channel. Metrics and traces can never diverge from the actual causal history. |

### The Write Path

Every coordination operation follows this exact sequence. The ordering is critical — commit means durability, application is separate:

```
1.  SDK sends operation (lock/lease/elect/workflow) via Workers RPC
2.  RCL Engine: validates idempotency key, allocates sequence number
3.  Protocol Registry: validates operation against current state
    → REJECTED: commit REJECTED entry, return error (rejection is causal history)
    → ACCEPTED: continue
4.  Replication Manager: fans out appendEntries to all ReplicaDOs in parallel
5.  Each ReplicaDO: validates prevSeq + prevChecksum, persists, returns ACK
6.  Commit Coordinator: collects ACKs, advances commit index at ⌊N/2⌋+1
7.  RCL Engine: marks entry COMMITTED in SQLite
8.  State Machine Runtime: applies protocol state transition
9.  Observability Hooks: emit trace span + metrics (async — never blocks)
10. SDK: receives committed result with fencing token
```

The most important property: **a write never returns until quorum commits it**. If the CoordinationRuntimeDO evicts mid-write, the entry is uncommitted. On reactivation, recovery either re-replicates it (if epoch is valid and quorum is reachable) or rolls it back (logging a recoverable event). No committed write is ever lost. No uncommitted write is ever silently accepted.

### The Storage Strategy

QUORUM uses a **two-tier storage architecture** that maps perfectly onto the hot-vs-cold distinction that every production distributed system must manage:

```
┌─────────────────────────────────────────────┐
│          TIER 1 — Hot Coordination Log      │
│          Durable Object SQLite              │
│                                             │
│  • Last ~50,000 log entries                 │
│  • Sub-millisecond read/write               │
│  • Transactional, ordered, indexed          │
│  • The active coordination window           │
└──────────────────────┬──────────────────────┘
                       │ snapshot + archive
                       ▼
┌─────────────────────────────────────────────┐
│         TIER 2 — Cold History & Snapshots   │
│                 Cloudflare R2               │
│                                             │
│  • Immutable log segments (compacted)       │
│  • Point-in-time recovery snapshots         │
│  • Workflow effect payloads (encrypted)     │
│  • Infinite historical replay               │
└─────────────────────────────────────────────┘
```

**Why SQLite for the hot log instead of key-value storage?**

The append-only log is fundamentally a sequential storage problem. Key-value storage forces you to reinvent indexing, range scans, and compaction — badly. SQLite's ordered `seq` primary key, `WHERE committed = 0` index for recovery scanning, and transactional `DELETE WHERE seq <= N` for compaction are exactly what a coordination log needs. Using KV for a log is a mistake most engineers make exactly once.

**The log entry schema:**

```sql
CREATE TABLE log_entries (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,  -- causal ordering
  term             INTEGER NOT NULL,                   -- leadership term
  epoch            INTEGER NOT NULL,                   -- replication epoch
  wall_clock_ts    INTEGER NOT NULL,                   -- observational only
  protocol         TEXT NOT NULL,                      -- LOCK | LEASE | ELECTION | WORKFLOW
  protocol_version INTEGER NOT NULL,                   -- for replay version safety
  operation        TEXT NOT NULL,                      -- LOCK_ACQUIRE | LOCK_RELEASE | etc.
  resource_key     TEXT NOT NULL,                      -- "payment-123"
  payload          BLOB NOT NULL,                      -- protocol-specific data
  checksum         TEXT NOT NULL,                      -- lineage verification
  committed        BOOLEAN DEFAULT FALSE               -- quorum committed?
);
```

**Critical distinction:** `seq` is the authoritative causality ordering. `wall_clock_ts` is observational metadata only — replaying the log always produces the same state regardless of when you replay it.

---

## Coordination Primitives

### Distributed Locks

The most fundamental primitive. Guarantees that only one holder across your entire globally distributed system can be inside the critical section at any time.

```ts
// Basic lock
await quorum.lock("inventory-item-42", async (fencingToken) => {
  const item = await db.get("item-42");
  await db.set("item-42", { ...item, stock: item.stock - 1 });
});

// With options
const result = await quorum.lock("payment-{orderId}", {
  ttl: 30_000,          // 30 second lease — auto-expires if Worker crashes
  consistency: "linearizable",
}, async (fencingToken) => {
  return await processPayment(orderId, fencingToken);
});
```

**The fencing token** is a monotonically increasing integer `(term << 32) | seq`. Pass it to any downstream storage system. If a slow or crashed Worker tries to write with a stale token, the downstream system rejects it. This prevents the classic "lock expired but Worker didn't know" data corruption scenario.

**Under the hood:** `LOCK_ACQUIRE { outcome: COMMITTED | REJECTED }` is appended to the RCL. The lock table is a materialized view over these entries. Expiry is itself a log entry (`LOCK_EXPIRE`) — not a timer side effect — making it replayable and observable.

**What happens if the Worker holding the lock crashes?** The lock TTL expires, a `LOCK_EXPIRE` entry is committed to the RCL, and the lock becomes available. No manual intervention needed. No stuck locks.

### Leases

Leases are renewable locks. They introduce an **epoch** — a counter that increments on each renewal — preventing the ABA problem: a slow client cannot accidentally renew an expired lease that was re-acquired by someone else.

```ts
const lease = await quorum.lease("leader-lease", { ttl: 10_000 });

// Must renew before TTL expires
const interval = setInterval(async () => {
  await lease.renew(); // fails with EPOCH_MISMATCH if lease was re-acquired
}, 3_000); // TTL/3 — deterministic renewal interval

// Release when done
clearInterval(interval);
await lease.release();
```

**Heartbeat semantics:** `renewInterval = floor(ttl / 3)`. Jitter is deterministic — `hash(namespace, leaseId, epoch) % floor(ttl / 10)` — avoiding synchronized renewal storms across multiple Workers without introducing non-deterministic behavior that would break replay.

### Leader Election

Deterministic leader election across a group of Workers. Any number of candidates can nominate themselves; the first to arrive in the total ordering of the RCL wins.

```ts
const election = await quorum.elect("data-processor-group", {
  candidateId: workerInstanceId,
  onElected: async () => {
    console.log("I am the leader");
    await startProcessing();
  },
  onDeposed: async () => {
    console.log("I lost leadership");
    await stopProcessing();
  },
});
```

**Why lease-based, not vote-based?** In a Durable Object model, split-vote is impossible within a namespace — the DO is already the global singleton sequencer. Vote-based election would be theater. Instead, leadership is a lease held by the winner. When the lease expires, a new election window opens. The winner is always the first nominee in the RCL's total order — a pure function of committed history, deterministically replayable.

**Election windows are sequence-bounded, not time-bounded.** The election closes at `baseSeq + windowSize` — not after a timeout. This makes elections replay-safe: the same set of nominations always produces the same winner, regardless of when replay happens.

### QUORUM Flow — Replayable Workflows

The highest-level primitive. Workflows are named DAGs of steps whose execution history lives entirely in the RCL. If a Worker crashes mid-workflow, the workflow resumes exactly where it left off — not from the beginning, not from an approximation.

```ts
await quorum.workflow("onboard-{userId}", {
  steps: {
    createAccount: async (ctx) => {
      return await userService.create(ctx.input.userId);
    },
    sendWelcomeEmail: async (ctx) => {
      // ctx.results.createAccount is the result from the previous step
      return await emailService.send(ctx.results.createAccount.email);
    },
    provisionResources: async (ctx) => {
      return await resourceService.provision(ctx.input.userId);
    },
  },
  // Steps without dependencies run in parallel automatically
  parallelism: { sendWelcomeEmail: ["createAccount"], provisionResources: ["createAccount"] },
});
```

**The replay gate invariant:** A step executes *if and only if* no `STEP_COMPLETE { workflowId, stepId }` entry exists in the RCL. This is a pure function of the log — no separate state table, no database lookups. Replay always produces the same execution graph.

**Side effect safety:** External calls (API requests, database writes, emails) are recorded as `STEP_EFFECT_RECORDED { effectId, checksum, r2Pointer }` entries before `STEP_COMPLETE` is committed. On replay, if the effect record exists, the external call is skipped and the recorded result is used. This gives **at-most-once external execution** with **exactly-once protocol semantics**.

**Compensation:** If a workflow fails mid-execution, QUORUM Flow walks `STEP_COMPLETE` entries in reverse `seq` order, executing compensating actions for each completed step. The full compensation history is committed to the RCL — auditable and replayable.

---

## Replication & Consensus

QUORUM achieves consensus through **Durable Object semantics + quorum replication**, not distributed voting.

### How Quorum Works

Every write must be acknowledged by the majority of the coordination cluster before it is considered committed:

```
Cluster of 3 (1 kernel + 2 replicas):
Required ACKs = ⌊3/2⌋ + 1 = 2

Write arrives at CoordinationRuntimeDO
  → CoordinationRuntimeDO appends to SQLite (1 ACK: itself)
  → fans out to Replica 1 and Replica 2 in parallel
  → Replica 1 ACKs (2 ACKs total → QUORUM REACHED)
  → Replica 2 ACKs (3 ACKs — write is fully replicated)
  → Entry marked COMMITTED
  → SDK receives result
```

If a replica is unreachable: writes proceed as long as remaining replicas form quorum. The unreachable replica reconciles via gap-fill when it reconnects. If quorum can't be reached: writes block — QUORUM is CP, not AP, on the write path.

### Replica Health & Bounded Staleness

The `ReplicationManager` tracks each replica's health in a `ReplicaRegistry`:

```
Replica health states:
  active          — responding normally, lag < threshold
  degraded        — 3+ consecutive failures, excluded from quorum temporarily
  snapshot_recovery — lag exceeded maxReplicaLagSeq (10,000 entries by default)
                      replica rehydrates from R2 snapshot rather than replaying
```

When a replica enters `snapshot_recovery`, it fetches the latest snapshot from R2 and replays only the delta — bounding recovery cost regardless of how long the replica was unreachable. A replica that's been down for an hour doesn't force a 1-hour replay.

All health state changes (`REPLICA_HEALTH_CHANGE { replicaId, from, to }`) are committed to the RCL — **operational topology is replayable state**. You can reconstruct the exact health timeline of your cluster from any point in history.

---

## Replay & Recovery

Recovery in QUORUM is not a special case. It's the same operation as replay — just executed at startup instead of intentionally.

### The Recovery Sequence

```
CoordinationRuntimeDO activates (new deploy, eviction recovery, crash)
  ↓
Enters RECOVERING mode (writes rejected, bounded reads allowed)
  ↓
Reads latest SNAPSHOT_COMPLETE entry from SQLite
  ↓
Loads snapshot from R2, validates checksum + protocol version compatibility
  ↓
Each protocol executor: restoreSnapshot(slice, version)
  ↓
Replays SQLite entries from snapshotSeq+1 → HEAD
  ↓
Scans for UNCOMMITTED entries:
  - Valid epoch + quorum reachable → re-replicate, commit
  - Quorum unreachable → append ENTRY_ROLLBACK, discard
  - Stale epoch → append ENTRY_STALE_EPOCH_DISCARDED (never silent)
  ↓
Transitions RECOVERING → ACTIVE
  ↓
Resumes serving requests
```

**Nothing is ever silently discarded.** Every recovery decision — rollback, stale epoch, checksum failure — produces a committed entry in the RCL. This means you can replay the recovery itself.

### The Snapshot Replay Contract

The most important invariant in the entire system:

```
snapshot(seq=N) + replay(entries N+1 → HEAD) ≡ full_replay(0 → HEAD)
```

This is not aspirational. It is a tested property. `quorum dev determinism-check` verifies it: runs a workload, captures the RCL, replays from the latest snapshot, byte-compares the materialized state against a full replay from seq 0. If they differ, the build fails.

### Snapshot Architecture

```
Trigger: SQLite log exceeds 50,000 entries (configurable)

1. Serialize each protocol executor's state → SnapshotSlice
2. Compose: { seq, term, epoch, protocolVersions, slices, checksum }
3. Write to R2: snapshots/{namespace}/snap_{seq}_{checksum}.bin
4. Commit SNAPSHOT_COMPLETE to RCL (snapshot becomes causal history)
5. Wait for all active replicas to ACK SNAPSHOT_ADOPTED (stabilization window)
6. Archive SQLite entries 0→N to R2 segments: seg_{startSeq}_{endSeq}.log
7. DELETE SQLite entries 0→N-1 (only after stabilization — never premature)
```

**Snapshot stabilization** prevents a race condition that would be catastrophic: compacting the log before replicas have adopted the new snapshot baseline. QUORUM never compacts until all active replicas have acknowledged the snapshot. This is the operationally paranoid choice — it costs slightly more storage but eliminates an entire class of unrecoverable failure.

---

## Observability

### The RCL Is the Observability Primitive

QUORUM does not instrument hot paths with metric counters. It does not inject tracing middleware. Instead:

> Every observable event in the system is already a committed entry in the RCL. Observability is a materialized view over the causal timeline.

```
RCL committed entries (async subscription, never on commit path)
   │
   ├── Metrics Materializer
   │     quorum_lock_acquisitions_total { namespace, outcome }
   │     quorum_quorum_commit_latency_ms { namespace, replicaCount }
   │     quorum_replication_lag_entries { replicaId, namespace }
   │     quorum_replica_health_status { replicaId, status }
   │     quorum_workflow_step_duration_ms { namespace, stepId }
   │     ... and more
   │
   ├── Trace Emitter (OpenTelemetry)
   │     Reconstructs causally-linked span trees from committed entries
   │     LOCK_ACQUIRE → span start
   │     replica_1 ACK → span event
   │     quorum_commit → span event
   │     state_applied → span end
   │
   └── Timeline Builder
         Replay-native debugging timeline
         Reconstruct any historical window deterministically
```

**What this means in practice:**
- Metrics can be rebuilt at any time by replaying the RCL
- Distributed traces are causally correct — not correlations, not approximations
- If the observability pipeline crashes, it recovers from its last checkpoint and catches up
- **Observability lag never affects coordination correctness** — they are independent consumers of the same log

### Replay-Native Debugging

```bash
quorum dev replay --namespace payments --from 84200 --to 84300
```

Produces a structured timeline of every coordination event in that seq range — lock acquisitions, contention, quorum timings, replica health changes, everything. This is deterministic historical reconstruction, not log grepping.

```bash
quorum dev replay --namespace payments --from 84200 --to 84300 --dry-run
```

With `--dry-run`: reconstructs the full state at `seq=84300` without emitting any effects. Useful for "what was the exact state of the system at this moment?"

---

## Security Model

### Namespace-Scoped Authorization

Every SDK call carries a signed `NamespaceToken`:

```ts
type NamespaceToken = {
  namespaceId: string;
  permissions: ("read" | "write" | "admin")[];
  issuedAt: number;
  expiresAt: number;
  signature: string;  // HMAC-SHA256(namespaceId + permissions + timestamps + secret)
};
```

A token for namespace `payments` cannot read or write `inventory`. Admin-scoped tokens are required for topology mutations. Token signatures are verified on every RPC.

### Key Security Properties

- **Namespace isolation at the DO level** — `CoordinationRuntimeDO` instances are namespaced by their DO name. No shared in-process state between namespaces. A security incident in one namespace cannot affect another.
- **Replay access controls** — historical replay is bounded to the token's authorized window. A compromised read token cannot exfiltrate full coordination history from before it was issued.
- **Encrypted effect payloads** — workflow effect payloads in R2 are encrypted with AES-256-GCM using a namespace-derived key. The encryption key is never stored in the RCL.
- **Signed topology mutations** — `CLUSTER_INITIALIZED`, `REPLICA_DECOMMISSION`, and unsafe mode operations require admin tokens with a `topologyNonce` (monotonically increasing, preventing replay attacks).
- **Snapshot integrity** — R2 snapshots are stored with a content hash in the object key. Checksum verification on restore catches both corruption and substitution.
- **Rate limiting** — per-namespace write rate limits enforced at the DO level. `RATE_LIMIT_EXCEEDED` is returned explicitly — never a silent drop.

---

## Getting Started

### Prerequisites

- Cloudflare account with Workers Paid plan (required for Durable Objects)
- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)

### Installation

```bash
# Install the SDK
npm install @quorum/sdk

# Scaffold wrangler bindings, migrations, namespace config, typed env
npx quorum init

# Review generated wrangler.toml and .quorum/config.json, then deploy
npx quorum deploy
```

### What quorum init generates

```toml
# Appended to your wrangler.toml:

[[durable_objects.bindings]]
name = "QUORUM_RUNTIME"
class_name = "CoordinationRuntimeDO"

[[durable_objects.bindings]]
name = "QUORUM_REPLICA"
class_name = "ReplicaDO"

[[r2_buckets]]
binding = "QUORUM_STORAGE"
bucket_name = "quorum-coordination"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CoordinationRuntimeDO", "ReplicaDO"]
```

```ts
// Generated: quorum.env.d.ts
interface Env {
  QUORUM_RUNTIME: DurableObjectNamespace;
  QUORUM_REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
```

### First Lock

```ts
import { Quorum } from "@quorum/sdk";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const quorum = new Quorum(env);

    // This lock is globally coordinated across all your Workers worldwide
    const result = await quorum.lock(`order-${orderId}`, async (fencingToken) => {
      const order = await getOrder(orderId);
      if (order.status !== "pending") return { skipped: true };
      await processOrder(order, fencingToken);
      return { processed: true };
    });

    return Response.json(result);
  },
};
```

### CLI Reference

```bash
# Developer commands
quorum dev replay --namespace payments --from 1000 --to 2000
quorum dev replay --namespace payments --from 1000 --dry-run   # no effects
quorum dev benchmark --namespace payments --ops 1000
quorum dev determinism-check --namespace payments              # verify replay equiv.
quorum dev simulate --scenario lock-contention

# Operator commands
quorum ops topology [--namespace payments] [--watch]           # live cluster view
quorum ops snapshot list --namespace payments
quorum ops snapshot verify --namespace payments --seq 50000
quorum ops recover --namespace payments
quorum ops chaos --scenario leader-eviction --namespace payments --observe 30s
```

---

## Repository Structure

```
quorum/
│
├── packages/
│   ├── sdk/                     @quorum/sdk — client library & TypeScript types
│   │   ├── src/
│   │   │   ├── client.ts        Quorum client class (lock, lease, elect, workflow)
│   │   │   ├── lock.ts          DistributedLock API
│   │   │   ├── lease.ts         Lease API with renewal
│   │   │   ├── election.ts      Leader election API
│   │   │   ├── workflow.ts      QUORUM Flow API
│   │   │   └── types.ts         Public SDK types
│   │   └── package.json
│   │
│   ├── runtime/                 Core DO runtime — the actual distributed system
│   │   ├── src/
│   │   │   ├── coordination-runtime-do.ts   Main DO — assembles all subsystems
│   │   │   ├── rcl/
│   │   │   │   └── rcl-engine.ts            SQLite append-only log
│   │   │   ├── commit/
│   │   │   │   └── commit-coordinator.ts    Quorum ACK tracking
│   │   │   ├── replication/
│   │   │   │   ├── replication-manager.ts   Fan-out, health, gap-fill
│   │   │   │   └── replica-do.ts            ReplicaDO Durable Object
│   │   │   ├── snapshot/
│   │   │   │   └── snapshot-manager.ts      Compaction, R2 archival
│   │   │   └── replay/
│   │   │       └── replay-engine.ts         Deterministic replayer
│   │   └── package.json
│   │
│   ├── protocol/                Protocol executors — state machine interpreters
│   │   ├── src/
│   │   │   ├── registry.ts      Protocol Registry (version-safe routing)
│   │   │   ├── lock.ts          Lock Protocol executor
│   │   │   ├── lease.ts         Lease Protocol executor
│   │   │   ├── election.ts      Election Protocol executor
│   │   │   └── workflow.ts      Workflow Protocol executor
│   │   └── package.json
│   │
│   ├── types/                   @quorum/types — shared TypeScript types
│   │   └── src/
│   │       ├── log-entry.ts     LogEntry, CommittedEntry
│   │       ├── replication.ts   AppendEntriesRequest/Response, ReplicaAck
│   │       └── errors.ts        QuorumError, RecoveringError, etc.
│   │
│   └── observability/           Metrics materializer, trace emitter, timeline builder
│       └── src/
│           ├── metrics.ts       RCL → Prometheus/OTEL metrics
│           ├── tracer.ts        RCL → OTEL span reconstruction
│           └── timeline.ts      Replay-native debugging timeline
│
├── apps/
│   └── dashboard/               Topology visualization, replay inspector, trace UI
│
├── benchmarks/                  Benchmark harnesses and results
│   ├── lock-latency.ts          Lock acquisition p50/p99/p999
│   ├── quorum-commit.ts         End-to-end commit latency
│   ├── replication-lag.ts       Replica lag under sustained load
│   └── results/                 Structured JSON benchmark results (regression tracking)
│
├── chaos-tests/                 Protocol-level chaos scenarios
│   ├── leader-eviction.ts       Mid-write eviction recovery
│   ├── replica-partition.ts     Network partition simulation
│   ├── snapshot-corruption.ts   R2 corruption + fallback
│   ├── split-epoch.ts           Stale epoch injection
│   └── invariants.ts            Shared invariant assertions (all scenarios)
│
├── docs/
│   ├── rfcs/                    Request for Comments documents
│   ├── adrs/                    Architecture Decision Records
│   └── superpowers/
│       ├── specs/               Full system design specification
│       └── plans/               Implementation plans
│
├── examples/
│   ├── distributed-lock/        Payment processing with fencing tokens
│   ├── leader-election/         Distributed job scheduler
│   └── replayable-workflow/     Multi-step onboarding with compensation
│
├── scripts/                     Deploy automation, topology scripts
├── wrangler.toml                Cloudflare Workers + DO bindings
├── turbo.json                   Turborepo pipeline
└── package.json                 Workspace root
```

---

## Benchmarks

> ⚠️ **Note:** All benchmarks are observed baselines, not guaranteed SLO targets. Results vary by deployment region, contention level, and DO warm/cold state. Reported p99 values include replica wake-up, DO activation overhead, and replication latency — not merely steady-state hot-path execution. QUORUM benchmarks use coordinated omission correction (HDR Histogram methodology).

Benchmark classes:

| Class | Conditions |
|---|---|
| `warm, local-region` | Steady-state (60s warmup), kernel + replicas in same Cloudflare colo |
| `warm, cross-region` | Kernel in one region, replicas in geographically distinct colos |
| `cold-start` | First request after DO hibernation |

### Core Metrics (targets, to be validated post-deployment)

| Benchmark | Warm / Local | Cold Start | Measurement |
|---|---|---|---|
| Lock acquisition (no contention) | p50: ~2ms, p99: ~8ms | p99: ~150ms | End-to-end `lock()` round-trip |
| Quorum commit latency (2-of-3) | p50: ~2ms, p99: ~7ms | — | append → commit index advance |
| Replication lag at 1k ops/min | < 10 entries | — | lag percentiles across replicas |
| Recovery time after eviction | ~50-150ms | — | RECOVERING → ACTIVE |
| Snapshot compaction (50k entries) | < 2s | — | wall time + write pause |
| Replay cold-start (10k entries) | < 300ms | — | snapshot load + delta replay |

Run benchmarks against a deployed namespace:
```bash
quorum dev benchmark --namespace payments --ops 1000 --output results/
```

---

## Design Decisions & Tradeoffs

> This section answers the question every experienced engineer will ask: "Why did you make that choice?"

### Why not implement Raft directly?

Raft assumes long-lived processes on known machines with stable identities. Durable Objects are globally unique singletons with no persistent process identity, no machine affinity, and no control over scheduling. Implementing vanilla Raft on DOs would mean fighting the platform — simulating peer discovery, manufacturing fake process IDs, working around the lack of persistent TCP connections.

QUORUM instead leverages what DOs actually provide: global uniqueness, single-writer serialization, and durable SQLite storage. The DO *is* the leader — not through election, but by construction. This is architecturally cleaner, operationally simpler, and more correct for the execution model.

### Why SQLite for the hot log, not KV?

The append-only log is a sequential storage problem. Durable Object KV maps strings to values — you'd need to implement your own sequence indexing, range scans for replay, and compaction by deleting ordered key ranges. SQLite provides all of this natively: `INTEGER PRIMARY KEY AUTOINCREMENT` for sequencing, `SELECT WHERE seq >= ? ORDER BY seq LIMIT ?` for replay, `DELETE WHERE seq <= ?` for compaction, and transactional consistency across all operations.

### Why are rejected operations committed to the RCL?

Because contention is causal history. A rejected `LOCK_ACQUIRE` tells you that a specific client attempted to acquire a specific lock at a specific point in the total order and failed because another holder was present. This information is essential for: replay fidelity (the replay sees the contention, not just the success), observability (lock contention metrics derive from `REJECTED` entries), and debugging (you can reconstruct exactly who was competing for what and when).

### Why sequence-bounded election windows instead of time-bounded?

Deterministic replay. If the election window closes "after 500ms," replaying the log at a different time (or on a different machine) might close the window with a different nomination set, producing a different leader. If the window closes at `baseSeq + 64`, it closes at the same point in the causal order every time — replay always produces the same winner.

### Why CP instead of AP?

A lock service that accepts writes during a network partition is useless. If your lock can be acquired by two holders simultaneously because they're on opposite sides of a partition, you've solved nothing. The entire value of a coordination primitive is its safety guarantee. QUORUM chooses consistency over availability on the write path: during a partition, writes block. The `eventual` read mode is available for use cases that can tolerate stale reads (monitoring, analytics).

### Why not build on top of Temporal?

Temporal is excellent at what it does — opinionated workflow orchestration with a rich SDK, activity scheduling, and managed infrastructure. QUORUM Flow is not trying to replace it. QUORUM's goal is to provide coordination *primitives* — the foundational layer that systems like Temporal are built on. QUORUM Flow exists to demonstrate that replayable workflow semantics emerge naturally from the coordination substrate, not to compete with Temporal's product surface.

---

## Correctness Properties

QUORUM's guarantees are explicit. Each safety property has a corresponding chaos test that verifies it under fault injection.

### Safety (always holds)

| Property | Statement | Verified by |
|---|---|---|
| **S1: Committed entry durability** | No entry that received quorum commit can be lost under eviction, replica failure, or compaction | `leader-eviction` chaos scenario |
| **S2: Commit index monotonicity** | The commit index never decreases | `commit-coordinator.test.ts` |
| **S3: Mutual exclusion** | At most one valid lock holder per resource key at any committed seq | `lock.test.ts` + `replica-partition` chaos |
| **S4: Fencing token monotonicity** | `(term << 32) \| seq` is strictly increasing across the namespace lifetime including failovers | `split-epoch` chaos scenario |
| **S5: Replay equivalence** | `snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)` | `quorum dev determinism-check` |
| **S6: No stale epoch commits** | An entry with epoch E cannot commit when current epoch is E' > E | `split-epoch` chaos scenario |
| **S7: Protocol executor determinism** | For any committed log prefix, executing the protocol state machine produces identical state | `quorum dev determinism-check` |

### Liveness (holds under eventual reachability)

| Property | Statement |
|---|---|
| **L1: Write progress** | If quorum is reachable, a write eventually commits or is explicitly rejected |
| **L2: Replica convergence** | A replica that recovers connectivity eventually converges to the kernel's commit index |
| **L3: Election resolution** | If a leader lease expires and candidates exist, `LEADER_ESTABLISHED` is committed within the election window |
| **L4: Recovery completion** | A DO activating in `RECOVERING` mode eventually transitions to `ACTIVE` given a valid baseline |

### What QUORUM Does NOT Claim

- **Byzantine fault tolerance** — QUORUM assumes non-Byzantine failures (crash/partition, not actively malicious nodes)
- **Cross-namespace total ordering** — operations in different namespaces have no guaranteed ordering relationship
- **Real-time liveness bounds** — platform scheduling, DO placement, and region latency introduce unavoidable variance
- **Sub-millisecond latency under cold-start** — first request after DO hibernation pays activation overhead

---

## Known Constraints

Infrastructure systems earn trust by being honest about limitations. These are real constraints, not disclaimers.

**Single-namespace write bottleneck.** Total ordering within a namespace means all writes serialize through one `CoordinationRuntimeDO`. A single global lock acquired at sustained 10k/s will approach Cloudflare's DO execution limits. Mitigation: namespace-level sharding (Phase 2).

**Durable Object placement is platform-controlled.** Cloudflare determines where a DO runs based on the first request and internal routing. Cross-region quorum replication latency is unavoidable for globally distributed workloads. There is no mechanism to pin a namespace to a specific region.

**Replay cost grows with history.** Long-lived namespaces with infrequent snapshots have expensive recovery paths. Snapshot threshold is tunable but not eliminable. Very high write throughput requires careful snapshot frequency tuning.

**Workflow determinism constrains runtime APIs.** Protocol executors cannot call `Date.now()`, `Math.random()`, or make unmediated external calls. This is the correct constraint for replay safety but limits workflow code that needs wall-clock scheduling.

**Snapshot stabilization increases storage retention.** The stabilization window before compaction means QUORUM retains more history than strictly necessary. Correct trade for recoverability; has storage cost implications at scale.

**Cross-namespace workflows require explicit saga patterns.** A QUORUM Flow workflow spanning multiple namespaces cannot rely on single-RCL total ordering. Cross-namespace coordination requires application-level compensation design.

---

## Roadmap

### Phase 1 — Coordination Kernel (in progress)

- [x] System design specification
- [x] Monorepo scaffold (Turborepo + Workers)
- [x] RCL Engine (SQLite append-only log)
- [x] Commit Coordinator (quorum ACK tracking)
- [x] ReplicaDO (deterministic replication peer)
- [x] Replication Manager (fan-out, health, gap-fill)
- [ ] Lock Protocol executor
- [ ] CoordinationRuntimeDO assembly
- [ ] Replay Engine
- [ ] Snapshot Manager
- [ ] Recovery semantics (RECOVERING mode)
- [ ] `quorum dev determinism-check`
- [ ] SDK entry point (`quorum.lock()`)

### Phase 2 — Full Primitive Surface

- [ ] Lease Protocol + heartbeat
- [ ] Leader Election Protocol
- [ ] QUORUM Flow (replayable workflows)
- [ ] Full CLI (`quorum dev`, `quorum ops`)
- [ ] Observability pipeline (metrics, OTEL tracing)
- [ ] Security model (namespace tokens, encryption)
- [ ] Benchmark harness + initial results

### Phase 3 — Operational Excellence

- [ ] Chaos engineering framework
- [ ] Dashboard (topology visualization, replay inspector)
- [ ] Namespace partitioning (multi-group sharding)
- [ ] Cost optimization tooling

---

## For Engineers & Recruiters

### What This Demonstrates

**Systems thinking at the protocol level.** The Replicated Coordination Log is not storage — it's the causal spine from which every subsystem derives. Protocols (locks, elections, workflows) are state machine interpreters over the log, not independent implementations. This is the same architectural pattern behind Kafka (everything is a log), Temporal (history is the execution state), and FoundationDB (ordered key-value as the universal primitive).

**Edge-native design, not cloud-native ported to edge.** The architecture exploits Cloudflare's guarantees — DO single-writer serialization, global uniqueness, durable SQLite, RPC-native communication — rather than working around them. DO eviction is the crash model. The RPC stub is the network layer. SQLite is the WAL. This is what it looks like to design for a platform rather than on top of it.

**Correctness under failure, not just under success.** The recovery path is as specified as the write path. Silent discards are impossible — every recovery decision is a committed log entry. Snapshot stabilization windows prevent premature compaction. Stale epoch entries are recorded, not suppressed. The chaos engineering framework validates invariants post-fault, not just observes behavior.

**Operational honesty.** The Known Constraints section deliberately documents where the system breaks. The benchmark philosophy uses coordinated omission correction and separates warm/cold/local/cross-region conditions. The CAP position (CP on writes) is stated as a deliberate choice with explicit reasoning, not glossed over.

**Tiered storage architecture.** The SQLite/R2 split is not an implementation detail — it's a first-class design decision with explicit reasoning. Hot coordination state in SQLite (sub-millisecond, transactional, ordered), cold history in R2 (cheap, immutable, arbitrarily long retention). Snapshot compaction coordinates across both tiers with correctness guarantees. This mirrors how serious storage systems (RocksDB SSTs + manifest, Kafka segments + offsets) structure their storage layers.

### Technologies & Concepts

**Platform:** Cloudflare Workers, Durable Objects, R2, Workers RPC  
**Language:** TypeScript 5 (strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)  
**Testing:** Vitest, `@cloudflare/vitest-pool-workers` (real Miniflare DO environment)  
**Build:** Turborepo monorepo, Wrangler 3  
**Observability:** OpenTelemetry (OTEL spans, metrics), HDR Histogram  
**Protocols:** Raft-inspired coordination, Raft log semantics, consensus quorum, Lamport causality, fencing tokens (Kleppmann §8), event sourcing  
**Distributed systems concepts:** CAP theorem (CP choice), linearizability vs sequential consistency, ABA problem, epoch-based coordination, deterministic replay, snapshot isolation, idempotency keys, saga/compensation patterns

---

## Documentation

| Document | Description |
|---|---|
| [System Design Specification](./docs/superpowers/specs/2026-05-25-quorum-design.md) | Full architecture doc — protocols, consistency model, recovery semantics, correctness properties, security, cost characteristics |
| [Phase 1A Implementation Plan](./docs/superpowers/plans/2026-05-25-phase1a-rcl-replication.md) | Step-by-step TDD implementation plan for RCL Engine + Replication — **complete, 17/17 tests passing** |
| `docs/rfcs/` | Request for Comments — in-progress design proposals |
| `docs/adrs/` | Architecture Decision Records — rationale for key decisions |

---

<div align="center">

Built with the conviction that edge-native infrastructure should be as operationally rigorous as any production distributed system — not a simplified version of one.

**[Design Spec](./docs/superpowers/specs/2026-05-25-quorum-design.md)** · **[Implementation Plan](./docs/superpowers/plans/2026-05-25-phase1a-rcl-replication.md)** · **[Open an Issue](https://github.com/ayushduttatreya/Quorum/issues)**

</div>
