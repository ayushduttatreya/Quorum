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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_entries (
        seq              INTEGER PRIMARY KEY AUTOINCREMENT,
        term             INTEGER NOT NULL,
        epoch            INTEGER NOT NULL,
        wall_clock_ts    INTEGER NOT NULL,
        protocol         TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        operation        TEXT NOT NULL,
        resource_key     TEXT NOT NULL,
        payload          TEXT NOT NULL,
        checksum         TEXT NOT NULL,
        committed        INTEGER NOT NULL DEFAULT 0,
        outcome          TEXT,
        idempotency_key  TEXT NOT NULL,
        trace_id         TEXT NOT NULL,
        client_id        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency
        ON log_entries(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_resource_key
        ON log_entries(resource_key);
      CREATE INDEX IF NOT EXISTS idx_uncommitted
        ON log_entries(committed, seq) WHERE committed = 0;
    `);
  }

  append(opts: AppendOptions): LogEntry {
    const { input, term, epoch } = opts;
    const [existing] = this.sql
      .exec(
        "SELECT seq FROM log_entries WHERE idempotency_key = ?",
        input.idempotencyKey,
      )
      .toArray();
    if (existing) {
      throw new IdempotentResultError(existing["seq"] as number);
    }

    const wallClockTs = Date.now();
    const payloadJson = JSON.stringify(input.payload);
    const checksum = this.computeChecksum({
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      operation: input.operation,
      resourceKey: input.resourceKey,
      payload: payloadJson,
      term,
      epoch,
      wallClockTs,
    });

    this.sql.exec(
      `INSERT INTO log_entries
        (term, epoch, wall_clock_ts, protocol, protocol_version, operation,
         resource_key, payload, checksum, committed, idempotency_key, trace_id, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      term,
      epoch,
      wallClockTs,
      input.protocol,
      input.protocolVersion,
      input.operation,
      input.resourceKey,
      payloadJson,
      checksum,
      input.idempotencyKey,
      input.traceId,
      input.clientId,
    );

    const [row] = this.sql
      .exec("SELECT last_insert_rowid() as seq")
      .toArray();

    return {
      seq: row!["seq"] as number,
      term,
      epoch,
      wallClockTs,
      protocol: input.protocol,
      protocolVersion: input.protocolVersion,
      operation: input.operation,
      resourceKey: input.resourceKey,
      payload: input.payload,
      checksum,
      committed: false,
      idempotencyKey: input.idempotencyKey,
      traceId: input.traceId,
      clientId: input.clientId,
    };
  }

  markCommitted(seq: number, outcome: Outcome): void {
    this.sql.exec(
      "UPDATE log_entries SET committed = 1, outcome = ? WHERE seq = ?",
      outcome,
      seq,
    );
  }

  getEntries(opts: GetEntriesOptions): LogEntry[] {
    const { fromSeq, limit, resourceKey } = opts;
    const cursor = resourceKey
      ? this.sql.exec(
          "SELECT * FROM log_entries WHERE seq >= ? AND resource_key = ? ORDER BY seq LIMIT ?",
          fromSeq,
          resourceKey,
          limit,
        )
      : this.sql.exec(
          "SELECT * FROM log_entries WHERE seq >= ? ORDER BY seq LIMIT ?",
          fromSeq,
          limit,
        );
    return [...cursor].map((r) => this.rowToEntry(r));
  }

  getUncommitted(): LogEntry[] {
    const cursor = this.sql.exec(
      "SELECT * FROM log_entries WHERE committed = 0 ORDER BY seq",
    );
    return [...cursor].map((r) => this.rowToEntry(r));
  }

  getLatestSeq(): number {
    const [row] = this.sql.exec("SELECT MAX(seq) as max_seq FROM log_entries").toArray();
    return (row?.["max_seq"] as number | null) ?? 0;
  }

  getLatestChecksum(): string {
    const [row] = this.sql
      .exec("SELECT checksum FROM log_entries ORDER BY seq DESC LIMIT 1")
      .toArray();
    return (row?.["checksum"] as string | null) ?? "";
  }

  deleteUpTo(seq: number): void {
    this.sql.exec("DELETE FROM log_entries WHERE seq <= ?", seq);
  }

  private rowToEntry(row: Record<string, unknown>): LogEntry {
    return {
      seq: row["seq"] as number,
      term: row["term"] as number,
      epoch: row["epoch"] as number,
      wallClockTs: row["wall_clock_ts"] as number,
      protocol: row["protocol"] as LogEntry["protocol"],
      protocolVersion: row["protocol_version"] as number,
      operation: row["operation"] as LogEntry["operation"],
      resourceKey: row["resource_key"] as string,
      payload: JSON.parse(row["payload"] as string) as Record<string, unknown>,
      checksum: row["checksum"] as string,
      committed: (row["committed"] as number) === 1,
      idempotencyKey: row["idempotency_key"] as string,
      traceId: row["trace_id"] as string,
      clientId: row["client_id"] as string,
    };
  }

  private computeChecksum(data: Record<string, unknown>): string {
    const str = JSON.stringify(data, Object.keys(data).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
}
