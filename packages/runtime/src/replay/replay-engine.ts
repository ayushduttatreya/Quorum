import type { CommittedEntry } from "@quorum/types";
import type { RclEngine } from "../rcl/rcl-engine.ts";
import type { ProtocolRegistry } from "@quorum/protocol";

export interface ReplayOptions {
  fromSeq: number;
  toSeq?: number;
  initialState?: Record<string, unknown>;
}

export interface ReplayResult {
  entriesReplayed: number;
  finalSeq: number;
  materializedState: Record<string, unknown>;
}

export class ReplayEngine {
  constructor(
    private readonly rclEngine: RclEngine,
    private readonly protocolRegistry: ProtocolRegistry,
  ) {}

  replay(opts: ReplayOptions): ReplayResult {
    let states = opts.initialState ? { ...opts.initialState } : {};
    let cursor = opts.fromSeq;
    let entriesReplayed = 0;
    let finalSeq = opts.fromSeq > 0 ? opts.fromSeq - 1 : 0;
    const toSeq = opts.toSeq ?? Number.MAX_SAFE_INTEGER;

    while (cursor <= toSeq) {
      const batch = this.rclEngine.getEntries({ fromSeq: cursor, limit: 500 });
      if (batch.length === 0) break;

      for (const entry of batch) {
        if (entry.seq > toSeq) break;
        if (!entry.committed) continue;
        // Skip SYSTEM entries (SNAPSHOT_COMPLETE, ENTRY_ROLLBACK, etc.) —
        // they are coordination metadata, not protocol state machine transitions.
        if (!this.protocolRegistry.hasExecutor(entry.protocol)) continue;
        states = this.protocolRegistry.apply(entry as CommittedEntry, states);
        entriesReplayed++;
        finalSeq = entry.seq;
      }

      cursor = (batch[batch.length - 1]?.seq ?? cursor) + 1;
      if (batch.length < 500) break;
    }

    return { entriesReplayed, finalSeq, materializedState: states };
  }

  verifyDeterminism(
    fromSeq: number,
    baseState: Record<string, unknown>,
    expectedState: Record<string, unknown>,
  ): boolean {
    const result = this.replay({ fromSeq, initialState: baseState });
    const serialize = (v: unknown) =>
      JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
    return serialize(result.materializedState) === serialize(expectedState);
  }

  reconstructTimeline(fromSeq: number, toSeq: number): CommittedEntry[] {
    if (toSeq < fromSeq) return [];
    return this.rclEngine
      .getEntries({ fromSeq, limit: toSeq - fromSeq + 1 })
      .filter((e) => e.committed) as CommittedEntry[];
  }
}
