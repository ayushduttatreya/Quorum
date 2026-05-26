import { describe, it, expect, vi } from "vitest";
import { FailureDetector } from "./failure-detector.ts";

describe("FailureDetector", () => {
  it("does not emit after 2 consecutive failures (below threshold of 3)", () => {
    const detector = new FailureDetector();
    const listener = vi.fn();
    detector.onFailure(listener);
    detector.reportReplicaFailure("r1", 2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("emits REPLICA_UNRESPONSIVE after 3 consecutive failures", () => {
    const detector = new FailureDetector();
    const listener = vi.fn();
    detector.onFailure(listener);
    detector.reportReplicaFailure("r1", 3);
    expect(listener).toHaveBeenCalledWith({ type: "REPLICA_UNRESPONSIVE", replicaId: "r1" });
  });

  it("emits REPLICA_RECOVERED on recovery", () => {
    const detector = new FailureDetector();
    const listener = vi.fn();
    detector.onFailure(listener);
    detector.reportReplicaRecovery("r1");
    expect(listener).toHaveBeenCalledWith({ type: "REPLICA_RECOVERED", replicaId: "r1" });
  });

  it("isQuorumReachable(2, 1) → true (kernel + 1 replica = 2 = quorum)", () => {
    const detector = new FailureDetector();
    expect(detector.isQuorumReachable(2, 1)).toBe(true);
  });

  it("isQuorumReachable(2, 0) → false (only kernel, quorum requires 2)", () => {
    const detector = new FailureDetector();
    expect(detector.isQuorumReachable(2, 0)).toBe(false);
  });

  it("checkAndEmitQuorum emits QUORUM_DEGRADED when quorum is lost", () => {
    const detector = new FailureDetector();
    const listener = vi.fn();
    detector.onFailure(listener);
    detector.checkAndEmitQuorum(2, 0);
    expect(listener).toHaveBeenCalledWith({ type: "QUORUM_DEGRADED", reachable: 1, required: 2 });
  });
});
