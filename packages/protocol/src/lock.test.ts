import { describe, it, expect } from "vitest";
import { LockProtocol, type LockState } from "./lock.ts";

const proto = new LockProtocol();
const emptyState: LockState = { locks: {} };

function makeInput(operation: "LOCK_ACQUIRE" | "LOCK_RELEASE" | "LOCK_EXPIRE", overrides: Record<string, unknown> = {}) {
  return {
    protocol: "LOCK" as const,
    protocolVersion: 1,
    operation,
    resourceKey: "res-1",
    payload: { ttl: 30_000, ...overrides },
    idempotencyKey: "idem-1",
    traceId: "trace-1",
    clientId: "client-1",
  };
}

function makeEntry(seq: number, operation: "LOCK_ACQUIRE" | "LOCK_RELEASE" | "LOCK_EXPIRE", outcome: "COMMITTED" | "REJECTED", wallClockTs = 1000) {
  return {
    ...makeInput(operation),
    seq,
    term: 1,
    epoch: 1,
    wallClockTs,
    checksum: "abc",
    committed: true as const,
    outcome,
  };
}

describe("LockProtocol.validate", () => {
  it("LOCK_ACQUIRE on unlocked resource → COMMITTED", () => {
    const result = proto.validate(makeInput("LOCK_ACQUIRE"), emptyState);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("COMMITTED");
  });

  it("LOCK_ACQUIRE on locked, non-expired resource → REJECTED", () => {
    const state: LockState = {
      locks: {
        "res-1": {
          holder: "client-1",
          fencingToken: 1n,
          expiresAt: Date.now() + 60_000,
          acquiredSeq: 1,
        },
      },
    };
    const result = proto.validate(makeInput("LOCK_ACQUIRE"), state);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("REJECTED");
    expect(result.reason).toBe("LOCK_HELD");
  });

  it("LOCK_ACQUIRE on expired lock → COMMITTED", () => {
    const state: LockState = {
      locks: {
        "res-1": {
          holder: "client-1",
          fencingToken: 1n,
          expiresAt: Date.now() - 1_000,
          acquiredSeq: 1,
        },
      },
    };
    const result = proto.validate(makeInput("LOCK_ACQUIRE"), state);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("COMMITTED");
  });

  it("LOCK_RELEASE with correct fencing token → COMMITTED", () => {
    const state: LockState = {
      locks: {
        "res-1": {
          holder: "client-1",
          fencingToken: 42n,
          expiresAt: Date.now() + 60_000,
          acquiredSeq: 1,
        },
      },
    };
    const result = proto.validate(makeInput("LOCK_RELEASE", { fencingToken: "42" }), state);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("COMMITTED");
  });

  it("LOCK_RELEASE with wrong fencing token → REJECTED", () => {
    const state: LockState = {
      locks: {
        "res-1": {
          holder: "client-1",
          fencingToken: 42n,
          expiresAt: Date.now() + 60_000,
          acquiredSeq: 1,
        },
      },
    };
    const result = proto.validate(makeInput("LOCK_RELEASE", { fencingToken: "99" }), state);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("REJECTED");
    expect(result.reason).toBe("TOKEN_MISMATCH");
  });

  it("LOCK_EXPIRE always → COMMITTED", () => {
    const result = proto.validate(makeInput("LOCK_EXPIRE"), emptyState);
    expect(result.valid).toBe(true);
    expect(result.outcome).toBe("COMMITTED");
  });

  it("LOCK_RELEASE on non-existent lock → REJECTED", () => {
    const result = proto.validate(makeInput("LOCK_RELEASE", { fencingToken: "42" }), emptyState);
    expect(result.valid).toBe(false);
    expect(result.outcome).toBe("REJECTED");
    expect(result.reason).toBe("TOKEN_MISMATCH");
  });
});

describe("LockProtocol.apply", () => {
  it("LOCK_ACQUIRE COMMITTED sets lock state", () => {
    const entry = makeEntry(1, "LOCK_ACQUIRE", "COMMITTED", 1000);
    const next = proto.apply(entry, emptyState);
    expect(next.locks["res-1"]).toBeDefined();
    expect(next.locks["res-1"]!.holder).toBe("client-1");
    expect(next.locks["res-1"]!.acquiredSeq).toBe(1);
    expect(next.locks["res-1"]!.fencingToken).toBe((1n << 32n) | 1n);
    expect(next.locks["res-1"]!.expiresAt).toBe(1000 + 30_000);
  });

  it("LOCK_ACQUIRE REJECTED leaves state unchanged", () => {
    const entry = makeEntry(2, "LOCK_ACQUIRE", "REJECTED");
    const next = proto.apply(entry, emptyState);
    expect(next.locks).toEqual({});
  });

  it("LOCK_RELEASE COMMITTED removes lock", () => {
    const state: LockState = {
      locks: {
        "res-1": { holder: "client-1", fencingToken: 1n, expiresAt: Date.now() + 60_000, acquiredSeq: 1 },
      },
    };
    const entry = makeEntry(2, "LOCK_RELEASE", "COMMITTED");
    const next = proto.apply(entry, state);
    expect(next.locks["res-1"]).toBeUndefined();
  });

  it("LOCK_EXPIRE COMMITTED removes lock", () => {
    const state: LockState = {
      locks: {
        "res-1": { holder: "client-1", fencingToken: 1n, expiresAt: 0, acquiredSeq: 1 },
      },
    };
    const entry = makeEntry(3, "LOCK_EXPIRE", "COMMITTED");
    const next = proto.apply(entry, state);
    expect(next.locks["res-1"]).toBeUndefined();
  });
});

describe("LockProtocol snapshot", () => {
  it("snapshot round-trip preserves state", () => {
    const state: LockState = {
      locks: {
        "res-1": { holder: "client-1", fencingToken: 42n, expiresAt: 99999, acquiredSeq: 5 },
      },
    };
    const slice = proto.serializeSnapshot(state);
    expect(slice.protocol).toBe("LOCK");
    expect(slice.version).toBe(1);
    const restored = proto.restoreSnapshot(slice, 1);
    expect(restored.locks["res-1"]!.holder).toBe("client-1");
    expect(restored.locks["res-1"]!.acquiredSeq).toBe(5);
    expect(restored.locks["res-1"]!.expiresAt).toBe(99999);
    expect(restored.locks["res-1"]!.fencingToken).toBe(42n);
  });
});
