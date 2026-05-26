import { describe, it, expect } from "vitest";
import { runDeterminismCheck } from "./determinism-check.js";
import { ProtocolRegistry, LockProtocol } from "@quorum/protocol";
import type { LogEntry } from "@quorum/types";

function makeEntry(
  seq: number,
  resourceKey: string,
  committed: boolean,
): LogEntry {
  return {
    seq,
    term: 1,
    epoch: 1,
    wallClockTs: 1000 + seq,
    protocol: "LOCK",
    protocolVersion: 1,
    operation: "LOCK_ACQUIRE",
    resourceKey,
    payload: { ttl: 30_000 },
    checksum: `chk-${seq}`,
    committed,
    idempotencyKey: `idem-${seq}`,
    traceId: "trace",
    clientId: "client",
  };
}

describe("runDeterminismCheck", () => {
  it("passes on empty log with no snapshot", () => {
    const result = runDeterminismCheck([], null);
    expect(result.passed).toBe(true);
    expect(result.entriesChecked).toBe(0);
    expect(result.snapshotSeq).toBeNull();
  });

  it("passes when full replay equals delta replay (no snapshot)", () => {
    const entries = [
      makeEntry(1, "res-1", true),
      makeEntry(2, "res-2", true),
    ];
    const result = runDeterminismCheck(entries, null);
    expect(result.passed).toBe(true);
    expect(result.entriesChecked).toBe(2);
  });

  it("passes when snapshot(N) + replay(N+1) matches full replay", () => {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());

    const entries = [
      makeEntry(1, "res-1", true),
      makeEntry(2, "res-2", true),
      makeEntry(3, "res-3", true),
    ];

    // Build materialized state at seq=2
    const stateAtTwo = entries
      .filter((e) => e.seq <= 2 && e.committed)
      .reduce(
        (s, e) => registry.apply({ ...e, committed: true as const, outcome: "COMMITTED" as const }, s),
        {} as Record<string, unknown>,
      );
    const slices = registry.serializeAllSnapshots(stateAtTwo);
    const snapshot = {
      seq: 2,
      term: 1,
      epoch: 1,
      protocolVersions: { LOCK: 1 },
      slices,
      checksum: "ignored",
      createdAt: Date.now(),
    };

    const result = runDeterminismCheck(entries, snapshot);
    expect(result.passed).toBe(true);
    expect(result.snapshotSeq).toBe(2);
  });

  it("fails when snapshot state diverges from full replay", () => {
    const entries = [makeEntry(1, "res-1", true)];
    // Corrupt snapshot: empty slices — restoreAllSnapshots returns {}
    // delta replay starts from {} and replays seq 2+ (nothing) → stays {}
    // full replay sees res-1 locked → different from {}
    const snapshot = {
      seq: 1,
      term: 1,
      epoch: 1,
      protocolVersions: {},
      slices: [],
      checksum: "bad",
      createdAt: Date.now(),
    };
    const result = runDeterminismCheck(entries, snapshot);
    expect(result.passed).toBe(false);
  });
});
