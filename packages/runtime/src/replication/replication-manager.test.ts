import { describe, it, expect, vi } from "vitest";
import { ReplicationManager } from "./replication-manager.ts";
import type { AppendEntriesResponse, LogEntry, ReplicaHealthRecord } from "@quorum/types";

function makeEntry(seq: number): LogEntry {
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
    checksum: `chk-${seq}`,
    committed: false,
    idempotencyKey: `idem-${seq}`,
    traceId: "trace-001",
    clientId: "kernel",
  };
}

function makeMockReplica(response: AppendEntriesResponse) {
  return { appendEntries: vi.fn().mockResolvedValue(response) };
}

describe("ReplicationManager", () => {
  it("calls appendEntries on all replicas", async () => {
    const r1 = makeMockReplica({ ok: true, ack: { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r1" } });
    const r2 = makeMockReplica({ ok: true, ack: { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r2" } });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);
    mgr.registerReplica("r2", r2 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    expect(r1.appendEntries).toHaveBeenCalledTimes(1);
    expect(r2.appendEntries).toHaveBeenCalledTimes(1);
  });

  it("calls onAck with successful ACKs", async () => {
    const ack = { seq: 1, epoch: 1, checksum: "chk-1", snapshotBase: 0, replicaId: "r1" };
    const r1 = makeMockReplica({ ok: true, ack });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    expect(onAck).toHaveBeenCalledWith(1, ack);
  });

  it("increments consecutiveFailures on replica error", async () => {
    const r1 = makeMockReplica({ ok: false, reason: "GAP_DETECTED", lastKnownSeq: 0 });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    await mgr.replicate({ entries: [makeEntry(1)], leaderEpoch: 1, prevSeq: 0, prevChecksum: "" });

    const health = mgr.getHealth("r1");
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.health).toBe("active"); // not yet degraded (threshold is 3)
  });

  it("marks replica DEGRADED after 3 consecutive failures", async () => {
    const r1 = makeMockReplica({ ok: false, reason: "GAP_DETECTED", lastKnownSeq: 0 });
    const onAck = vi.fn();
    const mgr = new ReplicationManager({ namespaceId: "test", onAck });
    mgr.registerReplica("r1", r1 as any);

    for (let i = 0; i < 3; i++) {
      await mgr.replicate({ entries: [makeEntry(i + 1)], leaderEpoch: 1, prevSeq: i, prevChecksum: "" });
    }

    const health = mgr.getHealth("r1");
    expect(health?.health).toBe("degraded");
  });
});
