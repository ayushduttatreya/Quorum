import { describe, it, expect } from "vitest";
import { formatSnapshotList } from "./snapshot-list.js";

const META = { seq: 42, r2Key: "snap_42_abc.bin", checksum: "abc123", protocolVersions: {}, createdAt: new Date("2026-05-27T12:00:00Z").getTime() };

describe("formatSnapshotList", () => {
  it("prints header and one data row", () => {
    const out = formatSnapshotList([META]);
    expect(out).toContain("SEQ");
    expect(out).toContain("42");
    expect(out).toContain("abc123");
  });

  it("prints No snapshots found on empty array", () => {
    expect(formatSnapshotList([])).toBe("No snapshots found.");
  });

  it("prints multiple rows", () => {
    const rows = formatSnapshotList([META, { ...META, seq: 10 }]).split("\n").filter((l) => !l.startsWith("SEQ"));
    expect(rows).toHaveLength(2);
  });
});
