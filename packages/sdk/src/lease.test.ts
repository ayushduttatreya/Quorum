import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Quorum } from "./client.ts";

function makeQuorum() {
  return new Quorum({ COORDINATION_RUNTIME: env.COORDINATION_RUNTIME, REPLICA: env.REPLICA, QUORUM_STORAGE: env.QUORUM_STORAGE });
}

describe("Quorum.lease()", () => {
  it("acquires and returns LeaseHandle with epoch=1", async () => {
    const handle = await makeQuorum().lease("sdk-lease-res-1", { ttl: 30_000 });
    expect(handle.epoch).toBe(1);
    expect(handle.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof handle.renew).toBe("function");
  });

  it("second lease() on held resource throws QuorumError", async () => {
    const q = makeQuorum();
    await q.lease("sdk-lease-res-2", { ttl: 60_000 });
    const { QuorumError } = await import("@quorum/types");
    await expect(q.lease("sdk-lease-res-2", { ttl: 30_000 })).rejects.toThrow(QuorumError);
  });

  it("renew() increments epoch to 2", async () => {
    const handle = await makeQuorum().lease("sdk-lease-res-3", { ttl: 30_000 });
    await handle.renew();
    expect(handle.epoch).toBe(2);
  });

  it("release() allows resource to be re-acquired", async () => {
    const q = makeQuorum();
    const h1 = await q.lease("sdk-lease-res-4", { ttl: 30_000 });
    await h1.release();
    const h2 = await q.lease("sdk-lease-res-4", { ttl: 30_000 });
    expect(h2.epoch).toBe(1);
  });
});
