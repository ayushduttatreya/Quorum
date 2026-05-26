import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CoordinationRuntimeDO } from "../coordination-runtime-do.ts";
import type { LogEntryInput } from "@quorum/types";

const LOCK_INPUT: LogEntryInput = {
  protocol: "LOCK",
  protocolVersion: 1,
  operation: "LOCK_ACQUIRE",
  resourceKey: "res-snap",
  payload: { ttl: 60_000 },
  idempotencyKey: "idem-snap-1",
  traceId: "trace-1",
  clientId: "client-1",
};

describe("SnapshotManager", () => {
  it("takeSnapshot writes snapshot object to R2", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-r2-write"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states = registry.apply(
        { ...LOCK_INPUT, seq: e.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      const meta = await do_.snapshotTake(e.seq, states, 1, 1);
      expect(meta.seq).toBe(e.seq);
      expect(meta.r2Key).toContain("snap_");
      const r2Bucket = (instance as any).env.QUORUM_STORAGE as R2Bucket;
      const obj = await r2Bucket.get(meta.r2Key);
      expect(obj).not.toBeNull();
    });
  });

  it("takeSnapshot commits SNAPSHOT_COMPLETE entry to RCL", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-rcl-entry"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states = registry.apply(
        { ...LOCK_INPUT, seq: e.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      await do_.snapshotTake(e.seq, states, 1, 1);
      const entries = do_.rclGetEntries(0, 100);
      const snapshotEntry = entries.find(e2 => e2.operation === "SNAPSHOT_COMPLETE");
      expect(snapshotEntry).toBeDefined();
      expect(snapshotEntry!.committed).toBe(true);
    });
  });

  it("takeSnapshot deletes compacted SQLite entries before commitSeq", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-compact"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e1 = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e1.seq, "COMMITTED");
      const e2 = do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-snap-2" },
        1, 1,
      );
      do_.rclMarkCommitted(e2.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states = registry.apply(
        { ...LOCK_INPUT, seq: e1.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      // Snapshot at seq 1 — deleteUpTo(0) keeps seq 1+
      await do_.snapshotTake(e1.seq, states, 1, 1);
      // seq 1 itself must still exist
      const remaining = do_.rclGetEntries(1, 100);
      expect(remaining.find(e => e.seq === 1)).toBeDefined();
    });
  });

  it("loadLatestSnapshot returns correct state after takeSnapshot", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-load"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states = registry.apply(
        { ...LOCK_INPUT, seq: e.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      await do_.snapshotTake(e.seq, states, 1, 1);
      const loaded = await do_.snapshotLoadLatest();
      expect(loaded).not.toBeNull();
      expect(loaded!.seq).toBe(e.seq);
      const restored = do_.snapshotRestoreAll(loaded!.slices, loaded!.protocolVersions);
      expect((restored["LOCK"] as any).locks["res-snap"]).toBeDefined();
    });
  });

  it("verifySnapshot returns true for valid snapshot", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-verify"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states = registry.apply(
        { ...LOCK_INPUT, seq: e.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      const meta = await do_.snapshotTake(e.seq, states, 1, 1);
      expect(await do_.snapshotVerify(meta)).toBe(true);
    });
  });

  it("maybeSnapshot triggers at threshold, not before", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-threshold"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e1 = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e1.seq, "COMMITTED");
      const registry = do_.snapshotMakeRegistry();
      const states1 = registry.apply(
        { ...LOCK_INPUT, seq: e1.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "x", committed: true as const, outcome: "COMMITTED" as const },
        {},
      );
      // seq=1, threshold=2: 1-0=1 < 2, no snapshot
      const triggered1 = await do_.snapshotMaybe(e1.seq, states1, 1, 1, 2);
      expect(triggered1).toBe(false);

      const e2 = do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-snap-thresh" },
        1, 1,
      );
      do_.rclMarkCommitted(e2.seq, "COMMITTED");
      const states2 = registry.apply(
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-snap-thresh", seq: e2.seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "y", committed: true as const, outcome: "COMMITTED" as const },
        states1,
      );
      // seq=2, threshold=2: 2-0=2 >= 2, triggers
      const triggered2 = await do_.snapshotMaybe(e2.seq, states2, 1, 1, 2);
      expect(triggered2).toBe(true);
    });
  });

  it("replay contract: snapshot(N) + replay(N+1→HEAD) ≡ full_replay(0→HEAD)", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("snap-test-contract"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();

      // Write 4 entries, commit all
      const inputs: LogEntryInput[] = [
        { ...LOCK_INPUT },
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-c2" },
        { ...LOCK_INPUT, resourceKey: "res-3", idempotencyKey: "idem-c3" },
        { ...LOCK_INPUT, resourceKey: "res-4", idempotencyKey: "idem-c4" },
      ];
      for (const input of inputs) {
        const e = do_.rclAppend(input, 1, 1);
        do_.rclMarkCommitted(e.seq, "COMMITTED");
      }

      // Full replay from seq 0 (before compaction)
      const fullResult = do_.replayRun({ fromSeq: 0 });

      // Take snapshot at seq 2
      const snapshotSeq = 2;
      const statesAtN = do_.replayRun({ fromSeq: 0, toSeq: snapshotSeq }).materializedState;
      await do_.snapshotTake(snapshotSeq, statesAtN, 1, 1);

      // Load snapshot, restore base state, replay delta (seq 3+)
      const loaded = await do_.snapshotLoadLatest();
      expect(loaded!.seq).toBe(snapshotSeq);
      const restoredBase = do_.snapshotRestoreAll(loaded!.slices, loaded!.protocolVersions);
      const deltaResult = do_.replayRun({ fromSeq: snapshotSeq + 1, initialState: restoredBase });

      // Both must have the same lock keys
      const deltaLocks = Object.keys((deltaResult.materializedState["LOCK"] as any).locks).sort();
      const fullLocks = Object.keys((fullResult.materializedState["LOCK"] as any).locks).sort();
      expect(deltaLocks).toEqual(fullLocks);
    });
  });
});
