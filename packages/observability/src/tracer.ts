import type { CommittedEntry } from "@quorum/types";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startSeq: number;
  endSeq?: number;
  events: Array<{ seq: number; name: string; attributes: Record<string, unknown> }>;
  attributes: Record<string, unknown>;
}

export class TraceEmitter {
  private readonly spans = new Map<string, TraceSpan>();

  processEntry(entry: CommittedEntry): TraceSpan | null {
    throw new Error("not implemented");
  }

  getSpan(traceId: string): TraceSpan | undefined {
    return this.spans.get(traceId);
  }

  exportOtelJson(traceId: string): Record<string, unknown> {
    throw new Error("not implemented");
  }
}
