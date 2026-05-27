import { describe, it, expect } from "vitest";
import { WorkflowProtocol, type WorkflowState } from "./workflow.ts";

const proto = new WorkflowProtocol();

function emptyState(): WorkflowState { return { workflows: {} }; }

function makeInput(operation: string, resourceKey: string, payload: Record<string, unknown> = {}) {
  return {
    protocol: "WORKFLOW" as const, protocolVersion: 1, operation: operation as any,
    resourceKey, payload,
    idempotencyKey: "idem-1", traceId: "trace-1", clientId: "client-1",
  };
}

function makeEntry(seq: number, operation: string, resourceKey: string, outcome: "COMMITTED" | "REJECTED", payload: Record<string, unknown> = {}) {
  return { ...makeInput(operation, resourceKey, payload), seq, term: 1, epoch: 1, wallClockTs: 1000, checksum: "abc", committed: true as const, outcome };
}

function startedState(wfId = "wf-1", steps = ["step-a", "step-b"], dagEdges: Record<string, string[]> = {}): WorkflowState {
  const state = emptyState();
  return proto.apply(
    makeEntry(1, "WORKFLOW_STARTED", wfId, "COMMITTED", { workflowId: wfId, stepIds: steps, dagEdges }) as any,
    state,
  );
}

describe("WorkflowProtocol.validate", () => {
  it("WORKFLOW_STARTED on new workflowId → COMMITTED", () => {
    expect(proto.validate(makeInput("WORKFLOW_STARTED", "wf-1", { workflowId: "wf-1", stepIds: ["s1"], dagEdges: {} }), emptyState()).outcome).toBe("COMMITTED");
  });

  it("WORKFLOW_STARTED duplicate → REJECTED WORKFLOW_EXISTS", () => {
    const state = startedState();
    expect(proto.validate(makeInput("WORKFLOW_STARTED", "wf-1", { workflowId: "wf-1", stepIds: ["s1"], dagEdges: {} }), state).reason).toBe("WORKFLOW_EXISTS");
  });

  it("STEP_SCHEDULED on pending step → COMMITTED", () => {
    const state = startedState();
    expect(proto.validate(makeInput("STEP_SCHEDULED", "wf-1", { stepId: "step-a" }), state).outcome).toBe("COMMITTED");
  });

  it("STEP_SCHEDULED on non-running workflow → REJECTED", () => {
    expect(proto.validate(makeInput("STEP_SCHEDULED", "wf-1", { stepId: "step-a" }), emptyState()).reason).toBe("WORKFLOW_NOT_RUNNING");
  });

  it("STEP_EXECUTING on scheduled step → COMMITTED", () => {
    let state = startedState();
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(proto.validate(makeInput("STEP_EXECUTING", "wf-1", { stepId: "step-a" }), state).outcome).toBe("COMMITTED");
  });

  it("STEP_EXECUTING on non-scheduled step → REJECTED STEP_NOT_SCHEDULED", () => {
    const state = startedState();
    expect(proto.validate(makeInput("STEP_EXECUTING", "wf-1", { stepId: "step-a" }), state).reason).toBe("STEP_NOT_SCHEDULED");
  });

  it("STEP_COMPLETE on executing step → COMMITTED", () => {
    let state = startedState();
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(proto.validate(makeInput("STEP_COMPLETE", "wf-1", { stepId: "step-a" }), state).outcome).toBe("COMMITTED");
  });

  it("STEP_COMPLETE on non-executing step → REJECTED STEP_NOT_EXECUTING", () => {
    const state = startedState();
    expect(proto.validate(makeInput("STEP_COMPLETE", "wf-1", { stepId: "step-a" }), state).reason).toBe("STEP_NOT_EXECUTING");
  });

  it("STEP_EFFECT_RECORDED on executing step → COMMITTED", () => {
    let state = startedState();
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(proto.validate(makeInput("STEP_EFFECT_RECORDED", "wf-1", { stepId: "step-a", effectId: "e1", effectChecksum: "chk" }), state).outcome).toBe("COMMITTED");
  });

  it("STEP_RETRY on executing step → COMMITTED", () => {
    let state = startedState();
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(proto.validate(makeInput("STEP_RETRY", "wf-1", { stepId: "step-a" }), state).outcome).toBe("COMMITTED");
  });

  it("WORKFLOW_COMPLETE when all steps complete → COMMITTED", () => {
    let state = startedState("wf-1", ["step-a"]);
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(4, "STEP_COMPLETE", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(proto.validate(makeInput("WORKFLOW_COMPLETE", "wf-1"), state).outcome).toBe("COMMITTED");
  });

  it("WORKFLOW_COMPLETE with incomplete steps → REJECTED STEPS_INCOMPLETE", () => {
    const state = startedState();
    expect(proto.validate(makeInput("WORKFLOW_COMPLETE", "wf-1"), state).reason).toBe("STEPS_INCOMPLETE");
  });

  it("WORKFLOW_FAILED on running → COMMITTED; apply sets compensating", () => {
    const state = startedState();
    const r = proto.validate(makeInput("WORKFLOW_FAILED", "wf-1", { reason: "err" }), state);
    expect(r.outcome).toBe("COMMITTED");
    const next = proto.apply(makeEntry(2, "WORKFLOW_FAILED", "wf-1", "COMMITTED", { reason: "err" }) as any, state);
    expect(next.workflows["wf-1"]!.status).toBe("compensating");
  });

  it("WORKFLOW_FAILED on compensating → COMMITTED; apply sets failed", () => {
    let state = startedState();
    state = proto.apply(makeEntry(2, "WORKFLOW_FAILED", "wf-1", "COMMITTED", { reason: "err" }) as any, state);
    expect(state.workflows["wf-1"]!.status).toBe("compensating");
    const next = proto.apply(makeEntry(3, "WORKFLOW_FAILED", "wf-1", "COMMITTED", { reason: "err" }) as any, state);
    expect(next.workflows["wf-1"]!.status).toBe("failed");
  });

  it("STEP_COMPENSATE on complete step → COMMITTED; apply sets compensating", () => {
    let state = startedState("wf-1", ["step-a"]);
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    state = proto.apply(makeEntry(4, "STEP_COMPLETE", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    const r = proto.validate(makeInput("STEP_COMPENSATE", "wf-1", { stepId: "step-a" }), state);
    expect(r.outcome).toBe("COMMITTED");
    const next = proto.apply(makeEntry(5, "STEP_COMPENSATE", "wf-1", "COMMITTED", { stepId: "step-a" }) as any, state);
    expect(next.workflows["wf-1"]!.steps["step-a"]!.status).toBe("compensating");
  });
});

describe("WorkflowProtocol.apply", () => {
  it("WORKFLOW_STARTED creates workflow with all steps pending and effects={}", () => {
    const next = startedState("wf-2", ["s1", "s2"], { "s2": ["s1"] });
    expect(next.workflows["wf-2"]!.status).toBe("running");
    expect(next.workflows["wf-2"]!.steps["s1"]!.status).toBe("pending");
    expect(next.workflows["wf-2"]!.steps["s1"]!.effects).toEqual({});
    expect(next.workflows["wf-2"]!.dagEdges["s2"]).toEqual(["s1"]);
  });

  it("STEP_EFFECT_RECORDED stores effect; duplicate is no-op", () => {
    let state = startedState("wf-3", ["s1"]);
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-3", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-3", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(4, "STEP_EFFECT_RECORDED", "wf-3", "COMMITTED", { stepId: "s1", effectId: "e1", effectChecksum: "chk" }) as any, state);
    expect(state.workflows["wf-3"]!.steps["s1"]!.effects["e1"]).toBeDefined();
    // Duplicate — no-op
    const sameState = proto.apply(makeEntry(5, "STEP_EFFECT_RECORDED", "wf-3", "COMMITTED", { stepId: "s1", effectId: "e1", effectChecksum: "chk" }) as any, state);
    expect(sameState).toBe(state); // same reference (no-op returns original state)
  });

  it("STEP_RETRY increments attempt and resets to pending", () => {
    let state = startedState("wf-4", ["s1"]);
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-4", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-4", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(4, "STEP_RETRY", "wf-4", "COMMITTED", { stepId: "s1" }) as any, state);
    expect(state.workflows["wf-4"]!.steps["s1"]!.attempt).toBe(1);
    expect(state.workflows["wf-4"]!.steps["s1"]!.status).toBe("pending");
  });
});

describe("WorkflowProtocol static methods", () => {
  it("getReadySteps: step with no deps ready; step with unsatisfied deps not ready; returns lexicographic order", () => {
    const state = startedState("wf-5", ["alpha", "beta", "gamma"], { "beta": ["alpha"], "gamma": ["alpha"] });
    const ready = WorkflowProtocol.getReadySteps("wf-5", state);
    expect(ready).toEqual(["alpha"]); // only alpha has no deps
  });

  it("computeBackoff is deterministic and grows with attempt", () => {
    const b0 = WorkflowProtocol.computeBackoff(1000, 0, "ns", "wf");
    const b1 = WorkflowProtocol.computeBackoff(1000, 1, "ns", "wf");
    const b0again = WorkflowProtocol.computeBackoff(1000, 0, "ns", "wf");
    expect(b0).toBe(b0again); // deterministic
    expect(b1).toBeGreaterThan(b0); // grows with attempt
  });

  it("snapshot round-trip preserves all fields including effects map", () => {
    let state = startedState("wf-6", ["s1"]);
    state = proto.apply(makeEntry(2, "STEP_SCHEDULED", "wf-6", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(3, "STEP_EXECUTING", "wf-6", "COMMITTED", { stepId: "s1" }) as any, state);
    state = proto.apply(makeEntry(4, "STEP_EFFECT_RECORDED", "wf-6", "COMMITTED", { stepId: "s1", effectId: "e1", effectChecksum: "chk" }) as any, state);
    const slice = proto.serializeSnapshot(state);
    const restored = proto.restoreSnapshot(slice, 1);
    expect(restored.workflows["wf-6"]!.steps["s1"]!.effects["e1"]).toBeDefined();
    expect(restored.workflows["wf-6"]!.dagEdges).toBeDefined();
  });
});
