import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";

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

  hasExecutor(protocol: string): boolean {
    return this.executors.has(protocol);
  }

  validate(input: LogEntryInput, currentState: Record<string, unknown>): ValidationResult {
    const executor = this.getExecutor(input.protocol);
    const state = currentState[input.protocol] ?? executor.initialState();
    return executor.validate(input, state);
  }

  apply(entry: CommittedEntry, currentState: Record<string, unknown>): Record<string, unknown> {
    const executor = this.getExecutor(entry.protocol);
    const state = currentState[entry.protocol] ?? executor.initialState();
    return { ...currentState, [entry.protocol]: executor.apply(entry, state) };
  }

  serializeAllSnapshots(states: Record<string, unknown>): SnapshotSlice[] {
    return [...this.executors.entries()].map(([_protocol, executor]) =>
      executor.serializeSnapshot(states[executor.protocol] ?? executor.initialState()),
    );
  }

  restoreAllSnapshots(slices: SnapshotSlice[], protocolVersions: Record<string, number>): Record<string, unknown> {
    const states: Record<string, unknown> = {};
    for (const slice of slices) {
      const executor = this.getExecutor(slice.protocol);
      const version = protocolVersions[slice.protocol] ?? slice.version;
      states[slice.protocol] = executor.restoreSnapshot(slice, version);
    }
    return states;
  }
}
