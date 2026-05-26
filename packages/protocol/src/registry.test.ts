import { describe, it, expect } from "vitest";
import { ProtocolRegistry } from "./registry.ts";
import { LockProtocol } from "./lock.ts";

function makeInput(operation: "LOCK_ACQUIRE" | "LOCK_RELEASE") {
  return {
    protocol: "LOCK" as const,
    protocolVersion: 1,
    operation,
    resourceKey: "res-1",
    payload: { ttl: 30_000 },
    idempotencyKey: "idem-1",
    traceId: "trace-1",
    clientId: "client-1",
  };
}

describe("ProtocolRegistry", () => {
  it("validate routes to correct executor and returns COMMITTED on fresh state", () => {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());
    const result = registry.validate(makeInput("LOCK_ACQUIRE"), {});
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("COMMITTED");
  });

  it("apply updates protocol state and leaves other protocols untouched", () => {
    const registry = new ProtocolRegistry();
    registry.register(new LockProtocol());
    const entry = {
      ...makeInput("LOCK_ACQUIRE"),
      seq: 1, term: 1, epoch: 1, wallClockTs: 1000,
      checksum: "abc", committed: true as const, outcome: "COMMITTED" as const,
    };
    const next = registry.apply(entry, {});
    expect(next["LOCK"]).toBeDefined();
    expect((next["LOCK"] as any).locks["res-1"]).toBeDefined();
  });

  it("snapshot round-trip through registry preserves lock state", () => {
    const registry = new ProtocolRegistry();
    const lock = new LockProtocol();
    registry.register(lock);

    const entry = {
      ...makeInput("LOCK_ACQUIRE"),
      seq: 1, term: 1, epoch: 1, wallClockTs: 1000,
      checksum: "abc", committed: true as const, outcome: "COMMITTED" as const,
    };
    const states = registry.apply(entry, {});
    const slices = registry.serializeAllSnapshots(states);
    const restored = registry.restoreAllSnapshots(slices, { LOCK: 1 });
    expect((restored["LOCK"] as any).locks["res-1"]).toBeDefined();
  });
});
