import type { ProtocolExecutor } from "./types.ts";
import type { LogEntryInput, CommittedEntry } from "@quorum/types";

export class ProtocolRegistry {
  private readonly executors = new Map<string, ProtocolExecutor>();

  register(executor: ProtocolExecutor): void {
    this.executors.set(executor.protocol, executor);
  }

  getExecutor(protocol: string): ProtocolExecutor {
    const executor = this.executors.get(protocol);
    if (!executor) throw new Error(`No executor registered for protocol: ${protocol}`);
    return executor;
  }

  validate(input: LogEntryInput, currentState: Record<string, unknown>): import("./types.ts").ValidationResult {
    throw new Error("not implemented");
  }

  apply(entry: CommittedEntry, currentState: Record<string, unknown>): Record<string, unknown> {
    throw new Error("not implemented");
  }

  serializeAllSnapshots(states: Record<string, unknown>): import("@quorum/types").SnapshotSlice[] {
    throw new Error("not implemented");
  }

  restoreAllSnapshots(slices: import("@quorum/types").SnapshotSlice[], protocolVersions: Record<string, number>): Record<string, unknown> {
    throw new Error("not implemented");
  }
}
