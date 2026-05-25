import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";

export type StepStatus = "pending" | "scheduled" | "executing" | "complete" | "failed" | "compensating";

export interface WorkflowState {
  workflows: Record<string, {
    workflowId: string;
    status: "running" | "complete" | "failed" | "compensating";
    steps: Record<string, { status: StepStatus; attempt: number; completedSeq?: number }>;
    dagEdges: Record<string, string[]>;
    startedSeq: number;
  }>;
}

export class WorkflowProtocol implements ProtocolExecutor<WorkflowState> {
  readonly protocol = "WORKFLOW";
  readonly version = 1;

  initialState(): WorkflowState {
    return { workflows: {} };
  }

  validate(input: LogEntryInput, state: WorkflowState): ValidationResult {
    throw new Error("not implemented");
  }

  apply(entry: CommittedEntry, state: WorkflowState): WorkflowState {
    throw new Error("not implemented");
  }

  serializeSnapshot(state: WorkflowState): SnapshotSlice {
    throw new Error("not implemented");
  }

  restoreSnapshot(slice: SnapshotSlice, _fromVersion: number): WorkflowState {
    throw new Error("not implemented");
  }

  static computeBackoff(baseDelayMs: number, attempt: number, namespaceId: string, workflowId: string): number {
    throw new Error("not implemented");
  }

  static getReadySteps(workflowId: string, state: WorkflowState): string[] {
    throw new Error("not implemented");
  }
}
