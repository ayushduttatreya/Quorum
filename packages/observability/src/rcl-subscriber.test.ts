import { describe, it, expect } from "vitest";
import { RclSubscriber } from "./rcl-subscriber.ts";
import type { RclEngineReader } from "./rcl-subscriber.ts";

function makeEntry(seq: number, committed = true) {
  return {
    seq, committed, term: 1, epoch: 1, wallClockTs: 1000 + seq,
    protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
    resourceKey: "res-1", payload: {}, checksum: "abc", outcome: "COMMITTED",
    idempotencyKey: `idem-${seq}`, traceId: `trace-${seq}`, clientId: "client",
  };
}

function makeEngine(entries: ReturnType<typeof makeEntry>[]): RclEngineReader {
  return {
    getEntries: ({ fromSeq, limit }) =>
      entries.filter((e) => e.seq >= fromSeq).slice(0, limit),
    getLatestCommittedSeq: () =>
      entries.filter((e) => e.committed).reduce((m, e) => Math.max(m, e.seq), 0),
  };
}

describe("RclSubscriber", () => {
  it("delivers committed entries to handler in seq order", () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const sub = new RclSubscriber(makeEngine(entries));
    const received: number[] = [];
    sub.subscribe((e) => received.push(e.seq));
    sub.poll();
    expect(received).toEqual([1, 2, 3]);
  });

  it("does not deliver uncommitted entries", () => {
    const entries = [makeEntry(1), makeEntry(2, false), makeEntry(3)];
    const sub = new RclSubscriber(makeEngine(entries));
    const received: number[] = [];
    sub.subscribe((e) => received.push(e.seq));
    sub.poll();
    expect(received).toEqual([1, 3]);
  });

  it("advances cursor after delivery", () => {
    const entries = [makeEntry(1), makeEntry(2)];
    const sub = new RclSubscriber(makeEngine(entries));
    sub.subscribe(() => {});
    sub.poll();
    expect(sub.getCursor()).toBe(3);
  });

  it("handler exception does not stop delivery to other handlers", () => {
    const entries = [makeEntry(1)];
    const sub = new RclSubscriber(makeEngine(entries));
    const received: number[] = [];
    sub.subscribe(() => { throw new Error("boom"); });
    sub.subscribe((e) => received.push(e.seq));
    sub.poll();
    expect(received).toEqual([1]);
  });

  it("unsubscribe removes handler", () => {
    const entries = [makeEntry(1)];
    const sub = new RclSubscriber(makeEngine(entries));
    const received: number[] = [];
    const unsub = sub.subscribe((e) => received.push(e.seq));
    unsub();
    sub.poll();
    expect(received).toEqual([]);
  });

  it("start() is idempotent", () => {
    const sub = new RclSubscriber(makeEngine([]));
    sub.start();
    sub.start();
    sub.stop();
    expect(sub.getCursor()).toBe(0);
  });

  it("stop() before start() is a no-op", () => {
    const sub = new RclSubscriber(makeEngine([]));
    expect(() => sub.stop()).not.toThrow();
  });
});
