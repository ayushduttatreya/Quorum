// Shared invariant assertions — run after every chaos scenario

import type { CommittedEntry } from "@quorum/types";

export interface InvariantResult {
  invariant: string;
  passed: boolean;
  evidence?: string;
}

export function assertNoCommittedEntryLost(
  _before: CommittedEntry[],
  _after: CommittedEntry[],
): InvariantResult {
  throw new Error("not implemented");
}

export function assertCommitIndexMonotonic(_entries: CommittedEntry[]): InvariantResult {
  throw new Error("not implemented");
}

export function assertNoDuplicateFencingToken(_entries: CommittedEntry[]): InvariantResult {
  throw new Error("not implemented");
}

export function assertReplayEquivalence(
  _snapshotState: unknown,
  _replayedState: unknown,
): InvariantResult {
  throw new Error("not implemented");
}

export function assertNoStaleEpochCommitted(_entries: CommittedEntry[]): InvariantResult {
  throw new Error("not implemented");
}

export function assertRecoveringModeEntered(_events: string[]): InvariantResult {
  throw new Error("not implemented");
}

export function runAllInvariants(
  entries: CommittedEntry[],
  events: string[],
  beforeState: unknown,
  afterState: unknown,
): InvariantResult[] {
  return [
    assertNoCommittedEntryLost(entries, entries),
    assertCommitIndexMonotonic(entries),
    assertNoDuplicateFencingToken(entries),
    assertReplayEquivalence(beforeState, afterState),
    assertNoStaleEpochCommitted(entries),
    assertRecoveringModeEntered(events),
  ];
}
