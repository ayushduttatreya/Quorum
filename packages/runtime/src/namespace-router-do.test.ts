import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { NamespaceRouterDO } from "./namespace-router-do.ts";

function getRouter() {
  return env.NAMESPACE_ROUTER.get(env.NAMESPACE_ROUTER.idFromName("global-router"));
}

describe("NamespaceRouterDO", () => {
  it("GET /route for new namespace assigns to a group and returns groupId + doName", async () => {
    const stub = getRouter();
    await runInDurableObject(stub, async (instance) => {
      const router = instance as unknown as NamespaceRouterDO;
      const res = await router.fetch(new Request("http://r/route?namespaceId=payments"));
      expect(res.status).toBe(200);
      const body = await res.json() as { groupId: number; doName: string };
      expect(typeof body.groupId).toBe("number");
      expect(body.doName).toBe(`group-${body.groupId}`);
    });
  });

  it("GET /route called twice for same namespace returns same groupId (idempotent)", async () => {
    const stub = env.NAMESPACE_ROUTER.get(env.NAMESPACE_ROUTER.idFromName("router-idem-test"));
    await runInDurableObject(stub, async (instance) => {
      const router = instance as unknown as NamespaceRouterDO;
      const r1 = await router.fetch(new Request("http://r/route?namespaceId=inventory"));
      const b1 = await r1.json() as { groupId: number };
      const r2 = await router.fetch(new Request("http://r/route?namespaceId=inventory"));
      const b2 = await r2.json() as { groupId: number };
      expect(b1.groupId).toBe(b2.groupId);
    });
  });

  it("POST /assign overrides assignment to a specific groupId", async () => {
    const stub = env.NAMESPACE_ROUTER.get(env.NAMESPACE_ROUTER.idFromName("router-assign-test"));
    await runInDurableObject(stub, async (instance) => {
      const router = instance as unknown as NamespaceRouterDO;
      await router.fetch(new Request("http://r/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespaceId: "overridden-ns", groupId: 7 }),
      }));
      const res = await router.fetch(new Request("http://r/route?namespaceId=overridden-ns"));
      const body = await res.json() as { groupId: number };
      expect(body.groupId).toBe(7);
    });
  });

  it("GET /assignments returns all assignments as array", async () => {
    const stub = env.NAMESPACE_ROUTER.get(env.NAMESPACE_ROUTER.idFromName("router-list-test"));
    await runInDurableObject(stub, async (instance) => {
      const router = instance as unknown as NamespaceRouterDO;
      await router.fetch(new Request("http://r/route?namespaceId=ns-alpha"));
      await router.fetch(new Request("http://r/route?namespaceId=ns-beta"));
      const res = await router.fetch(new Request("http://r/assignments"));
      const body = await res.json() as { namespaceId: string; groupId: number }[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body.map(b => b.namespaceId).sort()).toEqual(["ns-alpha", "ns-beta"]);
    });
  });

  it("FNV-1a distributes across groups with GROUP_COUNT=2", () => {
    const fnv1aHash = (str: string) => {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      return hash;
    };
    const names = ["payments", "inventory", "orders", "users", "auth", "sessions", "billing", "catalog"];
    const groups = names.map(n => fnv1aHash(n) % 2);
    expect(new Set(groups).size).toBeGreaterThan(1);
  });
});
