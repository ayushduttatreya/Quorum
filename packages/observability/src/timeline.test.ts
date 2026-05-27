import { describe, it, expect } from "vitest";
import { buildTimeline } from "./timeline.ts";
import type { CommittedEntry } from "@quorum/types";

function makeEntry(seq: number, outcome: "COMMITTED" | "REJECTED" = "COMMITTED"): CommittedEntry {
  return {
    seq, term: 1, epoch: 1, wallClockTs: 1000 + seq,
    protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
    resourceKey: "res-1", payload: {}, checksum: "abc",
    committed: true as const, outcome,
    idempotencyKey: `idem-${seq}`, traceId: `trace-${seq}`, clientId: "client-1",
  };
}

describe("buildTimeline", () => {
  it("empty input returns empty array", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it("maps all fields correctly", () => {
    const [row] = buildTimeline([makeEntry(42)]);
    expect(row!.seq).toBe(42);
    expect(row!.wallClockTs).toBe(1042);
    expect(row!.protocol).toBe("LOCK");
    expect(row!.clientId).toBe("client-1");
  });

  it("preserves input order (does not sort)", () => {
    const rows = buildTimeline([makeEntry(3), makeEntry(1), makeEntry(2)]);
    expect(rows.map((r) => r.seq)).toEqual([3, 1, 2]);
  });

  it("includes both COMMITTED and REJECTED entries", () => {
    const rows = buildTimeline([makeEntry(1, "COMMITTED"), makeEntry(2, "REJECTED")]);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.outcome).toBe("REJECTED");
  });
});
