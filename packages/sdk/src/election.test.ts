import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { Quorum } from "./client.ts";

function makeQuorum() {
  return new Quorum({ COORDINATION_RUNTIME: env.COORDINATION_RUNTIME, REPLICA: env.REPLICA, QUORUM_STORAGE: env.QUORUM_STORAGE });
}

describe("Quorum.elect()", () => {
  it("returns ElectionHandle with isLeader()=true and calls onElected", async () => {
    const onElected = vi.fn().mockResolvedValue(undefined);
    const handle = await makeQuorum().elect("sdk-election-group-1", { candidateId: "worker-1", onElected });
    expect(handle.isLeader()).toBe(true);
    expect(onElected).toHaveBeenCalledTimes(1);
  });

  it("resign() sets isLeader()=false and calls onDeposed", async () => {
    const onDeposed = vi.fn().mockResolvedValue(undefined);
    const handle = await makeQuorum().elect("sdk-election-group-2", { candidateId: "worker-1", onDeposed });
    await handle.resign();
    expect(handle.isLeader()).toBe(false);
    expect(onDeposed).toHaveBeenCalledTimes(1);
  });

  it("second elect() on active group has isLeader()=false", async () => {
    const q = makeQuorum();
    await q.elect("sdk-election-group-3", { candidateId: "worker-1" });
    const h2 = await q.elect("sdk-election-group-3", { candidateId: "worker-2" });
    expect(h2.isLeader()).toBe(false);
  });
});
