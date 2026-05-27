import { describe, it, expect } from "vitest";
import { runReplayCommand } from "./replay.js";
import type { LogEntry } from "@quorum/types";

function makeEntry(seq: number, committed = true, resourceKey = `res-${seq}`, outcome = "COMMITTED"): any {
  return {
    seq, term: 1, epoch: 1, wallClockTs: 1000 + seq,
    protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
    resourceKey, payload: { ttl: 30_000 }, checksum: `chk-${seq}`,
    committed, outcome,
    idempotencyKey: `idem-${seq}`, traceId: "trace", clientId: "client",
  };
}

describe("runReplayCommand", () => {
  it("renders timeline rows for committed entries in range", () => {
    const r = runReplayCommand([makeEntry(1), makeEntry(2), makeEntry(3)], null, { from: 1, to: 2, dryRun: false });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.seq).toBe(1);
    expect(r.rows[1]!.seq).toBe(2);
  });

  it("excludes uncommitted entries from rows", () => {
    const r = runReplayCommand([makeEntry(1), makeEntry(2, false), makeEntry(3)], null, { from: 1, to: 3, dryRun: false });
    expect(r.rows.map((x) => x.seq)).not.toContain(2);
  });

  it("excludes entries outside [from, to] range", () => {
    const r = runReplayCommand([makeEntry(1), makeEntry(2), makeEntry(3), makeEntry(4)], null, { from: 2, to: 3, dryRun: false });
    expect(r.rows.map((x) => x.seq)).toEqual([2, 3]);
  });

  it("dry-run materializes state as JSON, rows is empty", () => {
    const r = runReplayCommand([makeEntry(1), makeEntry(2)], null, { from: 1, to: 2, dryRun: true });
    expect(r.rows).toHaveLength(0);
    expect(typeof r.materializedStateJson).toBe("string");
  });

  it("determinismPassed is true when S5 holds (no snapshot)", () => {
    const r = runReplayCommand([makeEntry(1), makeEntry(2)], null, { from: 1, to: 2, dryRun: false });
    expect(r.determinismPassed).toBe(true);
  });

  it("determinismPassed is false when snapshot is corrupt", () => {
    const entries = [makeEntry(1, true, "res-1", "COMMITTED")];
    const snapshot = { seq: 1, term: 1, epoch: 1, protocolVersions: {}, slices: [], checksum: "bad", createdAt: Date.now() };
    const r = runReplayCommand(entries, snapshot, { from: 1, to: 1, dryRun: false });
    expect(r.determinismPassed).toBe(false);
  });
});
