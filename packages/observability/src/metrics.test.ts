import { describe, it, expect } from "vitest";
import { MetricsMaterializer } from "./metrics.ts";
import type { RclSubscriber, EntryHandler } from "./rcl-subscriber.ts";

function makeSubscriberStub(): { subscriber: RclSubscriber; deliver: EntryHandler } {
  let handler: EntryHandler | null = null;
  const subscriber = {
    subscribe: (h: EntryHandler) => { handler = h; return () => {}; },
  } as unknown as RclSubscriber;
  return { subscriber, deliver: (e) => handler?.(e) };
}

function makeEntry(operation: string, outcome: "COMMITTED" | "REJECTED", resourceKey = "res-1") {
  return {
    seq: 1, term: 1, epoch: 1, wallClockTs: 1000,
    protocol: "LOCK", protocolVersion: 1, operation,
    resourceKey, payload: {}, checksum: "abc",
    committed: true as const, outcome,
    idempotencyKey: "idem", traceId: "trace", clientId: "client",
  };
}

describe("MetricsMaterializer", () => {
  it("increments COMMITTED count on LOCK_ACQUIRE COMMITTED", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver(makeEntry("LOCK_ACQUIRE", "COMMITTED") as any);
    expect(m.getMetrics().lockAcquisitionsTotal["COMMITTED"]).toBe(1);
  });

  it("increments REJECTED count on LOCK_ACQUIRE REJECTED", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver(makeEntry("LOCK_ACQUIRE", "REJECTED") as any);
    expect(m.getMetrics().lockAcquisitionsTotal["REJECTED"]).toBe(1);
  });

  it("lockContentionEvents increments when REJECTED then COMMITTED on same key", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver(makeEntry("LOCK_ACQUIRE", "REJECTED", "res-1") as any);
    deliver(makeEntry("LOCK_ACQUIRE", "COMMITTED", "res-1") as any);
    expect(m.getMetrics().lockContentionEvents).toBe(1);
  });

  it("lockContentionEvents does not increment without COMMITTED follow-up", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver(makeEntry("LOCK_ACQUIRE", "REJECTED", "res-1") as any);
    expect(m.getMetrics().lockContentionEvents).toBe(0);
  });

  it("replicaHealthChanges increments on REPLICA_HEALTH_CHANGE", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver({ ...makeEntry("REPLICA_HEALTH_CHANGE", "COMMITTED"), protocol: "SYSTEM", operation: "REPLICA_HEALTH_CHANGE" } as any);
    expect(m.getMetrics().replicaHealthChanges).toBe(1);
  });

  it("getMetrics() returns a copy", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver(makeEntry("LOCK_ACQUIRE", "COMMITTED") as any);
    const snap = m.getMetrics();
    snap.lockAcquisitionsTotal["COMMITTED"] = 999;
    expect(m.getMetrics().lockAcquisitionsTotal["COMMITTED"]).toBe(1);
  });

  it("unknown operation entries ignored without error", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const m = new MetricsMaterializer(subscriber);
    deliver({ ...makeEntry("WORKFLOW_STARTED", "COMMITTED"), protocol: "WORKFLOW" } as any);
    expect(m.getMetrics().lockAcquisitionsTotal).toEqual({});
  });
});
