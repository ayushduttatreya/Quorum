# QUORUM Phase 1A — Monorepo, RCL Engine & Replication

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working replicated coordination log — append, quorum commit, fan-out replication to ReplicaDOs, and gap-fill recovery — fully tested in a Vitest + Miniflare environment.

**Architecture:** Turborepo monorepo with `packages/types`, `packages/runtime`, `packages/protocol`. The `CoordinationRuntimeDO` owns a SQLite-backed RCL Engine and fans out replication RPCs to `ReplicaDO` instances. A `CommitCoordinator` collects quorum ACKs (⌊N/2⌋+1) before advancing the commit index. All code is TypeScript strict mode.

**Tech Stack:** TypeScript 5, Turborepo, Cloudflare Workers, Durable Objects (SQLite storage), Vitest, `@cloudflare/vitest-pool-workers`, Wrangler 3.

---

## File Map

```
/
├── package.json                          # root workspace
├── turbo.json                            # turborepo pipeline
├── tsconfig.base.json                    # shared tsconfig
├── wrangler.toml                         # workers + DO bindings
├── packages/
│   ├── types/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # re-exports
│   │       ├── log-entry.ts              # LogEntry, CommittedEntry types
│   │       ├── replication.ts            # AppendEntriesRequest/Response, ReplicaAck
│   │       └── errors.ts                 # QuorumError, RecoveringError, etc.
│   └── runtime/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── rcl/
│           │   ├── rcl-engine.ts         # append, sequence alloc, SQLite schema
│           │   └── rcl-engine.test.ts
│           ├── commit/
│           │   ├── commit-coordinator.ts # quorum tracking, commit index
│           │   └── commit-coordinator.test.ts
│           ├── replication/
│           │   ├── replication-manager.ts # fan-out, health tracking, gap-fill
│           │   ├── replication-manager.test.ts
│           │   └── replica-do.ts         # ReplicaDO class
│           └── replica-do.test.ts
```

---

## Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `packages/types/package.json`
- Create: `packages/types/tsconfig.json`
- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/vitest.config.ts`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "quorum",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "turbo typecheck"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Create packages/types/package.json**

```json
{
  "name": "@quorum/types",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "*"
  }
}
```

- [ ] **Step 5: Create packages/types/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 6: Create packages/runtime/package.json**

```json
{
  "name": "@quorum/runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@quorum/types": "*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.0.0",
    "vitest": "^1.6.0",
    "wrangler": "^3.60.0",
    "typescript": "*"
  }
}
```

- [ ] **Step 7: Create packages/runtime/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 8: Create packages/runtime/vitest.config.ts**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wranglerConfigPath: "../../wrangler.toml",
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
```

- [ ] **Step 9: Create root wrangler.toml**

```toml
name = "quorum-runtime"
main = "packages/runtime/src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "COORDINATION_RUNTIME"
class_name = "CoordinationRuntimeDO"

[[durable_objects.bindings]]
name = "REPLICA"
class_name = "ReplicaDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CoordinationRuntimeDO", "ReplicaDO"]
```

- [ ] **Step 10: Install dependencies**

Run from repo root:
```bash
npm install
```

Expected: workspace packages resolved, node_modules created.

---

## Task 2: Shared Types

**Files:**
- Create: `packages/types/src/log-entry.ts`
- Create: `packages/types/src/replication.ts`
- Create: `packages/types/src/errors.ts`
- Create: `packages/types/src/index.ts`

- [ ] **Step 1: Create log-entry.ts**

```ts
// packages/types/src/log-entry.ts

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
  | "ENTRY_STALE_EPOCH_DISCARDED";

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
```

- [ ] **Step 2: Create replication.ts**

```ts
// packages/types/src/replication.ts

export interface AppendEntriesRequest {
  entries: import("./log-entry.ts").LogEntry[];
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
```

- [ ] **Step 3: Create errors.ts**

```ts
// packages/types/src/errors.ts

export class QuorumError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QuorumError";
  }
}

export class RecoveringError extends QuorumError {
  constructor() {
    super("RUNTIME_RECOVERING", "Runtime is in RECOVERING state — writes rejected");
  }
}

export class QuorumUnavailableError extends QuorumError {
  constructor(public readonly reachable: number, public readonly required: number) {
    super(
      "QUORUM_UNAVAILABLE",
      `Quorum unavailable: ${reachable}/${required} replicas reachable`,
      { reachable, required },
    );
  }
}

export class IdempotentResultError extends QuorumError {
  constructor(public readonly originalSeq: number) {
    super("IDEMPOTENT_RESULT", "Duplicate idempotency key — returning original result", {
      originalSeq,
    });
  }
}

export class EpochMismatchError extends QuorumError {
  constructor(public readonly expected: number, public readonly actual: number) {
    super("EPOCH_MISMATCH", `Epoch mismatch: expected ${expected}, got ${actual}`, {
      expected,
      actual,
    });
  }
}
```

- [ ] **Step 4: Create index.ts**

```ts
// packages/types/src/index.ts
export * from "./log-entry.ts";
export * from "./replication.ts";
export * from "./errors.ts";
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/types && npx tsc --noEmit
```

Expected: no errors.

---

## Task 3: RCL Engine

**Files:**
- Create: `packages/runtime/src/rcl/rcl-engine.ts`
- Create: `packages/runtime/src/rcl/rcl-engine.test.ts`

The RCL Engine owns the SQLite schema, sequence allocation, and log persistence. It does NOT drive replication or commit advancement — those belong to the Commit Coordinator and Replication Manager respectively.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runtime/src/rcl/rcl-engine.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { LogEntryInput } from "@quorum/types";

const TEST_INPUT: LogEntryInput = {
  protocol: "SYSTEM",
  protocolVersion: 1,
  operation: "CLUSTER_INITIALIZED",
  resourceKey: "cluster",
  payload: { config: { replicaCount: 3 } },
  idempotencyKey: "idem-001",
  traceId: "trace-001",
  clientId: "client-001",
};

describe("RclEngine", () => {
  it("initializes schema on first use", async () => {
    await runInDurableObject(env.COORDINATION_RUNTIME, async (instance) => {
      const { RclEngine } = await import("./rcl-engine.ts");
      const engine = new RclEngine((instance as any).ctx.storage.sql);
      engine.initialize();
      const entries = engine.getEntries({ fromSeq: 0, limit: 10 });
      expect(entries).toEqual([]);
    });
  });

  it("appends an entry and returns seq=1", async () => {
    await runInDurableObject(env.COORDINATION_RUNTIME, async (instance) => {
      const { RclEngine } = await import("./rcl-engine.ts");
      const engine = new RclEngine((instance as any).ctx.storage.sql);
      engine.initialize();
      const entry = engine.append({ input: TEST_INPUT, term: 1, epoch: 1 });
      expect(entry.seq).toBe(1);
      expect(entry.committed).toBe(false);
      expect(entry.checksum).toBeTruthy();
    });
  });

  it("rejects duplicate idempotency key", async () => {
    await runInDurableObject(env.COORDINATION_RUNTIME, async (instance) => {
      const { RclEngine } = await import("./rcl-engine.ts");
      const { IdempotentResultError } = await import("@quorum/types");
      const engine = new RclEngine((instance as any).ctx.storage.sql);
      engine.initialize();
      engine.append({ input: TEST_INPUT, term: 1, epoch: 1 });
      expect(() =>
        engine.append({ input: TEST_INPUT, term: 1, epoch: 1 }),
      ).toThrow(IdempotentResultError);
    });
  });

  it("marks entry committed by seq", async () => {
    await runInDurableObject(env.COORDINATION_RUNTIME, async (instance) => {
      const { RclEngine } = await import("./rcl-engine.ts");
      const engine = new RclEngine((instance as any).ctx.storage.sql);
      engine.initialize();
      const entry = engine.append({ input: TEST_INPUT, term: 1, epoch: 1 });
      engine.markCommitted(entry.seq, "COMMITTED");
      const [committed] = engine.getEntries({ fromSeq: 0, limit: 1 });
      expect(committed?.committed).toBe(true);
    });
  });

  it("getUncommitted returns only uncommitted entries", async () => {
    await runInDurableObject(env.COORDINATION_RUNTIME, async (instance) => {
      const { RclEngine } = await import("./rcl-engine.ts");
      const engine = new RclEngine((instance as any).ctx.storage.sql);
      engine.initialize();
      const e1 = engine.append({ input: TEST_INPUT, term: 1, epoch: 1 });
      const e2 = engine.append({
        input: { ...TEST_INPUT, idempotencyKey: "idem-002" },
        term: 1,
        epoch: 1,
      });
      engine.markCommitted(e1.seq, "COMMITTED");
      const uncommitted = engine.getUncommitted();
      expect(uncommitted).toHaveLength(1);
      expect(uncommitted[0]?.seq).toBe(e2.seq);
    });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/runtime && npx vitest run src/rcl/rcl-engine.test.ts
```

Expected: FAIL — `Cannot find module './rcl-engine.ts'`

- [ ] **Step 3: Implement RclEngine**

```ts
// packages/runtime/src/rcl/rcl-engine.ts
import type { LogEntry, LogEntryInput, Outcome } from "@quorum/types";
import { IdempotentResultError } from "@quorum/types";

interface AppendOptions {
  input: LogEntryInput;
  term: number;
  epoch: number;
}

interface GetEntriesOptions {
  fromSeq: number;
  limit: number;
  resourceKey?: string;
}

export class RclEngine {
  constructor(private readonly sql: SqlStorage) {}

  initialize(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_entries (
        seq              INTEGER PRIMARY KEY AUTOINCREMENT,
        term             INTEGER NOT NULL,
        epoch            INTEGER NOT NULL,
        wall_clock_ts    INTEGER NOT NULL,
        protocol         TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        operation        TEXT NOT NULL,
        resource_key     TEXT NOT NULL,
        payload          TEXT NOT NULL,
        checksum         TEXT NOT NULL,
        committed        INTEGER NOT NULL DEFAULT 0,
        outcome          TEXT,
        idempotency_key  TEXT NOT NULL,
        trace_id         TEXT NOT NULL,
        client_id        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
        ON log_entries(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_resource_key
        ON log_entries(resource_key);
      CREATE INDEX IF NOT EXISTS idx_uncommitted
        ON log_entries(committed, seq) WHERE committed = 0;
    `);
  }

  append(opts: AppendOptions): LogEntry {
    const { input, term, epoch } = opts;
    const existing = this.sql
      .exec(
        "SELECT seq FROM log_entries WHERE idempotency_key = ?",
        input.idempotencyKey,
      )
      .one();
    if (existing) {
      throw new IdempotentResultError(existing.seq as number);
    }

    const wallClockTs = Date.now();
    const payloadJson = JSON.stringify(input.payload);
    const checksum = this.computeChecksum({
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      operation: input.operation,
      resourceKey: input.resourceKey,
      payload: payloadJson,
      term,
      epoch,
      wallClockTs,
    });

    this.sql.exec(
      `INSERT INTO log_entries
        (term, epoch, wall_clock_ts, protocol, protocol_version, operation,
         resource_key, payload, checksum, committed, idempotency_key, trace_id, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      term,
      epoch,
      wallClockTs,
      input.protocol,
      input.protocolVersion,
      input.operation,
      input.resourceKey,
      payloadJson,
      checksum,
      input.idempotencyKey,
      input.traceId,
      input.clientId,
    );

    const row = this.sql
      .exec("SELECT seq FROM log_entries WHERE idempotency_key = ?", input.idempotencyKey)
      .one();

    return {
      seq: row!.seq as number,
      term,
      epoch,
      wallClockTs,
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      operation: input.operation,
      resourceKey: input.resourceKey,
      payload: input.payload,
      checksum,
      committed: false,
      idempotencyKey: input.idempotencyKey,
      traceId: input.traceId,
      clientId: input.clientId,
    };
  }

  markCommitted(seq: number, outcome: Outcome): void {
    this.sql.exec(
      "UPDATE log_entries SET committed = 1, outcome = ? WHERE seq = ?",
      outcome,
      seq,
    );
  }

  getEntries(opts: GetEntriesOptions): LogEntry[] {
    const { fromSeq, limit, resourceKey } = opts;
    const cursor = resourceKey
      ? this.sql.exec(
          "SELECT * FROM log_entries WHERE seq >= ? AND resource_key = ? ORDER BY seq LIMIT ?",
          fromSeq,
          resourceKey,
          limit,
        )
      : this.sql.exec(
          "SELECT * FROM log_entries WHERE seq >= ? ORDER BY seq LIMIT ?",
          fromSeq,
          limit,
        );
    return [...cursor].map((r) => this.rowToEntry(r));
  }

  getUncommitted(): LogEntry[] {
    const cursor = this.sql.exec(
      "SELECT * FROM log_entries WHERE committed = 0 ORDER BY seq",
    );
    return [...cursor].map((r) => this.rowToEntry(r));
  }

  getLatestSeq(): number {
    const row = this.sql.exec("SELECT MAX(seq) as max_seq FROM log_entries").one();
    return (row?.max_seq as number | null) ?? 0;
  }

  getLatestChecksum(): string {
    const row = this.sql
      .exec("SELECT checksum FROM log_entries ORDER BY seq DESC LIMIT 1")
      .one();
    return (row?.checksum as string | null) ?? "";
  }

  deleteUpTo(seq: number): void {
    this.sql.exec("DELETE FROM log_entries WHERE seq <= ?", seq);
  }

  private rowToEntry(row: Record<string, unknown>): LogEntry {
    return {
      seq: row["seq"] as number,
      term: row["term"] as number,
      epoch: row["epoch"] as number,
      wallClockTs: row["wall_clock_ts"] as number,
      protocol: row["protocol"] as LogEntry["protocol"],
      protocolVersion: row["protocol_version"] as number,
      operation: row["operation"] as LogEntry["operation"],
      resourceKey: row["resource_key"] as string,
      payload: JSON.parse(row["payload"] as string) as Record<string, unknown>,
      checksum: row["checksum"] as string,
      committed: (row["committed"] as number) === 1,
      idempotencyKey: row["idempotency_key"] as string,
      traceId: row["trace_id"] as string,
      clientId: row["client_id"] as string,
    };
  }

  private computeChecksum(data: Record<string, unknown>): string {
    // Deterministic checksum using a stable JSON serialization
    // In production this should be SHA-256; using a simple hash for now
    const str = JSON.stringify(data, Object.keys(data).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/runtime && npx vitest run src/rcl/rcl-engine.test.ts
```

Expected: 5 tests PASS.

---

## Task 4: Commit Coordinator

**Files:**
- Create: `packages/runtime/src/commit/commit-coordinator.ts`
- Create: `packages/runtime/src/commit/commit-coordinator.test.ts`

The Commit Coordinator tracks quorum ACKs in memory. It does not touch SQLite — the RCL Engine handles persistence. Once ⌊N/2⌋+1 ACKs are received for a seq, it invokes a callback and the RCL Engine can mark the entry committed.

- [ ] **Step 1: Write failing tests**

```ts
// packages/runtime/src/commit/commit-coordinator.test.ts
import { describe, it, expect, vi } from "vitest";
import { CommitCoordinator } from "./commit-coordinator.ts";

describe("CommitCoordinator", () => {
  it("does not commit with insufficient ACKs (2-of-3, only 1 ACK)", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits when kernel + 1 replica ACK (2-of-3 quorum)", () => {
    const onCommit = vi.fn();
    // replicaCount=2 means kernel(1) + 2 replicas → quorum = floor(3/2)+1 = 2
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    // kernel counts as 1 ACK implicitly — record replica ACK
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).toHaveBeenCalledWith(1, "r1");
  });

  it("does not double-commit same seq", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r2" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("tracks commit index monotonically", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    coord.recordAck(2, { seq: 2, epoch: 1, checksum: "xyz", snapshotBase: 0, replicaId: "r1" });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    // commits should happen in seq order when both have quorum
    expect(coord.getCommitIndex()).toBe(2);
  });

  it("rejects ACK with stale epoch", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit, currentEpoch: 3 });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/runtime && npx vitest run src/commit/commit-coordinator.test.ts
```

Expected: FAIL — `Cannot find module './commit-coordinator.ts'`

- [ ] **Step 3: Implement CommitCoordinator**

```ts
// packages/runtime/src/commit/commit-coordinator.ts
import type { ReplicaAck } from "@quorum/types";

interface CommitCoordinatorOptions {
  replicaCount: number;
  onCommit: (seq: number, replicaId: string) => void;
  currentEpoch?: number;
}

export class CommitCoordinator {
  // kernel always counts as 1 — quorum = floor((replicaCount+1)/2)+1
  private readonly quorumSize: number;
  private readonly acks = new Map<number, Set<string>>();
  private readonly committed = new Set<number>();
  private commitIndex = 0;
  private currentEpoch: number;

  constructor(private readonly opts: CommitCoordinatorOptions) {
    const total = opts.replicaCount + 1; // +1 for kernel
    this.quorumSize = Math.floor(total / 2) + 1;
    this.currentEpoch = opts.currentEpoch ?? 1;
  }

  recordAck(seq: number, ack: ReplicaAck): void {
    if (ack.epoch < this.currentEpoch) return; // stale epoch — discard

    if (!this.acks.has(seq)) {
      this.acks.set(seq, new Set(["__kernel__"])); // kernel implicit ACK
    }
    this.acks.get(seq)!.add(ack.replicaId);

    const ackCount = this.acks.get(seq)!.size;
    if (ackCount >= this.quorumSize && !this.committed.has(seq)) {
      this.committed.add(seq);
      if (seq > this.commitIndex) {
        this.commitIndex = seq;
      }
      this.acks.delete(seq);
      this.opts.onCommit(seq, ack.replicaId);
    }
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  advanceEpoch(epoch: number): void {
    if (epoch > this.currentEpoch) {
      this.currentEpoch = epoch;
    }
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/runtime && npx vitest run src/commit/commit-coordinator.test.ts
```

Expected: 5 tests PASS.

---

## Task 5: ReplicaDO

**Files:**
- Create: `packages/runtime/src/replication/replica-do.ts`
- Create: `packages/runtime/src/replica-do.test.ts`

`ReplicaDO` is a Durable Object that accepts `appendEntries` RPCs, validates lineage, persists entries, and returns a typed `AppendEntriesResponse`.

- [ ] **Step 1: Write failing tests**

```ts
// packages/runtime/src/replica-do.test.ts
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { AppendEntriesRequest, LogEntry } from "@quorum/types";

function makeEntry(seq: number, checksum: string, prevChecksum = ""): LogEntry {
  return {
    seq,
    term: 1,
    epoch: 1,
    wallClockTs: Date.now(),
    protocol: "SYSTEM",
    protocolVersion: 1,
    operation: "CLUSTER_INITIALIZED",
    resourceKey: "cluster",
    payload: {},
    checksum,
    committed: true,
    idempotencyKey: `idem-${seq}`,
    traceId: "trace-001",
    clientId: "kernel",
  };
}

describe("ReplicaDO", () => {
  it("accepts first entry when prevSeq=0 and prevChecksum=''", async () => {
    await runInDurableObject(env.REPLICA, async (instance) => {
      const { ReplicaDO } = await import("./replication/replica-do.ts");
      const replica = instance as unknown as ReplicaDO;
      const req: AppendEntriesRequest = {
        entries: [makeEntry(1, "abc123")],
        leaderEpoch: 1,
        prevSeq: 0,
        prevChecksum: "",
        namespaceId: "test",
      };
      const res = await replica.appendEntries(req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.ack.seq).toBe(1);
      }
    });
  });

  it("returns GAP_DETECTED when prevSeq does not match tail", async () => {
    await runInDurableObject(env.REPLICA, async (instance) => {
      const { ReplicaDO } = await import("./replication/replica-do.ts");
      const replica = instance as unknown as ReplicaDO;
      const req: AppendEntriesRequest = {
        entries: [makeEntry(5, "xyz")],
        leaderEpoch: 1,
        prevSeq: 4,
        prevChecksum: "prev",
        namespaceId: "test",
      };
      const res = await replica.appendEntries(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("GAP_DETECTED");
      }
    });
  });

  it("returns STALE_EPOCH when leaderEpoch is less than replica epoch", async () => {
    await runInDurableObject(env.REPLICA, async (instance) => {
      const { ReplicaDO } = await import("./replication/replica-do.ts");
      const replica = instance as unknown as ReplicaDO;
      // First establish epoch 3
      await replica.appendEntries({
        entries: [makeEntry(1, "aaa")],
        leaderEpoch: 3,
        prevSeq: 0,
        prevChecksum: "",
        namespaceId: "test",
      });
      // Now send with stale epoch 1
      const res = await replica.appendEntries({
        entries: [makeEntry(2, "bbb")],
        leaderEpoch: 1,
        prevSeq: 1,
        prevChecksum: "aaa",
        namespaceId: "test",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("STALE_EPOCH");
      }
    });
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/runtime && npx vitest run src/replica-do.test.ts
```

Expected: FAIL — `Cannot find module './replication/replica-do.ts'`

- [ ] **Step 3: Implement ReplicaDO**

```ts
// packages/runtime/src/replication/replica-do.ts
import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  LogEntry,
} from "@quorum/types";

export class ReplicaDO {
  private readonly sql: SqlStorage;
  private lastEpoch = 0;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS replica_log (
        seq           INTEGER PRIMARY KEY,
        epoch         INTEGER NOT NULL,
        checksum      TEXT NOT NULL,
        entry_json    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_epoch ON replica_log(epoch);
    `);
  }

  async appendEntries(req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    const replicaId = this.state.id.toString();

    // Stale epoch check
    if (req.leaderEpoch < this.lastEpoch) {
      return { ok: false, reason: "STALE_EPOCH", replicaEpoch: this.lastEpoch };
    }
    this.lastEpoch = Math.max(this.lastEpoch, req.leaderEpoch);

    // Gap detection
    const tail = this.getTailSeq();
    if (req.prevSeq !== tail) {
      return { ok: false, reason: "GAP_DETECTED", lastKnownSeq: tail };
    }

    // Checksum validation on prevSeq
    if (req.prevSeq > 0) {
      const prevRow = this.sql
        .exec("SELECT checksum FROM replica_log WHERE seq = ?", req.prevSeq)
        .one();
      if (!prevRow || (prevRow.checksum as string) !== req.prevChecksum) {
        return {
          ok: false,
          reason: "CHECKSUM_MISMATCH",
          expectedChecksum: (prevRow?.checksum as string) ?? "",
        };
      }
    }

    // Persist entries
    let lastEntry: LogEntry | undefined;
    for (const entry of req.entries) {
      this.sql.exec(
        "INSERT OR IGNORE INTO replica_log (seq, epoch, checksum, entry_json) VALUES (?, ?, ?, ?)",
        entry.seq,
        entry.epoch,
        entry.checksum,
        JSON.stringify(entry),
      );
      lastEntry = entry;
    }

    if (!lastEntry) {
      return { ok: false, reason: "GAP_DETECTED", lastKnownSeq: tail };
    }

    const snapshotBase = this.getSnapshotBase();

    return {
      ok: true,
      ack: {
        seq: lastEntry.seq,
        epoch: req.leaderEpoch,
        checksum: lastEntry.checksum,
        snapshotBase,
        replicaId,
      },
    };
  }

  private getTailSeq(): number {
    const row = this.sql.exec("SELECT MAX(seq) as tail FROM replica_log").one();
    return (row?.tail as number | null) ?? 0;
  }

  private getSnapshotBase(): number {
    const row = this.sql.exec("SELECT MIN(seq) as base FROM replica_log").one();
    return (row?.base as number | null) ?? 0;
  }

  async fetch(_req: Request): Promise<Response> {
    return new Response("ReplicaDO", { status: 200 });
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/runtime && npx vitest run src/replica-do.test.ts
```

Expected: 3 tests PASS.

---

## Task 6: Replication Manager

**Files:**
- Create: `packages/runtime/src/replication/replication-manager.ts`
- Create: `packages/runtime/src/replication/replication-manager.test.ts`

The Replication Manager fans out `appendEntries` RPCs in parallel to all registered replicas, collects `AppendEntriesResponse` objects, feeds ACKs to the `CommitCoordinator`, and handles health tracking.

- [ ] **Step 1: Write failing tests**

```ts
// packages/runtime/src/replication/replication-manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReplicationManager } from "./replication-manager.ts";
import type { AppendEntriesResponse, LogEntry, ReplicaHealthRecord } from "@quorum/types";

function makeEntry(seq: number): LogEntry {
  return {
    seq,
    term: 1,
    epoch: 1,
    wallClockTs: Date.now(),
    protocol: "SYSTEM",
    protocolVersion: 1,
    operation: "CLUSTER_INITIALIZED",
    resourceKey: "cluster",
    payload: {},
    checksum: `chk-${seq}`,
    committed: false,
    idempotencyKey: `idem-${seq}`,
    traceId: "trace-001",
    clientId: "kernel",
  };
}

function makeMockReplica(response: AppendEntriesResponse) {
  return { appendEntries: vi.fn().mockResolvedValue(response) };
}

describe("ReplicationManager", () => {
  it("calls appendEntries on all replicas", async () => {
    const r1 = makeMockReplica({ ok: true, ack: { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r1" } });
    const r2 = makeMockReplica({ ok: true, ack: { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r2" } });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);
    mgr.registerReplica("r2", r2 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    expect(r1.appendEntries).toHaveBeenCalledTimes(1);
    expect(r2.appendEntries).toHaveBeenCalledTimes(1);
  });

  it("calls onAck with successful ACKs", async () => {
    const ack = { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r1" };
    const r1 = makeMockReplica({ ok: true, ack });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    expect(onAck).toHaveBeenCalledWith(1, ack);
  });

  it("increments consecutiveFailures on replica error", async () => {
    const r1 = makeMockReplica({ ok: false, reason: "GAP_DETECTED", lastKnownSeq: 0 });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    const health = mgr.getHealth("r1");
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.health).toBe("active"); // not yet degraded (threshold is 3)
  });

  it("marks replica DEGRADED after 3 consecutive failures", async () => {
    const r1 = makeMockReplica({ ok: false, reason: "GAP_DETECTED", lastKnownSeq: 0 });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    for (let i = 0; i < 3; i++) {
      await mgr.replicate({ entries: [makeEntry(i + 1)], leaderEpoch: 1, prevSeq: i, prevChecksum: "" });
    }

    const health = mgr.getHealth("r1");
    expect(health?.health).toBe("degraded");
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd packages/runtime && npx vitest run src/replication/replication-manager.test.ts
```

Expected: FAIL — `Cannot find module './replication-manager.ts'`

- [ ] **Step 3: Implement ReplicationManager**

```ts
// packages/runtime/src/replication/replication-manager.ts
import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  ReplicaAck,
  ReplicaHealthRecord,
} from "@quorum/types";

interface ReplicaStub {
  appendEntries(req: AppendEntriesRequest): Promise<AppendEntriesResponse>;
}

interface ReplicateOptions {
  entries: import("@quorum/types").LogEntry[];
  leaderEpoch: number;
  prevSeq: number;
  prevChecksum: string;
}

interface ReplicationManagerOptions {
  namespaceId: string;
  onAck: (seq: number, ack: ReplicaAck) => void;
  degradeThreshold?: number;
  maxLagSeq?: number;
}

export class ReplicationManager {
  private readonly replicas = new Map<string, ReplicaStub>();
  private readonly health = new Map<string, ReplicaHealthRecord>();
  private readonly degradeThreshold: number;

  constructor(private readonly opts: ReplicationManagerOptions) {
    this.degradeThreshold = opts.degradeThreshold ?? 3;
  }

  registerReplica(replicaId: string, stub: ReplicaStub): void {
    this.replicas.set(replicaId, stub);
    this.health.set(replicaId, {
      replicaId,
      lastAckedSeq: 0,
      lastAckedEpoch: 0,
      health: "active",
      consecutiveFailures: 0,
    });
  }

  async replicate(opts: ReplicateOptions): Promise<void> {
    const req: AppendEntriesRequest = {
      entries: opts.entries,
      leaderEpoch: opts.leaderEpoch,
      prevSeq: opts.prevSeq,
      prevChecksum: opts.prevChecksum,
      namespaceId: this.opts.namespaceId,
    };

    const calls = [...this.replicas.entries()].map(async ([replicaId, stub]) => {
      try {
        const res = await stub.appendEntries(req);
        this.handleResponse(replicaId, res);
      } catch {
        this.recordFailure(replicaId);
      }
    });

    await Promise.allSettled(calls);
  }

  getHealth(replicaId: string): ReplicaHealthRecord | undefined {
    return this.health.get(replicaId);
  }

  getAllHealth(): ReplicaHealthRecord[] {
    return [...this.health.values()];
  }

  private handleResponse(replicaId: string, res: AppendEntriesResponse): void {
    const record = this.health.get(replicaId);
    if (!record) return;

    if (res.ok) {
      record.consecutiveFailures = 0;
      record.health = "active";
      record.lastAckedSeq = res.ack.seq;
      record.lastAckedEpoch = res.ack.epoch;
      this.opts.onAck(res.ack.seq, res.ack);
    } else {
      this.recordFailure(replicaId);
    }
  }

  private recordFailure(replicaId: string): void {
    const record = this.health.get(replicaId);
    if (!record) return;
    record.consecutiveFailures += 1;
    if (record.consecutiveFailures >= this.degradeThreshold) {
      record.health = "degraded";
    }
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd packages/runtime && npx vitest run src/replication/replication-manager.test.ts
```

Expected: 4 tests PASS.

---

## Task 7: Full Suite + Typecheck

- [ ] **Step 1: Run all tests**

```bash
cd packages/runtime && npx vitest run
```

Expected: All tests PASS (RclEngine: 5, CommitCoordinator: 5, ReplicaDO: 3, ReplicationManager: 4 = 17 total).

- [ ] **Step 2: Typecheck all packages**

```bash
cd packages/types && npx tsc --noEmit
cd packages/runtime && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Verify the RCL invariant is enforced**

Manually confirm:
- `rcl-engine.test.ts`: duplicate idempotency key throws `IdempotentResultError` ✓
- `commit-coordinator.test.ts`: stale epoch ACK is silently ignored ✓
- `replica-do.test.ts`: `GAP_DETECTED` returned when prevSeq doesn't match tail ✓
- `replication-manager.test.ts`: failure threshold marks replica `degraded` ✓

These four checks are the core safety properties from §15 of the spec translated into test assertions.

---

## What Plan B Covers

Plan 1A ends here — a working replicated log with quorum commits, tested in isolation. Plan 1B will build on top:

- Lock Protocol executor (§6.1) + Protocol Registry
- CoordinationRuntimeDO assembling all components
- Replay Engine (deterministic replayer)
- Snapshot Manager (SQLite → R2 compaction)
- Recovery semantics (RECOVERING mode, UNCOMMITTED scan)
- `quorum dev determinism-check` harness
- SDK entry point (`quorum.lock()`)
