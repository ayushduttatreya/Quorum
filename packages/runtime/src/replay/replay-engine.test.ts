import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CoordinationRuntimeDO } from "../coordination-runtime-do.ts";
import type { LogEntryInput } from "@quorum/types";

const LOCK_INPUT: LogEntryInput = {
  protocol: "LOCK",
  protocolVersion: 1,
  operation: "LOCK_ACQUIRE",
  resourceKey: "res-1",
  payload: { ttl: 30_000 },
  idempotencyKey: "idem-replay-1",
  traceId: "trace-1",
  clientId: "client-1",
};

describe("ReplayEngine", () => {
  it("replay on empty log returns empty state with zero entries replayed", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-empty"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const result = do_.replayRun({ fromSeq: 0 });
      expect(result.entriesReplayed).toBe(0);
      expect(result.materializedState).toEqual({});
    });
  });

  it("replay after one LOCK_ACQUIRE COMMITTED produces lock state", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-acquire"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const result = do_.replayRun({ fromSeq: 0 });
      expect(result.entriesReplayed).toBe(1);
      expect((result.materializedState["LOCK"] as any).locks["res-1"]).toBeDefined();
    });
  });

  it("replay skips uncommitted entries", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-uncommitted"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      // Append but do NOT commit
      do_.rclAppend(LOCK_INPUT, 1, 1);
      const result = do_.replayRun({ fromSeq: 0 });
      expect(result.entriesReplayed).toBe(0);
      expect((result.materializedState["LOCK"] as any)?.locks?.["res-1"]).toBeUndefined();
    });
  });

  it("replay with fromSeq skips earlier entries", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-fromseq"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e1 = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e1.seq, "COMMITTED");
      const e2 = do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-replay-2" },
        1,
        1,
      );
      do_.rclMarkCommitted(e2.seq, "COMMITTED");
      // Start replay from seq 2 — only second entry applied
      const result = do_.replayRun({ fromSeq: 2 });
      expect(result.entriesReplayed).toBe(1);
      expect((result.materializedState["LOCK"] as any)?.locks?.["res-1"]).toBeUndefined();
      expect((result.materializedState["LOCK"] as any).locks["res-2"]).toBeDefined();
    });
  });

  it("replay with initialState continues from provided state", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-initial-state"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(
        { ...LOCK_INPUT, resourceKey: "res-2", idempotencyKey: "idem-replay-3" },
        1,
        1,
      );
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      // Provide initial state that already has res-1 locked
      const seedState = do_.replayApplyEntry(
        {
          ...LOCK_INPUT,
          seq: 0,
          term: 1,
          epoch: 1,
          wallClockTs: 1000,
          checksum: "x",
          committed: true as const,
          outcome: "COMMITTED" as const,
        },
        {},
      );
      const result = do_.replayRun({ fromSeq: 0, initialState: seedState });
      expect((result.materializedState["LOCK"] as any).locks["res-1"]).toBeDefined();
      expect((result.materializedState["LOCK"] as any).locks["res-2"]).toBeDefined();
    });
  });

  it("reconstructTimeline returns committed entries in range", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-timeline"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      for (let i = 1; i <= 3; i++) {
        const e = do_.rclAppend(
          { ...LOCK_INPUT, resourceKey: `res-${i}`, idempotencyKey: `idem-tl-${i}` },
          1,
          1,
        );
        do_.rclMarkCommitted(e.seq, "COMMITTED");
      }
      const timeline = do_.replayReconstructTimeline(1, 2);
      expect(timeline).toHaveLength(2);
      expect(timeline[0]!.seq).toBe(1);
      expect(timeline[1]!.seq).toBe(2);
    });
  });

  it("verifyDeterminism returns true when replay matches expected state", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("replay-test-determinism"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e = do_.rclAppend(LOCK_INPUT, 1, 1);
      do_.rclMarkCommitted(e.seq, "COMMITTED");
      const fullResult = do_.replayRun({ fromSeq: 0 });
      const isMatch = do_.replayVerifyDeterminism(0, {}, fullResult.materializedState);
      expect(isMatch).toBe(true);
    });
  });
});
