import { describe, it } from "vitest";

describe("ReplicationManager", () => {
  it.todo("calls appendEntries on all replicas");
  it.todo("calls onAck with successful ACKs");
  it.todo("increments consecutiveFailures on replica error");
  it.todo("marks replica DEGRADED after 3 consecutive failures");
});
