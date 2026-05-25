import type { CommittedEntry } from "@quorum/types";

export interface TimelineEvent {
  seq: number;
  wallClockTs: number;
  protocol: string;
  operation: string;
  resourceKey: string;
  outcome: string;
  metadata: Record<string, unknown>;
}

export class TimelineBuilder {
  buildTimeline(entries: CommittedEntry[]): TimelineEvent[] {
    throw new Error("not implemented");
  }

  filterByProtocol(events: TimelineEvent[], protocols: string[]): TimelineEvent[] {
    throw new Error("not implemented");
  }

  filterByResource(events: TimelineEvent[], resourceKey: string): TimelineEvent[] {
    throw new Error("not implemented");
  }
}
