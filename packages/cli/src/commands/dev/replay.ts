import type { LogEntry, Snapshot } from "@quorum/types";
import { buildRegistry, serializeState, runDeterminismCheck } from "./determinism-check.js";

export interface ReplayCommandOptions {
  from: number;
  to: number;
  dryRun: boolean;
}

export interface ReplayTimelineRow {
  seq: number;
  wallClockTs: number;
  protocol: string;
  operation: string;
  resourceKey: string;
  outcome: string;
}

export interface ReplayCommandResult {
  rows: ReplayTimelineRow[];
  materializedStateJson: string | null;
  determinismPassed: boolean;
}

export interface ReplayCommandHttpOptions extends ReplayCommandOptions {
  namespace: string;
  url: string;
}

export function runReplayCommand(
  entries: LogEntry[],
  snapshot: Snapshot | null,
  opts: ReplayCommandOptions,
): ReplayCommandResult {
  const detResult = runDeterminismCheck(entries, snapshot);

  const filtered = entries.filter(
    (e) => e.seq >= opts.from && e.seq <= opts.to && e.committed,
  );

  if (opts.dryRun) {
    const registry = buildRegistry();
    let states: Record<string, unknown> = {};
    if (snapshot && snapshot.seq < opts.from) {
      states = registry.restoreAllSnapshots(snapshot.slices, snapshot.protocolVersions);
    }
    for (const entry of filtered) {
      if (!registry.hasExecutor(entry.protocol)) continue;
      states = registry.apply(
        { ...entry, committed: true as const, outcome: (entry as any).outcome ?? "COMMITTED" },
        states,
      );
    }
    return {
      rows: [],
      materializedStateJson: serializeState(states),
      determinismPassed: detResult.passed,
    };
  }

  const rows: ReplayTimelineRow[] = filtered.map((e) => ({
    seq: e.seq,
    wallClockTs: e.wallClockTs,
    protocol: e.protocol,
    operation: e.operation,
    resourceKey: e.resourceKey,
    outcome: (e as any).outcome ?? "",
  }));

  return { rows, materializedStateJson: null, determinismPassed: detResult.passed };
}

export async function runReplayCommandFromServer(
  opts: ReplayCommandHttpOptions,
): Promise<ReplayCommandResult> {
  const base = opts.url.replace(/\/$/, "");
  const health = await fetch(`${base}/health`).then((r) => r.json()) as { mode: string; commitIndex: number };
  if (health.mode !== "ACTIVE") throw new Error(`Runtime is in ${health.mode} mode`);

  const limit = opts.to - opts.from + 100;
  const entries = await fetch(`${base}/entries?fromSeq=${opts.from}&limit=${limit}`).then((r) => r.json()) as LogEntry[];
  const snapshot = await fetch(`${base}/snapshot`).then((r) => r.json()) as Snapshot | null;

  return runReplayCommand(entries, snapshot, opts);
}
