import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { AppendEntriesRequest, LogEntry } from "@quorum/types";
import type { ReplicaDO } from "./replication/replica-do.ts";

function makeEntry(seq: number, checksum: string): LogEntry {
  return {
    seq,
    term: 1,
    epoch: 1,
    wallClockTs: Date.now(),
    protocol: "SYSTEM",
    protocolVersion: 1,
    operation: "CLUSTER_INITIALIZED",
    resourceKey: "cluster",
    payload: {},
    checksum,
    committed: true,
    idempotencyKey: `idem-${seq}`,
    traceId: "trace-001",
    clientId: "kernel",
  };
}

describe("ReplicaDO", () => {
  it("accepts first entry when prevSeq=0 and prevChecksum=''", async () => {
    const stub = env.REPLICA.get(env.REPLICA.idFromName("replica-test-accept"));
    await runInDurableObject(stub, async (instance) => {
      const replica = instance as unknown as ReplicaDO;
      const req: AppendEntriesRequest = {
        entries: [makeEntry(1, "abc123")],
        leaderEpoch: 1,
        prevSeq: 0,
        prevChecksum: "",
        namespaceId: "test",
      };
      const res = await replica.appendEntries(req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.ack.seq).toBe(1);
      }
    });
  });

  it("returns GAP_DETECTED when prevSeq does not match tail", async () => {
    const stub = env.REPLICA.get(env.REPLICA.idFromName("replica-test-gap"));
    await runInDurableObject(stub, async (instance) => {
      const replica = instance as unknown as ReplicaDO;
      const req: AppendEntriesRequest = {
        entries: [makeEntry(5, "xyz")],
        leaderEpoch: 1,
        prevSeq: 4,
        prevChecksum: "prev",
        namespaceId: "test",
      };
      const res = await replica.appendEntries(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("GAP_DETECTED");
      }
    });
  });

  it("returns STALE_EPOCH when leaderEpoch is less than replica epoch", async () => {
    const stub = env.REPLICA.get(env.REPLICA.idFromName("replica-test-stale"));
    await runInDurableObject(stub, async (instance) => {
      const replica = instance as unknown as ReplicaDO;
      // First establish epoch 3
      await replica.appendEntries({
        entries: [makeEntry(1, "aaa")],
        leaderEpoch: 3,
        prevSeq: 0,
        prevChecksum: "",
        namespaceId: "test",
      });
      // Now send with stale epoch 1
      const res = await replica.appendEntries({
        entries: [makeEntry(2, "bbb")],
        leaderEpoch: 1,
        prevSeq: 1,
        prevChecksum: "aaa",
        namespaceId: "test",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("STALE_EPOCH");
      }
    });
  });
});
