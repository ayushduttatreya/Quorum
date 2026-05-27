import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";
import { SnapshotCompatibilityError } from "@quorum/types";

export type StepStatus = "pending" | "scheduled" | "executing" | "complete" | "failed" | "compensating";

export interface WorkflowStep {
  status: StepStatus;
  attempt: number;
  completedSeq?: number;
  effects: Record<string, { effectId: string; effectChecksum: string; seq: number }>;
}

export interface WorkflowEntry {
  workflowId: string;
  status: "running" | "complete" | "failed" | "compensating";
  steps: Record<string, WorkflowStep>;
  dagEdges: Record<string, string[]>;
  startedSeq: number;
}

export interface WorkflowState {
  workflows: Record<string, WorkflowEntry>;
}

function simpleHash(data: Uint8Array): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function simpleHashUint32(str: string): number {
  const data = new TextEncoder().encode(str);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0;
  }
  return hash >>> 0;
}

export class WorkflowProtocol implements ProtocolExecutor<WorkflowState> {
  readonly protocol = "WORKFLOW";
  readonly version = 1;

  initialState(): WorkflowState {
    return { workflows: {} };
  }

  validate(input: LogEntryInput, state: WorkflowState): ValidationResult {
    const { operation, resourceKey, payload } = input;
    const wfId = resourceKey;
    const wf = state.workflows[wfId];

    if (operation === "WORKFLOW_STARTED") {
      if (wf) return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_EXISTS" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_SCHEDULED") {
      if (!wf || wf.status !== "running") return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || step.status !== "pending") return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_PENDING" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_EXECUTING") {
      if (!wf || wf.status !== "running") return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || step.status !== "scheduled") return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_SCHEDULED" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_COMPLETE") {
      if (!wf) return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || step.status !== "executing") return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_EXECUTING" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_EFFECT_RECORDED") {
      if (!wf) return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || step.status !== "executing") return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_EXECUTING" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_RETRY") {
      if (!wf || wf.status !== "running") return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || (step.status !== "executing" && step.status !== "failed")) {
        return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_EXECUTING" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "WORKFLOW_COMPLETE") {
      if (!wf || wf.status !== "running") return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const allComplete = Object.values(wf.steps).every((s) => s.status === "complete");
      if (!allComplete) return { valid: false, outcome: "REJECTED", reason: "STEPS_INCOMPLETE" };
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "WORKFLOW_FAILED") {
      if (!wf || (wf.status !== "running" && wf.status !== "compensating")) {
        return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "STEP_COMPENSATE") {
      if (!wf) return { valid: false, outcome: "REJECTED", reason: "WORKFLOW_NOT_RUNNING" };
      const stepId = payload["stepId"] as string;
      const step = wf.steps[stepId];
      if (!step || step.status !== "complete") return { valid: false, outcome: "REJECTED", reason: "STEP_NOT_COMPLETE" };
      return { valid: true, outcome: "COMMITTED" };
    }

    throw new Error(`unknown workflow operation: ${operation}`);
  }

  apply(entry: CommittedEntry, state: WorkflowState): WorkflowState {
    if (entry.outcome === "REJECTED") return state;

    const { operation, resourceKey, payload, seq } = entry;
    const wfId = resourceKey;
    const workflows = { ...state.workflows };

    if (operation === "WORKFLOW_STARTED") {
      const stepIds = payload["stepIds"] as string[];
      const dagEdges = payload["dagEdges"] as Record<string, string[]>;
      const steps: Record<string, WorkflowStep> = {};
      for (const stepId of stepIds) {
        steps[stepId] = { status: "pending", attempt: 0, effects: {} };
      }
      workflows[wfId] = { workflowId: wfId, status: "running", steps, dagEdges, startedSeq: seq };
      return { workflows };
    }

    const wf = workflows[wfId];
    if (!wf) return state;
    const steps = { ...wf.steps };

    if (operation === "STEP_SCHEDULED") {
      const stepId = payload["stepId"] as string;
      steps[stepId] = { ...steps[stepId]!, status: "scheduled" };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    if (operation === "STEP_EXECUTING") {
      const stepId = payload["stepId"] as string;
      steps[stepId] = { ...steps[stepId]!, status: "executing" };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    if (operation === "STEP_COMPLETE") {
      const stepId = payload["stepId"] as string;
      steps[stepId] = { ...steps[stepId]!, status: "complete", completedSeq: seq };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    if (operation === "STEP_EFFECT_RECORDED") {
      const stepId = payload["stepId"] as string;
      const effectId = payload["effectId"] as string;
      const effectChecksum = payload["effectChecksum"] as string;
      const step = steps[stepId]!;
      if (step.effects[effectId]) return state; // idempotent no-op
      steps[stepId] = {
        ...step,
        effects: { ...step.effects, [effectId]: { effectId, effectChecksum, seq } },
      };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    if (operation === "STEP_RETRY") {
      const stepId = payload["stepId"] as string;
      const step = steps[stepId]!;
      steps[stepId] = { ...step, attempt: step.attempt + 1, status: "pending" };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    if (operation === "WORKFLOW_COMPLETE") {
      workflows[wfId] = { ...wf, status: "complete" };
      return { workflows };
    }

    if (operation === "WORKFLOW_FAILED") {
      const newStatus = wf.status === "compensating" ? "failed" : "compensating";
      workflows[wfId] = { ...wf, status: newStatus };
      return { workflows };
    }

    if (operation === "STEP_COMPENSATE") {
      const stepId = payload["stepId"] as string;
      steps[stepId] = { ...steps[stepId]!, status: "compensating" };
      workflows[wfId] = { ...wf, steps };
      return { workflows };
    }

    return state;
  }

  serializeSnapshot(state: WorkflowState): SnapshotSlice {
    const data = new TextEncoder().encode(JSON.stringify(state));
    return { protocol: "WORKFLOW", version: 1, data, checksum: simpleHash(data) };
  }

  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): WorkflowState {
    if (fromVersion !== 1) {
      throw new SnapshotCompatibilityError(
        `WorkflowProtocol snapshot version ${fromVersion} is not supported (expected 1)`,
      );
    }
    return JSON.parse(new TextDecoder().decode(slice.data)) as WorkflowState;
  }

  static computeBackoff(
    baseDelayMs: number,
    attempt: number,
    namespaceId: string,
    workflowId: string,
  ): number {
    const jitterRange = Math.floor(baseDelayMs * 0.1);
    const seed = simpleHashUint32(`${namespaceId}:${workflowId}:${attempt}`);
    const jitter = jitterRange > 0 ? seed % jitterRange : 0;
    return baseDelayMs * (2 ** attempt) + jitter;
  }

  static getReadySteps(workflowId: string, state: WorkflowState): string[] {
    const wf = state.workflows[workflowId];
    if (!wf) return [];
    return Object.keys(wf.steps)
      .filter((stepId) => {
        const step = wf.steps[stepId]!;
        if (step.status !== "pending") return false;
        const deps = wf.dagEdges[stepId] ?? [];
        return deps.every((dep) => wf.steps[dep]?.status === "complete");
      })
      .sort();
  }
}
