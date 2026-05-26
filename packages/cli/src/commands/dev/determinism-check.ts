import type { LogEntry, Snapshot, CommittedEntry } from "@quorum/types";
import { ProtocolRegistry, LockProtocol } from "@quorum/protocol";

export interface DeterminismCheckResult {
  passed: boolean;
  entriesChecked: number;
  snapshotSeq: number | null;
  fullStateJson: string;
  deltaStateJson: string;
}

export interface DeterminismCheckOptions {
  namespace: string;
  url: string;
}

function buildRegistry(): ProtocolRegistry {
  const registry = new ProtocolRegistry();
  registry.register(new LockProtocol());
  return registry;
}

function serializeState(state: Record<string, unknown>): string {
  return JSON.stringify(state, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

function replayEntries(
  entries: LogEntry[],
  fromSeq: number,
  initialState: Record<string, unknown>,
  registry: ProtocolRegistry,
): {
  entriesReplayed: number;
  finalSeq: number;
  materializedState: Record<string, unknown>;
} {
  let states = { ...initialState };
  let entriesReplayed = 0;
  let finalSeq = fromSeq > 0 ? fromSeq - 1 : 0;

  for (const entry of entries) {
    if (entry.seq < fromSeq) continue;
    if (!entry.committed) continue;
    if (!registry.hasExecutor(entry.protocol)) continue;
    states = registry.apply(entry as CommittedEntry, states);
    entriesReplayed++;
    finalSeq = entry.seq;
  }

  return { entriesReplayed, finalSeq, materializedState: states };
}

export function runDeterminismCheck(
  entries: LogEntry[],
  snapshot: Snapshot | null,
): DeterminismCheckResult {
  const registry = buildRegistry();

  // Full replay from seq 0
  const fullResult = replayEntries(entries, 0, {}, registry);

  // Delta replay: restore snapshot base state, replay from snapshot.seq+1
  let deltaResult;
  let snapshotSeq: number | null = null;

  if (snapshot) {
    snapshotSeq = snapshot.seq;
    const restoredBase = registry.restoreAllSnapshots(
      snapshot.slices,
      snapshot.protocolVersions,
    );
    deltaResult = replayEntries(entries, snapshot.seq + 1, restoredBase, registry);
  } else {
    deltaResult = replayEntries(entries, 0, {}, registry);
  }

  const fullStateJson = serializeState(fullResult.materializedState);
  const deltaStateJson = serializeState(deltaResult.materializedState);

  return {
    passed: fullStateJson === deltaStateJson,
    entriesChecked: fullResult.entriesReplayed,
    snapshotSeq,
    fullStateJson,
    deltaStateJson,
  };
}

export async function runDeterminismCheckFromServer(
  opts: DeterminismCheckOptions,
): Promise<DeterminismCheckResult> {
  const base = opts.url.replace(/\/$/, "");

  const health = (await fetch(`${base}/health`).then((r) =>
    r.json(),
  )) as { mode: string; commitIndex: number };

  if (health.mode !== "ACTIVE") {
    throw new Error(
      `Runtime is in ${health.mode} mode — cannot run determinism check`,
    );
  }

  const entries = (await fetch(
    `${base}/entries?fromSeq=0&limit=${health.commitIndex + 100}`,
  ).then((r) => r.json())) as LogEntry[];

  const snapshot = (await fetch(`${base}/snapshot`).then((r) =>
    r.json(),
  )) as Snapshot | null;

  return runDeterminismCheck(entries, snapshot);
}
