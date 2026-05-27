import { describe, it, expect } from "vitest";
import { TraceEmitter } from "./tracer.ts";
import type { RclSubscriber, EntryHandler } from "./rcl-subscriber.ts";

function makeSubscriberStub(): { subscriber: RclSubscriber; deliver: EntryHandler } {
  let handler: EntryHandler | null = null;
  const subscriber = {
    subscribe: (h: EntryHandler) => { handler = h; return () => {}; },
  } as unknown as RclSubscriber;
  return { subscriber, deliver: (e) => handler?.(e) };
}

function makeEntry(seq: number, operation: string, outcome: "COMMITTED" | "REJECTED" = "COMMITTED", resourceKey = "res-1") {
  return {
    seq, term: 1, epoch: 1, wallClockTs: 1000 + seq,
    protocol: "LOCK", protocolVersion: 1, operation,
    resourceKey, payload: {}, checksum: "abc",
    committed: true as const, outcome,
    idempotencyKey: `idem-${seq}`, traceId: `trace-${seq}`, clientId: "client",
  };
}

describe("TraceEmitter", () => {
  it("LOCK_ACQUIRE COMMITTED creates SpanRecord", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    deliver(makeEntry(1, "LOCK_ACQUIRE") as any);
    const spans = tracer.getRecentSpans(1);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.operation).toBe("LOCK_ACQUIRE");
    expect(spans[0]!.startSeq).toBe(1);
  });

  it("LOCK_ACQUIRE REJECTED creates SpanRecord with outcome REJECTED", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    deliver(makeEntry(1, "LOCK_ACQUIRE", "REJECTED") as any);
    expect(tracer.getRecentSpans(1)[0]!.outcome).toBe("REJECTED");
  });

  it("LOCK_RELEASE closes open span and sets durationSeqs", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    deliver(makeEntry(1, "LOCK_ACQUIRE") as any);
    deliver(makeEntry(5, "LOCK_RELEASE") as any);
    expect(tracer.getRecentSpans(1)[0]!.durationSeqs).toBe(4);
  });

  it("getRecentSpans returns newest first", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    deliver(makeEntry(1, "LOCK_ACQUIRE", "COMMITTED", "res-1") as any);
    deliver(makeEntry(2, "LOCK_ACQUIRE", "COMMITTED", "res-2") as any);
    const spans = tracer.getRecentSpans(2);
    expect(spans[0]!.startSeq).toBeGreaterThan(spans[1]!.startSeq);
  });

  it("getRecentSpans(limit) respects limit", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    for (let i = 1; i <= 5; i++) deliver(makeEntry(i, "LOCK_ACQUIRE", "COMMITTED", `res-${i}`) as any);
    expect(tracer.getRecentSpans(3)).toHaveLength(3);
  });

  it("ring buffer wraps at 1000 — oldest entries evicted", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    for (let i = 1; i <= 1001; i++) deliver(makeEntry(i, "LOCK_ACQUIRE", "COMMITTED", `res-${i}`) as any);
    const spans = tracer.getRecentSpans(1000);
    expect(spans).toHaveLength(1000);
    expect(spans.map((s) => s.startSeq).includes(1)).toBe(false);
  });

  it("getRecentSpans() defaults to 100", () => {
    const { subscriber, deliver } = makeSubscriberStub();
    const tracer = new TraceEmitter(subscriber);
    for (let i = 1; i <= 150; i++) deliver(makeEntry(i, "LOCK_ACQUIRE", "COMMITTED", `res-${i}`) as any);
    expect(tracer.getRecentSpans()).toHaveLength(100);
  });
});
