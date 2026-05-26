import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { LogEntryInput } from "@quorum/types";
import type { CoordinationRuntimeDO } from "./coordination-runtime-do.ts";

const LOCK_INPUT: LogEntryInput = {
  protocol: "LOCK",
  protocolVersion: 1,
  operation: "LOCK_ACQUIRE",
  resourceKey: "recovery-res",
  payload: { ttl: 60_000 },
  idempotencyKey: "idem-recovery-1",
  traceId: "trace-1",
  clientId: "client-1",
};

describe("CoordinationRuntimeDO recovery", () => {
  it("lock state survives DO restart: second instance replays committed entries", async () => {
    const doName = "recovery-test-restart";

    // Session 1: acquire lock
    const stub1 = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName(doName),
    );
    await runInDurableObject(stub1, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      const result = await do_.coordinate(LOCK_INPUT);
      expect(result.outcome).toBe("COMMITTED");
    });

    // Session 2: same DO name — SQLite persists, should replay and reject duplicate acquire
    const stub2 = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName(doName),
    );
    await runInDurableObject(stub2, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      // Different idempotencyKey so it's a new request, same resourceKey
      const result = await do_.coordinate({
        ...LOCK_INPUT,
        idempotencyKey: "idem-recovery-2",
      });
      expect(result.outcome).toBe("REJECTED");
    });
  });

  it("uncommitted entry is rolled back on restart: ENTRY_ROLLBACK appears in log", async () => {
    const doName = "recovery-test-rollback";

    // Write an uncommitted entry directly via test helper
    const stub1 = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName(doName),
    );
    await runInDurableObject(stub1, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      // Append without marking committed — simulates crashed mid-write
      do_.rclAppend(LOCK_INPUT, 1, 1);
      // Confirm it's uncommitted
      const uncommitted = do_.rclGetUncommitted();
      expect(uncommitted).toHaveLength(1);
    });

    // Session 2: recovery must roll back the uncommitted entry and go ACTIVE
    const stub2 = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName(doName),
    );
    await runInDurableObject(stub2, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      // coordinate() triggers initialize() → recovery
      const result = await do_.coordinate({
        protocol: "LOCK",
        protocolVersion: 1,
        operation: "LOCK_ACQUIRE",
        resourceKey: "different-res",
        payload: { ttl: 30_000 },
        idempotencyKey: "idem-recovery-3",
        traceId: "trace-1",
        clientId: "client-1",
      });
      expect(result.outcome).toBe("COMMITTED");
      // ENTRY_ROLLBACK must be in the log
      const entries = do_.rclGetEntries(0, 100);
      const rollback = entries.find((e) => e.operation === "ENTRY_ROLLBACK");
      expect(rollback).toBeDefined();
    });
  });
});
