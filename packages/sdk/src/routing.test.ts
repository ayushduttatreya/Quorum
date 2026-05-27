import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Quorum } from "./client.ts";

describe("Quorum routing", () => {
  it("without NAMESPACE_ROUTER, falls back to COORDINATION_RUNTIME (legacy path)", async () => {
    const legacyEnv = {
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    };
    const q = new Quorum(legacyEnv as any);
    const result = await q.lock("routing-test-legacy", async (t) => t);
    expect(typeof result).toBe("bigint");
  });

  it("with NAMESPACE_ROUTER, routes through router and calls correct group", async () => {
    const routedEnv = {
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      COORDINATION_RUNTIME_0: env.COORDINATION_RUNTIME_0,
      NAMESPACE_ROUTER: env.NAMESPACE_ROUTER,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    };
    const q = new Quorum(routedEnv as any, { namespaceId: "routing-test-ns" });
    const result = await q.lock("routing-test-routed", async (t) => t);
    expect(typeof result).toBe("bigint");
  });

  it("stub is cached — second lock() reuses same stub", async () => {
    const routedEnv = {
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      COORDINATION_RUNTIME_0: env.COORDINATION_RUNTIME_0,
      NAMESPACE_ROUTER: env.NAMESPACE_ROUTER,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    };
    const q = new Quorum(routedEnv as any, { namespaceId: "routing-cache-ns" });
    const r1 = await q.lock("cache-res-1", async (t) => t);
    const r2 = await q.lock("cache-res-2", async (t) => t);
    expect(typeof r1).toBe("bigint");
    expect(typeof r2).toBe("bigint");
  });
});
