import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Quorum } from "./client.ts";

describe("Quorum.lock()", () => {
  it("lock() acquires, executes callback with bigint fencing token, releases", async () => {
    const quorum = new Quorum({
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    });

    let receivedToken: bigint | undefined;
    const result = await quorum.lock(
      "sdk-res-1",
      async (token) => {
        receivedToken = token;
        return "callback-result";
      },
    );

    expect(result).toBe("callback-result");
    expect(typeof receivedToken).toBe("bigint");
    expect(receivedToken! > 0n).toBe(true);
  });

  it("lock() on already-held resource throws QuorumError with code LOCK_HELD", async () => {
    const quorum = new Quorum({
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    });

    // Hold the lock without a callback
    const handle = await quorum.acquireLock("sdk-res-2", { ttl: 60_000 });
    expect(handle.fencingToken).toBeDefined();

    // Second acquire must throw
    const { QuorumError } = await import("@quorum/types");
    await expect(
      quorum.lock("sdk-res-2", async (t) => t),
    ).rejects.toThrow(QuorumError);
  });

  it("acquireLock() returns LockHandle with bigint fencingToken and release()", async () => {
    const quorum = new Quorum({
      COORDINATION_RUNTIME: env.COORDINATION_RUNTIME,
      REPLICA: env.REPLICA,
      QUORUM_STORAGE: env.QUORUM_STORAGE,
    });

    const handle = await quorum.acquireLock("sdk-res-3", { ttl: 30_000 });
    expect(typeof handle.fencingToken).toBe("bigint");
    expect(handle.fencingToken > 0n).toBe(true);
    expect(typeof handle.expiresAt).toBe("number");
    expect(typeof handle.release).toBe("function");

    await handle.release();
  });
});
