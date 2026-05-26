# QUORUM Phase 1B — Lock Protocol + CoordinationRuntimeDO Assembly

**Date:** 2026-05-26
**Status:** Approved — Ready for Implementation
**Depends on:** Phase 1A (RclEngine, CommitCoordinator, ReplicationManager, ReplicaDO — all complete, 17/17 tests passing)

---

## Scope

Phase 1B wires the coordination kernel into a working end-to-end write path. After this phase, `CoordinationRuntimeDO.coordinate()` accepts a `LogEntryInput`, runs it through the full commit pipeline (validate → replicate → quorum commit → apply state machine), and returns a `CommittedEntry`. `fetch()` exposes this over a minimal HTTP interface for manual testing.

**Out of scope for Phase 1B:** Replay Engine, Snapshot Manager, recovery semantics, SDK entry point, Lease/Election/Workflow protocols. Those are Phase 1C.

---

## Task Breakdown

### Task 1: LockProtocol

**File:** `packages/protocol/src/lock.ts`

Fills in the four stub methods on the existing `LockProtocol` class.

#### State

```ts
export interface LockState {
  locks: Record<string, {
    holder: string;
    fencingToken: bigint;
    expiresAt: number;
    acquiredSeq: number;
  }>;
}
```

#### `validate(input, state): ValidationResult`

Routes on `input.operation`:

**`LOCK_ACQUIRE`**
- Payload shape: `{ ttl: number }` (milliseconds)
- If no entry for `input.resourceKey`, or entry exists but `expiresAt < wallClockTs` from `input.payload.wallClockTs ?? Date.now()`: return `{ valid: true, outcome: "COMMITTED" }`
- Otherwise (locked, not expired): return `{ valid: false, outcome: "REJECTED", reason: "LOCK_HELD" }`

**`LOCK_RELEASE`**
- Payload shape: `{ fencingToken: string }` (bigint serialized as string)
- If lock exists and `BigInt(payload.fencingToken) === state.locks[resourceKey].fencingToken`: return `{ valid: true, outcome: "COMMITTED" }`
- Otherwise: return `{ valid: false, outcome: "REJECTED", reason: "TOKEN_MISMATCH" }`

**`LOCK_EXPIRE`**
- Always `{ valid: true, outcome: "COMMITTED" }` — called internally, not from SDK

**Unknown operation:** throw `Error("unknown lock operation: ...")`

#### `apply(entry, state): LockState`

Routes on `entry.operation`. Returns a new `LockState` (never mutates in place):

**`LOCK_ACQUIRE`** with `entry.outcome === "COMMITTED"`:
```ts
fencingToken = (BigInt(entry.term) << 32n) | BigInt(entry.seq)
locks[entry.resourceKey] = { holder: entry.clientId, fencingToken, expiresAt, acquiredSeq: entry.seq }
```
`expiresAt = entry.wallClockTs + (entry.payload.ttl as number)`

**`LOCK_RELEASE`** or **`LOCK_EXPIRE`** with `outcome === "COMMITTED"`:
```ts
delete locks[entry.resourceKey]
```

**`REJECTED` entries of any operation:** state unchanged — rejections are causal history, not state transitions.

#### `serializeSnapshot(state): SnapshotSlice`

```ts
const data = new TextEncoder().encode(JSON.stringify(state))
const checksum = simpleHash(data)  // same djb2-style hash as RclEngine
return { protocol: "LOCK", version: 1, data, checksum }
```

#### `restoreSnapshot(slice, fromVersion): LockState`

```ts
// version check: only version 1 supported in Phase 1B
if (fromVersion !== 1) throw new SnapshotCompatibilityError(...)
return JSON.parse(new TextDecoder().decode(slice.data)) as LockState
```

#### Tests (`packages/protocol/src/lock.test.ts`)

Pure Vitest — no Durable Objects, no Miniflare.

| Test | Asserts |
|---|---|
| `LOCK_ACQUIRE` on unlocked resource → COMMITTED | `validate` returns COMMITTED; `apply` sets lock state |
| `LOCK_ACQUIRE` on locked, non-expired resource → REJECTED | `validate` returns REJECTED; `apply` leaves state unchanged |
| `LOCK_ACQUIRE` on expired lock → COMMITTED (treated as unlocked) | `validate` returns COMMITTED even though entry exists |
| `LOCK_RELEASE` with correct fencing token → COMMITTED | lock removed from state |
| `LOCK_RELEASE` with wrong fencing token → REJECTED | state unchanged |
| `LOCK_EXPIRE` always → COMMITTED | lock removed from state |
| Snapshot round-trip | `restoreSnapshot(serializeSnapshot(state))` deep-equals original |

---

### Task 2: ProtocolRegistry + FailureDetector

#### ProtocolRegistry (`packages/protocol/src/registry.ts`)

Fills in four stub methods. All other methods (`register`, `getExecutor`) are already implemented.

**`validate(input, states)`**
```ts
const executor = this.getExecutor(input.protocol)
const state = states[input.protocol] ?? executor.initialState()
return executor.validate(input, state)
```

**`apply(entry, states)`**
```ts
const executor = this.getExecutor(entry.protocol)
const state = states[entry.protocol] ?? executor.initialState()
return { ...states, [entry.protocol]: executor.apply(entry, state) }
```

**`serializeAllSnapshots(states)`**
```ts
return [...this.executors.entries()].map(([protocol, executor]) =>
  executor.serializeSnapshot(states[protocol] ?? executor.initialState())
)
```

**`restoreAllSnapshots(slices, protocolVersions)`**
```ts
const states: Record<string, unknown> = {}
for (const slice of slices) {
  const executor = this.getExecutor(slice.protocol)
  const version = protocolVersions[slice.protocol] ?? slice.version
  states[slice.protocol] = executor.restoreSnapshot(slice, version)
}
return states
```

#### FailureDetector (`packages/runtime/src/failure/failure-detector.ts`)

Fills in three stub methods:

**`reportReplicaFailure(replicaId, consecutiveFailures)`**
```ts
if (consecutiveFailures >= this.degradeThreshold) {
  this.emit({ type: "REPLICA_UNRESPONSIVE", replicaId })
}
```
Constructor accepts optional `degradeThreshold` (default 3).

**`reportReplicaRecovery(replicaId)`**
```ts
this.emit({ type: "REPLICA_RECOVERED", replicaId })
```

**`isQuorumReachable(replicaCount, activeCount)`**
```ts
const total = replicaCount + 1  // +1 for kernel
const required = Math.floor(total / 2) + 1
return activeCount + 1 >= required  // +1 for kernel itself
```

#### Tests

**`packages/protocol/src/registry.test.ts`** — pure Vitest:
- Register `LockProtocol`, call `validate` with `LOCK_ACQUIRE` on fresh state → COMMITTED
- `apply` produces updated state with lock entry
- `serializeAllSnapshots` + `restoreAllSnapshots` round-trip preserves state

**`packages/runtime/src/failure/failure-detector.test.ts`** — pure Vitest:
- `reportReplicaFailure` with 2 failures → no event emitted
- `reportReplicaFailure` with 3 failures → `REPLICA_UNRESPONSIVE` emitted
- `reportReplicaRecovery` → `REPLICA_RECOVERED` emitted
- `isQuorumReachable(2, 1)` → true (kernel + 1 replica = 2 = quorum)
- `isQuorumReachable(2, 0)` → false

---

### Task 3: CoordinationRuntimeDO Assembly

**File:** `packages/runtime/src/coordination-runtime-do.ts`

#### Constructor changes

Add `private protocolStates: Record<string, unknown> = {}` — the live materialized state map.

Add `private term = 1` — increments on epoch advance (Phase 1C).

#### `initialize(): Promise<void>`

Wrapped in `this.state.blockConcurrencyWhile(async () => { ... })` to prevent concurrent initialization.

```ts
async initialize(): Promise<void> {
  await this.state.blockConcurrencyWhile(async () => {
    this.rclEngine = new RclEngine(this.state.storage.sql)
    this.rclEngine.initialize()

    this.commitCoordinator = new CommitCoordinator({
      replicaCount: 2,
      currentEpoch: 1,
      onCommit: (seq) => {
        this.rclEngine.markCommitted(seq, "COMMITTED")
      },
    })

    this.replicationManager = new ReplicationManager({
      namespaceId: "default",
      onAck: (seq, ack) => {
        this.commitCoordinator.recordAck(seq, ack)
      },
    })

    // Register replica stubs from env
    const r1Id = this.env.REPLICA.idFromName("replica-1")
    const r2Id = this.env.REPLICA.idFromName("replica-2")
    this.replicationManager.registerReplica("replica-1", this.env.REPLICA.get(r1Id))
    this.replicationManager.registerReplica("replica-2", this.env.REPLICA.get(r2Id))

    this.protocolRegistry = new ProtocolRegistry()
    this.protocolRegistry.register(new LockProtocol())

    this.failureDetector = new FailureDetector()
    this.failureDetector.onFailure((event) => {
      if (event.type === "REPLICA_UNRESPONSIVE") {
        // log only — quorum adjustment is Phase 1C
      }
    })

    this.mode = "ACTIVE"
  })
}
```

`initialize()` is idempotent — if `this.rclEngine` already exists, return immediately.

#### `coordinate(input): Promise<CommittedEntry>`

```ts
async coordinate(input: LogEntryInput): Promise<CommittedEntry> {
  if (this.mode === "RECOVERING") throw new RecoveringError()
  if (!this.rclEngine) await this.initialize()

  // 1. Append uncommitted entry
  const entry = this.rclEngine.append({ input, term: this.term, epoch: 1 })

  // 2. Validate against protocol state
  const validation = this.protocolRegistry.validate(input, this.protocolStates)
  if (!validation.valid) {
    this.rclEngine.markCommitted(entry.seq, "REJECTED")
    const committed: CommittedEntry = { ...entry, committed: true, outcome: "REJECTED" }
    return committed
  }

  // 3. Replicate — prevSeq and prevChecksum from engine
  const prevSeq = entry.seq - 1
  const prevChecksum = prevSeq > 0 ? this.rclEngine.getLatestChecksum() : ""
  await this.replicationManager.replicate({
    entries: [entry],
    leaderEpoch: 1,
    prevSeq,
    prevChecksum,
  })

  // 4. Quorum callback has already fired (synchronous in Miniflare test env)
  //    Mark committed and apply state machine
  this.rclEngine.markCommitted(entry.seq, "COMMITTED")
  this.protocolStates = this.protocolRegistry.apply(
    { ...entry, committed: true, outcome: "COMMITTED" },
    this.protocolStates,
  )

  return { ...entry, committed: true, outcome: "COMMITTED" }
}
```

> **Note on quorum timing:** `replicationManager.replicate()` uses `Promise.allSettled` — it resolves after all replica RPCs complete. The `onAck` → `CommitCoordinator.recordAck` → `onCommit` chain fires within `replicate()` before it returns. So by the time `await this.replicationManager.replicate()` resolves, the quorum callback has already fired and `markCommitted` has been called. The explicit `rclEngine.markCommitted(entry.seq, "COMMITTED")` call after `replicate()` in the code above is therefore a no-op in the happy path but acts as a safety net if quorum wasn't reached (no replicas registered). Phase 1C will replace this with a proper quorum-wait `Promise` that rejects on timeout.

#### `fetch(request): Promise<Response>`

```ts
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === "POST" && url.pathname === "/coordinate") {
    const input = await request.json() as LogEntryInput
    const result = await this.coordinate(input)
    return Response.json(result)
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({
      mode: this.mode,
      commitIndex: this.commitCoordinator?.getCommitIndex() ?? 0,
    })
  }

  return new Response("Not Found", { status: 404 })
}
```

#### Tests (`packages/runtime/src/coordination-runtime-do.test.ts`)

Integration tests via `runInDurableObject`, same `singleWorker + isolatedStorage:false` config as Phase 1A.

| Test | Asserts |
|---|---|
| `LOCK_ACQUIRE` on fresh resource → COMMITTED | `coordinate()` returns `CommittedEntry` with `outcome: "COMMITTED"`, `seq: 1` |
| Second `LOCK_ACQUIRE` on same resource (same client) → REJECTED | returns `outcome: "REJECTED"`, lock state unchanged |
| `GET /health` returns `{ mode: "ACTIVE", commitIndex: 1 }` after one commit | `fetch()` integration |

---

## File Map

```
packages/protocol/
  src/
    lock.ts                          ← implement (stub exists)
    lock.test.ts                     ← create
    registry.ts                      ← implement (stub exists)
    registry.test.ts                 ← create

packages/runtime/
  src/
    coordination-runtime-do.ts       ← implement (stub exists, test helpers from 1A remain)
    coordination-runtime-do.test.ts  ← create
    failure/
      failure-detector.ts            ← implement (stub exists)
      failure-detector.test.ts       ← create
```

---

## Test Count Target

| Suite | Tests |
|---|---|
| `lock.test.ts` | 7 |
| `registry.test.ts` | 3 |
| `failure-detector.test.ts` | 5 |
| `coordination-runtime-do.test.ts` | 3 |
| **Total new** | **18** |
| Phase 1A carried | 17 |
| **Grand total** | **35** |

---

## Key Invariants Validated by Phase 1B

From §15 of the system spec:

- **S2 (Commit index monotonicity):** `CommitCoordinator.getCommitIndex()` never decreases — verified by `coordination-runtime-do.test.ts`
- **S3 (Mutual exclusion):** At most one valid lock holder per `resourceKey` — verified by `lock.test.ts` contention case
- **S4 (Fencing token monotonicity):** `(term << 32n) | seq` is strictly increasing — verified by `lock.test.ts` acquire case
