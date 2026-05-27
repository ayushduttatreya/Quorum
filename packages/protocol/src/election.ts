import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";
import { SnapshotCompatibilityError } from "@quorum/types";

export interface ElectionState {
  currentLeader: string | null;
  currentTerm: number;
  leaderLeaseExpiry: number;
  electionWindow: { baseSeq: number; windowSize: number } | null;
  nominations: Array<{ candidateId: string; seq: number; term: number }>;
}

function simpleHash(data: Uint8Array): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class ElectionProtocol implements ProtocolExecutor<ElectionState> {
  readonly protocol = "ELECTION";
  readonly version = 1;

  initialState(): ElectionState {
    return {
      currentLeader: null,
      currentTerm: 0,
      leaderLeaseExpiry: 0,
      electionWindow: null,
      nominations: [],
    };
  }

  validate(input: LogEntryInput, state: ElectionState): ValidationResult {
    const { operation, payload } = input;
    const now = (payload["wallClockTs"] as number | undefined) ?? Date.now();

    if (operation === "ELECTION_OPEN") {
      if (state.electionWindow !== null) {
        return { valid: false, outcome: "REJECTED", reason: "ELECTION_ALREADY_RUNNING" };
      }
      if (state.currentLeader !== null && state.leaderLeaseExpiry >= now) {
        return { valid: false, outcome: "REJECTED", reason: "LEADER_ACTIVE" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "ELECTION_NOMINATE") {
      if (state.electionWindow === null) {
        return { valid: false, outcome: "REJECTED", reason: "NO_ELECTION_OPEN" };
      }
      const candidateId = payload["candidateId"] as string;
      if (!candidateId || candidateId === "") {
        return { valid: false, outcome: "REJECTED", reason: "INVALID_CANDIDATE" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "ELECTION_CLOSE") {
      if (state.electionWindow === null) {
        return { valid: false, outcome: "REJECTED", reason: "NO_ELECTION_OPEN" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "LEADER_ESTABLISHED") {
      if (state.electionWindow !== null) {
        return { valid: false, outcome: "REJECTED", reason: "ELECTION_STILL_OPEN" };
      }
      if (state.currentLeader !== null && state.leaderLeaseExpiry >= now) {
        return { valid: false, outcome: "REJECTED", reason: "LEADER_ACTIVE" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "LEADER_EXPIRED") {
      return { valid: true, outcome: "COMMITTED" };
    }

    throw new Error(`unknown election operation: ${operation}`);
  }

  apply(entry: CommittedEntry, state: ElectionState): ElectionState {
    if (entry.outcome === "REJECTED") return state;

    const { operation, payload, wallClockTs, seq, term } = entry;

    if (operation === "ELECTION_OPEN") {
      return {
        ...state,
        electionWindow: {
          baseSeq: payload["baseSeq"] as number,
          windowSize: payload["windowSize"] as number,
        },
        nominations: [],
      };
    }

    if (operation === "ELECTION_NOMINATE") {
      return {
        ...state,
        nominations: [
          ...state.nominations,
          { candidateId: payload["candidateId"] as string, seq, term },
        ],
      };
    }

    if (operation === "ELECTION_CLOSE") {
      return { ...state, electionWindow: null };
    }

    if (operation === "LEADER_ESTABLISHED") {
      return {
        ...state,
        currentLeader: payload["candidateId"] as string,
        currentTerm: state.currentTerm + 1,
        leaderLeaseExpiry: wallClockTs + (payload["leaseTtl"] as number),
        electionWindow: null,
        nominations: [],
      };
    }

    if (operation === "LEADER_EXPIRED") {
      return { ...state, currentLeader: null, leaderLeaseExpiry: 0 };
    }

    return state;
  }

  serializeSnapshot(state: ElectionState): SnapshotSlice {
    const data = new TextEncoder().encode(JSON.stringify(state));
    return { protocol: "ELECTION", version: 1, data, checksum: simpleHash(data) };
  }

  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): ElectionState {
    if (fromVersion !== 1) {
      throw new SnapshotCompatibilityError(
        `ElectionProtocol snapshot version ${fromVersion} is not supported (expected 1)`,
      );
    }
    return JSON.parse(new TextDecoder().decode(slice.data)) as ElectionState;
  }

  static selectWinner(nominations: ElectionState["nominations"]): string | null {
    if (nominations.length === 0) return null;
    const byCandidate = new Map<string, { candidateId: string; seq: number; term: number }>();
    for (const nom of nominations) {
      const existing = byCandidate.get(nom.candidateId);
      if (!existing || nom.seq < existing.seq) {
        byCandidate.set(nom.candidateId, nom);
      }
    }
    const sorted = [...byCandidate.values()].sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.candidateId.localeCompare(b.candidateId),
    );
    return sorted[0]!.candidateId;
  }
}
