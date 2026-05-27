import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CoordinationRuntimeDO } from "@quorum/runtime/src/coordination-runtime-do.ts";
import type { LogEntryInput } from "@quorum/types";
import { runAllInvariants, printChaosReport } from "./invariants.ts";

const LOCK_INPUT: LogEntryInput = {
  protocol: "LOCK",
  protocolVersion: 1,
  operation: "LOCK_ACQUIRE",
  resourceKey: "eviction-res",
  payload: { ttl: 60_000 },
  idempotencyKey: "idem-eviction-1",
  traceId: "trace-1",
  clientId: "client-1",
};

describe("Chaos: leader-eviction", () => {
  it("S1 — committed entry survives after simulated eviction + recovery", async () => {
    const doName = "chaos-eviction-1";
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName(doName));

    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;

      // Plant committed entry directly via RCL helpers (no coordinate() yet —
      // mode is still RECOVERING, so initialize() has not run).
      do_.rclInitialize();

      // Append and commit a "pre-crash" entry — seq=1
      const committed = do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "eviction-res", idempotencyKey: "idem-eviction-1" },
        1,
        1,
      );
      const committedSeq = committed.seq;
      do_.rclMarkCommitted(committedSeq, "COMMITTED");

      // Plant an uncommitted entry — simulates crash mid-write before commit
      do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "eviction-res-2", idempotencyKey: "idem-eviction-2" },
        1,
        1,
      );
      expect(do_.rclGetUncommitted()).toHaveLength(1);

      // Now call coordinate() — this triggers initialize() because mode === "RECOVERING".
      // initialize() runs recovery: replays committed log, detects the uncommitted
      // entry, fails re-replication (no live replicas), and commits ENTRY_ROLLBACK.
      const result2 = await do_.coordinate({
        ...LOCK_INPUT,
        resourceKey: "eviction-res-3",
        idempotencyKey: "idem-eviction-3",
      });
      expect(result2.outcome).toBe("COMMITTED");

      const res = await do_.fetch(new Request("http://x/entries?fromSeq=0&limit=100"));
      const entries = await res.json() as any[];

      // S1: original committed entry must still be present and committed
      // Note: GET /entries returns LogEntry (no outcome field) — check committed flag only
      const originalEntry = entries.find((e: any) => e.seq === committedSeq);
      expect(originalEntry).toBeDefined();
      expect(originalEntry.committed).toBe(true);

      // Recovery: ENTRY_ROLLBACK must exist and be committed
      const rollback = entries.find(
        (e: any) => e.operation === "ENTRY_ROLLBACK" && e.committed,
      );
      expect(rollback).toBeDefined();

      const committed2 = entries.filter((e: any) => e.committed);
      const results = runAllInvariants(committed2, committed2, {}, {});
      printChaosReport("leader-eviction", results);

      // All invariants must pass
      for (const r of results) {
        expect(r.passed, `Invariant failed: ${r.invariant} — ${r.evidence ?? ""}`).toBe(true);
      }
    });
  });

  it("S6 — stale-epoch uncommitted entry produces ENTRY_STALE_EPOCH_DISCARDED on recovery", async () => {
    const doName = "chaos-eviction-stale-epoch";
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName(doName));

    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;

      // Plant schema and a stale-epoch uncommitted entry (epoch=0, while DO epoch=1)
      do_.rclInitialize();
      do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "stale-res", idempotencyKey: "idem-stale" },
        1,
        0, // epoch=0 is stale relative to DO's epoch=1
      );
      expect(do_.rclGetUncommitted()).toHaveLength(1);

      // Trigger recovery via coordinate() — mode is RECOVERING so initialize() runs.
      // Recovery detects entry.epoch (0) < this.epoch (1) and emits ENTRY_STALE_EPOCH_DISCARDED.
      await do_.coordinate({
        ...LOCK_INPUT,
        resourceKey: "post-recovery",
        idempotencyKey: "idem-post-recovery",
      });

      const res = await do_.fetch(new Request("http://x/entries?fromSeq=0&limit=100"));
      const entries = await res.json() as any[];

      // The stale-epoch entry must NOT be committed with outcome COMMITTED
      const staleCommitted = entries.find(
        (e: any) => e.idempotencyKey === "idem-stale" && e.outcome === "COMMITTED",
      );
      expect(staleCommitted).toBeUndefined();

      // ENTRY_STALE_EPOCH_DISCARDED must exist and be committed
      const discarded = entries.find(
        (e: any) => e.operation === "ENTRY_STALE_EPOCH_DISCARDED" && e.committed,
      );
      expect(discarded).toBeDefined();

      const committed = entries.filter((e: any) => e.committed);
      const results = runAllInvariants(committed, committed, {}, {});
      printChaosReport("leader-eviction:stale-epoch", results);

      const s6 = results.find((r) => r.invariant.includes("S6"));
      expect(s6?.passed, `S6 failed: ${s6?.evidence ?? ""}`).toBe(true);
    });
  });
});
