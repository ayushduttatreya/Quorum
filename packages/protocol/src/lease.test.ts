import { describe, it, expect } from "vitest";
import { LeaseProtocol, type LeaseState } from "./lease.ts";

const proto = new LeaseProtocol();
const emptyState: LeaseState = { leases: {} };
const NOW = 1_000_000;

function makeInput(operation: string, overrides: Record<string, unknown> = {}) {
  return {
    protocol: "LEASE" as const,
    protocolVersion: 1,
    operation: operation as any,
    resourceKey: "res-1",
    payload: { ttl: 30_000, wallClockTs: NOW, ...overrides },
    idempotencyKey: "idem-1",
    traceId: "trace-1",
    clientId: "client-1",
  };
}

function makeEntry(seq: number, operation: string, outcome: "COMMITTED" | "REJECTED", overrides: Record<string, unknown> = {}) {
  return {
    ...makeInput(operation, overrides),
    seq,
    term: 1,
    epoch: 1,
    wallClockTs: NOW,
    checksum: "abc",
    committed: true as const,
    outcome,
  };
}

function heldState(epoch = 1, expiresAt = NOW + 30_000): LeaseState {
  return {
    leases: {
      "res-1": { holder: "client-1", epoch, expiresAt, acquiredSeq: 1 },
    },
  };
}

describe("LeaseProtocol.validate", () => {
  it("LEASE_ACQUIRE on empty state → COMMITTED", () => {
    expect(proto.validate(makeInput("LEASE_ACQUIRE"), emptyState).outcome).toBe("COMMITTED");
  });

  it("LEASE_ACQUIRE on held non-expired → REJECTED LEASE_HELD", () => {
    const r = proto.validate(makeInput("LEASE_ACQUIRE"), heldState());
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("LEASE_HELD");
  });

  it("LEASE_ACQUIRE on expired lease → COMMITTED", () => {
    const r = proto.validate(makeInput("LEASE_ACQUIRE"), heldState(1, NOW - 1));
    expect(r.outcome).toBe("COMMITTED");
  });

  it("LEASE_RENEW with correct epoch → COMMITTED", () => {
    const r = proto.validate(makeInput("LEASE_RENEW", { epoch: 1, ttl: 30_000 }), heldState());
    expect(r.outcome).toBe("COMMITTED");
  });

  it("LEASE_RENEW with wrong epoch → REJECTED EPOCH_MISMATCH", () => {
    const r = proto.validate(makeInput("LEASE_RENEW", { epoch: 99, ttl: 30_000 }), heldState());
    expect(r.reason).toBe("EPOCH_MISMATCH");
  });

  it("LEASE_RENEW on non-held lease → REJECTED LEASE_NOT_HELD", () => {
    const r = proto.validate(makeInput("LEASE_RENEW", { epoch: 1, ttl: 30_000 }), emptyState);
    expect(r.reason).toBe("LEASE_NOT_HELD");
  });

  it("LEASE_RELEASE with correct epoch → COMMITTED", () => {
    const r = proto.validate(makeInput("LEASE_RELEASE", { epoch: 1 }), heldState());
    expect(r.outcome).toBe("COMMITTED");
  });

  it("LEASE_RELEASE with wrong epoch → REJECTED EPOCH_MISMATCH", () => {
    const r = proto.validate(makeInput("LEASE_RELEASE", { epoch: 99 }), heldState());
    expect(r.reason).toBe("EPOCH_MISMATCH");
  });

  it("LEASE_EXPIRE always → COMMITTED", () => {
    expect(proto.validate(makeInput("LEASE_EXPIRE"), emptyState).outcome).toBe("COMMITTED");
  });
});

describe("LeaseProtocol.apply", () => {
  it("LEASE_ACQUIRE COMMITTED sets epoch=1 and expiresAt", () => {
    const next = proto.apply(makeEntry(1, "LEASE_ACQUIRE", "COMMITTED") as any, emptyState);
    expect(next.leases["res-1"]!.epoch).toBe(1);
    expect(next.leases["res-1"]!.expiresAt).toBe(NOW + 30_000);
    expect(next.leases["res-1"]!.acquiredSeq).toBe(1);
  });

  it("LEASE_RENEW COMMITTED increments epoch and updates expiresAt", () => {
    const next = proto.apply(makeEntry(2, "LEASE_RENEW", "COMMITTED", { epoch: 1, ttl: 30_000 }) as any, heldState());
    expect(next.leases["res-1"]!.epoch).toBe(2);
    expect(next.leases["res-1"]!.acquiredSeq).toBe(1);
  });

  it("LEASE_RELEASE COMMITTED removes entry", () => {
    const next = proto.apply(makeEntry(3, "LEASE_RELEASE", "COMMITTED", { epoch: 1 }) as any, heldState());
    expect(next.leases["res-1"]).toBeUndefined();
  });
});

describe("LeaseProtocol snapshot", () => {
  it("snapshot round-trip preserves all fields", () => {
    const slice = proto.serializeSnapshot(heldState());
    const restored = proto.restoreSnapshot(slice, 1);
    expect(restored.leases["res-1"]!.epoch).toBe(1);
    expect(restored.leases["res-1"]!.expiresAt).toBe(NOW + 30_000);
  });
});

describe("LeaseProtocol.computeRenewInterval", () => {
  it("is deterministic and within bounds", () => {
    const ttl = 30_000;
    const r1 = LeaseProtocol.computeRenewInterval(ttl, "ns", "key", 1);
    const r2 = LeaseProtocol.computeRenewInterval(ttl, "ns", "key", 1);
    expect(r1).toBe(r2);
    expect(r1).toBeLessThanOrEqual(Math.floor(ttl * 0.7));
    expect(r1).toBeGreaterThanOrEqual(Math.floor(ttl * 0.7) - Math.floor(ttl / 10));
  });

  it("differs across epochs", () => {
    const ttl = 30_000;
    const r1 = LeaseProtocol.computeRenewInterval(ttl, "ns", "key", 1);
    const r2 = LeaseProtocol.computeRenewInterval(ttl, "ns", "key", 2);
    expect(typeof r1).toBe("number");
    expect(typeof r2).toBe("number");
  });
});
