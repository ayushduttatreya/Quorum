import type { CommittedEntry } from "@quorum/types";

export interface TimelineEntry {
  seq: number;
  wallClockTs: number;
  protocol: string;
  operation: string;
  resourceKey: string;
  outcome: string;
  clientId: string;
}

export function buildTimeline(entries: CommittedEntry[]): TimelineEntry[] {
  return entries.map((entry) => ({
    seq: entry.seq,
    wallClockTs: entry.wallClockTs,
    protocol: entry.protocol,
    operation: entry.operation,
    resourceKey: entry.resourceKey,
    outcome: entry.outcome,
    clientId: entry.clientId,
  }));
}
