import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { LogEntryInput } from "@quorum/types";
import type { CoordinationRuntimeDO } from "../coordination-runtime-do.ts";

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
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName("rcl-test-init"));
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const entries = do_.rclGetEntries(0, 10);
      expect(entries).toEqual([]);
    });
  });

  it("appends an entry and returns seq=1", async () => {
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName("rcl-test-append"));
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const entry = do_.rclAppend(TEST_INPUT, 1, 1);
      expect(entry.seq).toBe(1);
      expect(entry.committed).toBe(false);
      expect(entry.checksum).toBeTruthy();
    });
  });

  it("rejects duplicate idempotency key", async () => {
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName("rcl-test-idem"));
    await runInDurableObject(stub, async (instance) => {
      const { IdempotentResultError } = await import("@quorum/types");
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      do_.rclAppend(TEST_INPUT, 1, 1);
      expect(() => do_.rclAppend(TEST_INPUT, 1, 1)).toThrow(IdempotentResultError);
    });
  });

  it("marks entry committed by seq", async () => {
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName("rcl-test-commit"));
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const entry = do_.rclAppend(TEST_INPUT, 1, 1);
      do_.rclMarkCommitted(entry.seq, "COMMITTED");
      const [committed] = do_.rclGetEntries(0, 1);
      expect(committed?.committed).toBe(true);
    });
  });

  it("getUncommitted returns only uncommitted entries", async () => {
    const stub = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName("rcl-test-uncommitted"));
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();
      const e1 = do_.rclAppend(TEST_INPUT, 1, 1);
      const e2 = do_.rclAppend({ ...TEST_INPUT, idempotencyKey: "idem-002" }, 1, 1);
      do_.rclMarkCommitted(e1.seq, "COMMITTED");
      const uncommitted = do_.rclGetUncommitted();
      expect(uncommitted).toHaveLength(1);
      expect(uncommitted[0]?.seq).toBe(e2.seq);
    });
  });
});
