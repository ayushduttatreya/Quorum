import { describe, it, expect } from "vitest";
import { formatTopology } from "./topology.js";

describe("formatTopology", () => {
  it("formats ACTIVE mode with commitIndex and replicas", () => {
    const out = formatTopology({
      mode: "ACTIVE", commitIndex: 42,
      replicaHealth: [
        { replicaId: "r1", health: "active", lastAckedSeq: 42, lastAckedEpoch: 1, consecutiveFailures: 0 },
        { replicaId: "r2", health: "degraded", lastAckedSeq: 38, lastAckedEpoch: 1, consecutiveFailures: 4 },
      ],
    });
    expect(out).toContain("ACTIVE");
    expect(out).toContain("42");
    expect(out).toContain("r1");
    expect(out).toContain("r2");
  });

  it("formats degraded replica with failure count", () => {
    const out = formatTopology({
      mode: "ACTIVE", commitIndex: 1,
      replicaHealth: [{ replicaId: "r1", health: "degraded", lastAckedSeq: 0, lastAckedEpoch: 0, consecutiveFailures: 5 }],
    });
    expect(out).toContain("degraded");
    expect(out).toContain("failures=5");
  });

  it("formats empty replicaHealth with Replicas header", () => {
    const out = formatTopology({ mode: "ACTIVE", commitIndex: 0, replicaHealth: [] });
    expect(out).toContain("Replicas:");
    expect(out.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(0);
  });
});
