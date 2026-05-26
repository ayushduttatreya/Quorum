import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { LogEntryInput } from "@quorum/types";
import type { CoordinationRuntimeDO } from "./coordination-runtime-do.ts";

function makeLockAcquire(resourceKey: string, idempotencyKey: string): LogEntryInput {
  return {
    protocol: "LOCK",
    protocolVersion: 1,
    operation: "LOCK_ACQUIRE",
    resourceKey,
    payload: { ttl: 30_000 },
    idempotencyKey,
    traceId: "trace-1",
    clientId: "client-1",
  };
}

describe("CoordinationRuntimeDO", () => {
  it("LOCK_ACQUIRE on fresh resource returns COMMITTED with seq=1", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-test-acquire"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      const result = await do_.coordinate(makeLockAcquire("payment-1", "idem-acquire-1"));
      expect(result.outcome).toBe("COMMITTED");
      expect(result.seq).toBe(1);
      expect(result.protocol).toBe("LOCK");
      expect(result.operation).toBe("LOCK_ACQUIRE");
    });
  });

  it("second LOCK_ACQUIRE on same locked resource returns REJECTED", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-test-contention"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      await do_.coordinate(makeLockAcquire("payment-2", "idem-contention-1"));
      const second = await do_.coordinate(makeLockAcquire("payment-2", "idem-contention-2"));
      expect(second.outcome).toBe("REJECTED");
    });
  });

  it("GET /health returns mode=ACTIVE and commitIndex after one commit", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-test-health"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      await do_.coordinate(makeLockAcquire("health-res", "idem-health-1"));
      const res = await do_.fetch(new Request("http://x/health"));
      const body = await res.json() as { mode: string; commitIndex: number };
      expect(body.mode).toBe("ACTIVE");
      expect(body.commitIndex).toBeGreaterThanOrEqual(1);
    });
  });

  it("GET /entries returns committed entries as JSON array", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-entries-test"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      await do_.coordinate(makeLockAcquire("entries-res", "idem-entries-1"));
      const res = await do_.fetch(new Request("http://x/entries?fromSeq=0&limit=10"));
      const entries = await res.json() as unknown[];
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  it("GET /snapshot returns null when no snapshot exists", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-snapshot-test"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      const res = await do_.fetch(new Request("http://x/snapshot"));
      const snap = await res.json();
      expect(snap).toBeNull();
    });
  });
});
