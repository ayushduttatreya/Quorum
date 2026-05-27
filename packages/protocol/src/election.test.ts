import { describe, it, expect } from "vitest";
import { ElectionProtocol, type ElectionState } from "./election.ts";

const proto = new ElectionProtocol();
const NOW = 1_000_000;

function idle(): ElectionState {
  return { currentLeader: null, currentTerm: 0, leaderLeaseExpiry: 0, electionWindow: null, nominations: [] };
}

function withWindow(): ElectionState {
  return { ...idle(), electionWindow: { baseSeq: 0, windowSize: 64 } };
}

function withLeader(expiry = NOW + 30_000): ElectionState {
  return { currentLeader: "alice", currentTerm: 1, leaderLeaseExpiry: expiry, electionWindow: null, nominations: [] };
}

function makeInput(operation: string, payload: Record<string, unknown> = {}) {
  return {
    protocol: "ELECTION" as const, protocolVersion: 1, operation: operation as any,
    resourceKey: "group-1", payload: { wallClockTs: NOW, ...payload },
    idempotencyKey: "idem-1", traceId: "trace-1", clientId: "alice",
  };
}

function makeEntry(seq: number, operation: string, outcome: "COMMITTED" | "REJECTED", payload: Record<string, unknown> = {}) {
  return { ...makeInput(operation, payload), seq, term: 1, epoch: 1, wallClockTs: NOW, checksum: "abc", committed: true as const, outcome };
}

describe("ElectionProtocol.validate", () => {
  it("ELECTION_OPEN on idle → COMMITTED", () => {
    expect(proto.validate(makeInput("ELECTION_OPEN", { baseSeq: 0, windowSize: 64 }), idle()).outcome).toBe("COMMITTED");
  });

  it("ELECTION_OPEN when window open → REJECTED ELECTION_ALREADY_RUNNING", () => {
    expect(proto.validate(makeInput("ELECTION_OPEN", { baseSeq: 0, windowSize: 64 }), withWindow()).reason).toBe("ELECTION_ALREADY_RUNNING");
  });

  it("ELECTION_OPEN when leader active → REJECTED LEADER_ACTIVE", () => {
    expect(proto.validate(makeInput("ELECTION_OPEN", { baseSeq: 0, windowSize: 64 }), withLeader()).reason).toBe("LEADER_ACTIVE");
  });

  it("ELECTION_NOMINATE during open window → COMMITTED", () => {
    expect(proto.validate(makeInput("ELECTION_NOMINATE", { candidateId: "alice" }), withWindow()).outcome).toBe("COMMITTED");
  });

  it("ELECTION_NOMINATE with no window → REJECTED NO_ELECTION_OPEN", () => {
    expect(proto.validate(makeInput("ELECTION_NOMINATE", { candidateId: "alice" }), idle()).reason).toBe("NO_ELECTION_OPEN");
  });

  it("ELECTION_NOMINATE with empty candidateId → REJECTED INVALID_CANDIDATE", () => {
    expect(proto.validate(makeInput("ELECTION_NOMINATE", { candidateId: "" }), withWindow()).reason).toBe("INVALID_CANDIDATE");
  });

  it("ELECTION_CLOSE during open window → COMMITTED", () => {
    expect(proto.validate(makeInput("ELECTION_CLOSE"), withWindow()).outcome).toBe("COMMITTED");
  });

  it("ELECTION_CLOSE with no window → REJECTED NO_ELECTION_OPEN", () => {
    expect(proto.validate(makeInput("ELECTION_CLOSE"), idle()).reason).toBe("NO_ELECTION_OPEN");
  });

  it("LEADER_ESTABLISHED after close → COMMITTED", () => {
    const closed = { ...withWindow(), electionWindow: null };
    expect(proto.validate(makeInput("LEADER_ESTABLISHED", { candidateId: "alice", leaseTtl: 30_000 }), closed).outcome).toBe("COMMITTED");
  });

  it("LEADER_ESTABLISHED while window open → REJECTED ELECTION_STILL_OPEN", () => {
    expect(proto.validate(makeInput("LEADER_ESTABLISHED", { candidateId: "alice", leaseTtl: 30_000 }), withWindow()).reason).toBe("ELECTION_STILL_OPEN");
  });

  it("LEADER_EXPIRED always → COMMITTED", () => {
    expect(proto.validate(makeInput("LEADER_EXPIRED"), withLeader()).outcome).toBe("COMMITTED");
  });
});

describe("ElectionProtocol.apply", () => {
  it("ELECTION_OPEN sets electionWindow and clears nominations", () => {
    const stateWithNom = { ...idle(), nominations: [{ candidateId: "old", seq: 0, term: 1 }] };
    const next = proto.apply(makeEntry(1, "ELECTION_OPEN", "COMMITTED", { baseSeq: 0, windowSize: 64 }) as any, stateWithNom);
    expect(next.electionWindow).not.toBeNull();
    expect(next.nominations).toHaveLength(0);
  });

  it("LEADER_ESTABLISHED sets leader, increments term, clears nominations", () => {
    const closed = { ...withWindow(), electionWindow: null };
    const next = proto.apply(makeEntry(5, "LEADER_ESTABLISHED", "COMMITTED", { candidateId: "alice", leaseTtl: 30_000 }) as any, closed);
    expect(next.currentLeader).toBe("alice");
    expect(next.currentTerm).toBe(1);
    expect(next.leaderLeaseExpiry).toBe(NOW + 30_000);
    expect(next.nominations).toHaveLength(0);
  });

  it("LEADER_EXPIRED clears leader, preserves currentTerm", () => {
    const next = proto.apply(makeEntry(6, "LEADER_EXPIRED", "COMMITTED") as any, withLeader());
    expect(next.currentLeader).toBeNull();
    expect(next.currentTerm).toBe(1);
  });
});

describe("ElectionProtocol.selectWinner", () => {
  it("single nomination → that candidateId", () => {
    expect(ElectionProtocol.selectWinner([{ candidateId: "alice", seq: 5, term: 1 }])).toBe("alice");
  });

  it("multiple nominations → lowest seq wins", () => {
    const noms = [
      { candidateId: "charlie", seq: 7, term: 1 },
      { candidateId: "alice", seq: 3, term: 1 },
      { candidateId: "bob", seq: 5, term: 1 },
    ];
    expect(ElectionProtocol.selectWinner(noms)).toBe("alice");
  });

  it("deduplicates candidateId — earliest seq survives; overall lowest seq wins", () => {
    const noms = [
      { candidateId: "alice", seq: 4, term: 1 },
      { candidateId: "alice", seq: 2, term: 1 },
      { candidateId: "bob", seq: 1, term: 1 },
    ];
    expect(ElectionProtocol.selectWinner(noms)).toBe("bob");
  });

  it("empty nominations → null", () => {
    expect(ElectionProtocol.selectWinner([])).toBeNull();
  });
});

describe("ElectionProtocol snapshot", () => {
  it("snapshot round-trip preserves all fields including null and nested objects", () => {
    const state = withLeader();
    state.nominations = [{ candidateId: "alice", seq: 1, term: 1 }];
    const slice = proto.serializeSnapshot(state);
    const restored = proto.restoreSnapshot(slice, 1);
    expect(restored.currentLeader).toBe("alice");
    expect(restored.currentTerm).toBe(1);
    expect(restored.nominations).toHaveLength(1);
  });
});
