import type { LogEntry, LogEntryInput, Outcome } from "@quorum/types";
import { IdempotentResultError } from "@quorum/types";

interface AppendOptions {
  input: LogEntryInput;
  term: number;
  epoch: number;
}

interface GetEntriesOptions {
  fromSeq: number;
  limit: number;
  resourceKey?: string;
}

export class RclEngine {
  constructor(private readonly sql: SqlStorage) {}

  initialize(): void {
    throw new Error("not implemented");
  }

  append(opts: AppendOptions): LogEntry {
    throw new Error("not implemented");
  }

  markCommitted(seq: number, outcome: Outcome): void {
    throw new Error("not implemented");
  }

  getEntries(opts: GetEntriesOptions): LogEntry[] {
    throw new Error("not implemented");
  }

  getUncommitted(): LogEntry[] {
    throw new Error("not implemented");
  }

  getLatestSeq(): number {
    throw new Error("not implemented");
  }

  getLatestChecksum(): string {
    throw new Error("not implemented");
  }

  deleteUpTo(seq: number): void {
    throw new Error("not implemented");
  }

  private computeChecksum(_data: Record<string, unknown>): string {
    throw new Error("not implemented");
  }
}
