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

  it("POST /coordinate without Authorization header returns 401 when tokenValidator configured", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-auth-test-no-token"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.setTokenValidatorForTest("test-secret");
      const res = await do_.fetch(new Request("http://x/coordinate", { method: "POST" }));
      expect(res.status).toBe(401);
    });
  });

  it("POST /coordinate with valid Bearer token returns 200", async () => {
    // Construct token outside runInDurableObject to avoid async import issues
    const { TokenValidator } = await import("./auth/token-validator.ts");
    const v = new TokenValidator("test-secret");
    const token = await v.sign("default", ["write"], 60_000);
    const bearer = btoa(JSON.stringify(token));

    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("coord-auth-test-valid-token"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.setTokenValidatorForTest("test-secret");
      const res = await do_.fetch(
        new Request("http://x/coordinate", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            protocol: "LOCK",
            protocolVersion: 1,
            operation: "LOCK_ACQUIRE",
            resourceKey: "auth-test-res",
            payload: { ttl: 30_000 },
            idempotencyKey: "idem-auth-1",
            traceId: "trace-1",
            clientId: "sdk",
          }),
        }),
      );
      expect(res.status).toBe(200);
    });
  });
});
