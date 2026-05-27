import { describe, it, expect } from "vitest";
import {
  assertNoCommittedEntryLost,
  assertCommitIndexMonotonic,
  assertNoDuplicateFencingToken,
  assertReplayEquivalence,
  assertNoStaleEpochCommitted,
} from "./invariants.ts";
import type { CommittedEntry } from "@quorum/types";

function makeEntry(
  seq: number,
  outcome: "COMMITTED" | "REJECTED" = "COMMITTED",
  epoch = 1,
): CommittedEntry {
  return {
    seq, term: 1, epoch, wallClockTs: 1000 + seq,
    protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
    resourceKey: "res-1", payload: { ttl: 30_000 }, checksum: `chk-${seq}`,
    committed: true, outcome,
    idempotencyKey: `idem-${seq}`, traceId: "trace", clientId: "client",
  };
}

describe("assertNoCommittedEntryLost", () => {
  it("passes when all before-entries exist in after", () => {
    const r = assertNoCommittedEntryLost(
      [makeEntry(1), makeEntry(2)],
      [makeEntry(1), makeEntry(2), makeEntry(3)],
    );
    expect(r.passed).toBe(true);
  });

  it("fails when a committed seq from before is absent in after", () => {
    const r = assertNoCommittedEntryLost(
      [makeEntry(1), makeEntry(2)],
      [makeEntry(1)],
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("2");
  });
});

describe("assertCommitIndexMonotonic", () => {
  it("passes on strictly ascending seqs", () => {
    const r = assertCommitIndexMonotonic([makeEntry(1), makeEntry(2), makeEntry(3)]);
    expect(r.passed).toBe(true);
  });

  it("fails when a seq goes backward", () => {
    const r = assertCommitIndexMonotonic([makeEntry(1), makeEntry(3), makeEntry(2)]);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("seq=2");
  });
});

describe("assertNoDuplicateFencingToken", () => {
  it("passes when all fencing tokens unique", () => {
    const r = assertNoDuplicateFencingToken([makeEntry(1), makeEntry(2)]);
    expect(r.passed).toBe(true);
  });

  it("fails when two entries share the same seq (identical fencing token)", () => {
    const e1 = makeEntry(5);
    const e2 = { ...makeEntry(5), idempotencyKey: "idem-5b" };
    const r = assertNoDuplicateFencingToken([e1, e2]);
    expect(r.passed).toBe(false);
  });
});

describe("assertReplayEquivalence", () => {
  it("passes when states deep-equal", () => {
    const state = { LOCK: { locks: { "res-1": { holder: "c", epoch: 1, expiresAt: 9999, acquiredSeq: 1 } } } };
    const r = assertReplayEquivalence(state, JSON.parse(JSON.stringify(state)));
    expect(r.passed).toBe(true);
  });

  it("fails with evidence when states differ", () => {
    const r = assertReplayEquivalence(
      { LOCK: { locks: {} } },
      { LOCK: { locks: { "res-1": {} } } },
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toBeDefined();
  });
});

describe("assertNoStaleEpochCommitted", () => {
  it("passes on monotonically non-decreasing epochs", () => {
    const entries = [
      makeEntry(1, "COMMITTED", 1),
      makeEntry(2, "COMMITTED", 1),
      makeEntry(3, "COMMITTED", 2),
    ];
    expect(assertNoStaleEpochCommitted(entries).passed).toBe(true);
  });

  it("fails when a committed entry has epoch below current max", () => {
    const entries = [makeEntry(1, "COMMITTED", 2), makeEntry(2, "COMMITTED", 1)];
    const r = assertNoStaleEpochCommitted(entries);
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain("epoch=1");
  });
});
