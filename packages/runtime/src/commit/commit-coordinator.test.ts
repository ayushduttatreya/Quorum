import { describe, it, expect, vi } from "vitest";
import { CommitCoordinator } from "./commit-coordinator.ts";

describe("CommitCoordinator", () => {
  it("does not commit with insufficient ACKs (needs 3-of-5, only kernel+1 ACK)", () => {
    const onCommit = vi.fn();
    // replicaCount=4 → total=5, quorum=3; kernel(1)+r1(1)=2 < 3
    const coord = new CommitCoordinator({ replicaCount: 4, onCommit });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits when kernel + 1 replica ACK (2-of-3 quorum)", () => {
    const onCommit = vi.fn();
    // replicaCount=2 means kernel(1) + 2 replicas → quorum = floor(3/2)+1 = 2
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    // kernel counts as 1 ACK implicitly — record replica ACK
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).toHaveBeenCalledWith(1, "r1");
  });

  it("does not double-commit same seq", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r2" });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("tracks commit index monotonically", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit });
    coord.recordAck(2, { seq: 2, epoch: 1, checksum: "xyz", snapshotBase: 0, replicaId: "r1" });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    // commits should happen in seq order when both have quorum
    expect(coord.getCommitIndex()).toBe(2);
  });

  it("rejects ACK with stale epoch", () => {
    const onCommit = vi.fn();
    const coord = new CommitCoordinator({ replicaCount: 2, onCommit, currentEpoch: 3 });
    coord.recordAck(1, { seq: 1, epoch: 1, checksum: "abc", snapshotBase: 0, replicaId: "r1" });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
