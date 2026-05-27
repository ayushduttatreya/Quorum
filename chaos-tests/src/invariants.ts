import type { CommittedEntry } from "@quorum/types";

export interface InvariantResult {
  invariant: string;
  passed: boolean;
  evidence?: string;
}

// S1 — No committed entry lost under eviction or compaction
export function assertNoCommittedEntryLost(
  before: CommittedEntry[],
  after: CommittedEntry[],
): InvariantResult {
  const afterSeqs = new Set(after.map((e) => e.seq));
  const missing = before
    .filter((e) => e.committed && !afterSeqs.has(e.seq))
    .map((e) => e.seq);
  return {
    invariant: "S1: No committed entry lost",
    passed: missing.length === 0,
    evidence: missing.length > 0 ? `Missing seqs: ${missing.join(", ")}` : undefined,
  };
}

// S2 — Commit index (seq of committed entries) never decreases
export function assertCommitIndexMonotonic(entries: CommittedEntry[]): InvariantResult {
  const committed = entries.filter((e) => e.committed);
  let lastSeq = 0;
  for (const e of committed) {
    if (e.seq <= lastSeq) {
      return {
        invariant: "S2: Commit index monotonic",
        passed: false,
        evidence: `seq=${e.seq} appeared after seq=${lastSeq} — commit index went backward`,
      };
    }
    lastSeq = e.seq;
  }
  return { invariant: "S2: Commit index monotonic", passed: true };
}

// S3/S4 — No two committed LOCK_ACQUIRE entries share the same fencing token
export function assertNoDuplicateFencingToken(entries: CommittedEntry[]): InvariantResult {
  const seen = new Map<string, number>();
  for (const e of entries) {
    if (
      e.protocol === "LOCK" &&
      e.operation === "LOCK_ACQUIRE" &&
      e.committed &&
      e.outcome === "COMMITTED"
    ) {
      const token = `${(BigInt(e.term) << 32n) | BigInt(e.seq)}`;
      if (seen.has(token)) {
        return {
          invariant: "S3/S4: No duplicate fencing token",
          passed: false,
          evidence: `Token ${token} appears at seq=${seen.get(token)} and seq=${e.seq}`,
        };
      }
      seen.set(token, e.seq);
    }
  }
  return { invariant: "S3/S4: No duplicate fencing token", passed: true };
}

// S5 — Snapshot + delta replay produces identical state to full replay
export function assertReplayEquivalence(
  snapshotState: unknown,
  replayedState: unknown,
): InvariantResult {
  const serialize = (v: unknown) =>
    JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
  const a = serialize(snapshotState);
  const b = serialize(replayedState);
  return {
    invariant: "S5: Replay equivalence",
    passed: a === b,
    evidence:
      a !== b
        ? `States differ. Full: ${a.slice(0, 100)} | Delta: ${b.slice(0, 100)}`
        : undefined,
  };
}

// S6 — No committed entry has epoch below the current running epoch
export function assertNoStaleEpochCommitted(entries: CommittedEntry[]): InvariantResult {
  let maxEpoch = 0;
  for (const e of entries) {
    if (e.committed && e.outcome === "COMMITTED") {
      if (e.epoch < maxEpoch) {
        return {
          invariant: "S6: No stale epoch committed",
          passed: false,
          evidence: `seq=${e.seq} has epoch=${e.epoch} but maxEpoch=${maxEpoch}`,
        };
      }
      maxEpoch = Math.max(maxEpoch, e.epoch);
    }
  }
  return { invariant: "S6: No stale epoch committed", passed: true };
}

// Recovery — ENTRY_ROLLBACK or ENTRY_STALE_EPOCH_DISCARDED was committed
export function assertRecoveringModeEntered(entries: CommittedEntry[]): InvariantResult {
  const recoveryOps = ["ENTRY_ROLLBACK", "ENTRY_STALE_EPOCH_DISCARDED"];
  const found = entries.some((e) => recoveryOps.includes(e.operation) && e.committed);
  return {
    invariant: "Recovery mode: rollback/stale entries committed",
    passed: found,
    evidence: found
      ? undefined
      : "No ENTRY_ROLLBACK or ENTRY_STALE_EPOCH_DISCARDED found — recovery may not have run",
  };
}

export function runAllInvariants(
  entriesBefore: CommittedEntry[],
  entriesAfter: CommittedEntry[],
  beforeState: unknown,
  afterState: unknown,
): InvariantResult[] {
  return [
    assertNoCommittedEntryLost(entriesBefore, entriesAfter),
    assertCommitIndexMonotonic(entriesAfter),
    assertNoDuplicateFencingToken(entriesAfter),
    assertReplayEquivalence(beforeState, afterState),
    assertNoStaleEpochCommitted(entriesAfter),
    assertRecoveringModeEntered(entriesAfter),
  ];
}

export function printChaosReport(scenarioName: string, results: InvariantResult[]): void {
  const bar = "═".repeat(47);
  const sep = "─".repeat(47);
  console.log(`\n${bar}`);
  console.log(` CHAOS SCENARIO: ${scenarioName}`);
  console.log(bar);
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(` ${icon}  ${r.invariant}`);
    if (!r.passed && r.evidence) {
      console.log(`     Evidence: ${r.evidence}`);
    }
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(sep);
  console.log(` RESULT: ${passed}/${results.length} invariants passed`);
  console.log(`${bar}\n`);
}
