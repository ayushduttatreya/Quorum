import type { CommittedEntry } from "@quorum/types";
import type { RclSubscriber } from "./rcl-subscriber.ts";

export interface SpanRecord {
  traceId: string;
  operation: string;
  resourceKey: string;
  outcome: string;
  startSeq: number;
  wallClockTs: number;
  durationSeqs: number;
}

const RING_CAPACITY = 1000;

export class TraceEmitter {
  private readonly ring: (SpanRecord | undefined)[] = new Array(RING_CAPACITY);
  private writeIdx = 0;
  private totalCompleted = 0;
  private readonly openSpans = new Map<string, SpanRecord>();

  constructor(subscriber: RclSubscriber) {
    subscriber.subscribe((entry) => this.processEntry(entry));
  }

  getRecentSpans(limit = 100): SpanRecord[] {
    const clampedLimit = Math.min(limit, RING_CAPACITY);
    const count = Math.min(this.totalCompleted, clampedLimit);
    const result: SpanRecord[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.writeIdx - 1 - i + RING_CAPACITY) % RING_CAPACITY;
      const s = this.ring[idx];
      if (s) result.push(s);
    }
    return result;
  }

  private processEntry(entry: CommittedEntry): void {
    if (entry.protocol !== "LOCK") return;

    if (entry.operation === "LOCK_ACQUIRE") {
      const span: SpanRecord = {
        traceId: entry.traceId,
        operation: entry.operation,
        resourceKey: entry.resourceKey,
        outcome: entry.outcome,
        startSeq: entry.seq,
        wallClockTs: entry.wallClockTs,
        durationSeqs: 0,
      };
      this.openSpans.set(entry.resourceKey, span);
      this.commitSpan(span);
    } else if (entry.operation === "LOCK_RELEASE" || entry.operation === "LOCK_EXPIRE") {
      const open = this.openSpans.get(entry.resourceKey);
      if (open) {
        open.durationSeqs = entry.seq - open.startSeq;
        this.openSpans.delete(entry.resourceKey);
      }
    }
  }

  private commitSpan(span: SpanRecord): void {
    this.ring[this.writeIdx] = span;
    this.writeIdx = (this.writeIdx + 1) % RING_CAPACITY;
    this.totalCompleted += 1;
  }
}
