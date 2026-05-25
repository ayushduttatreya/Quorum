import { describe, it } from "vitest";

describe("CommitCoordinator", () => {
  it.todo("does not commit with insufficient ACKs");
  it.todo("commits when kernel + 1 replica ACK (2-of-3 quorum)");
  it.todo("does not double-commit same seq");
  it.todo("tracks commit index monotonically");
  it.todo("rejects ACK with stale epoch");
});
