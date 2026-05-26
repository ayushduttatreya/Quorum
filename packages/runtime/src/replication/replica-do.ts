import type {
  AppendEntriesRequest,
  AppendEntriesResponse,
  LogEntry,
} from "@quorum/types";

export class ReplicaDO {
  private readonly sql: SqlStorage;
  private lastEpoch = 0;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS replica_log (
        seq           INTEGER PRIMARY KEY,
        epoch         INTEGER NOT NULL,
        checksum      TEXT NOT NULL,
        entry_json    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_epoch ON replica_log(epoch);
    `);
  }

  async appendEntries(req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    const replicaId = this.state.id.toString();

    // Stale epoch check
    if (req.leaderEpoch < this.lastEpoch) {
      return { ok: false, reason: "STALE_EPOCH", replicaEpoch: this.lastEpoch };
    }
    this.lastEpoch = Math.max(this.lastEpoch, req.leaderEpoch);

    // Gap detection
    const tail = this.getTailSeq();
    if (req.prevSeq !== tail) {
      return { ok: false, reason: "GAP_DETECTED", lastKnownSeq: tail };
    }

    // Checksum validation on prevSeq
    if (req.prevSeq > 0) {
      const [prevRow] = this.sql
        .exec("SELECT checksum FROM replica_log WHERE seq = ?", req.prevSeq)
        .toArray();
      if (!prevRow || (prevRow["checksum"] as string) !== req.prevChecksum) {
        return {
          ok: false,
          reason: "CHECKSUM_MISMATCH",
          expectedChecksum: (prevRow?.["checksum"] as string) ?? "",
        };
      }
    }

    // Persist entries
    let lastEntry: LogEntry | undefined;
    for (const entry of req.entries) {
      this.sql.exec(
        "INSERT OR IGNORE INTO replica_log (seq, epoch, checksum, entry_json) VALUES (?, ?, ?, ?)",
        entry.seq,
        entry.epoch,
        entry.checksum,
        JSON.stringify(entry),
      );
      lastEntry = entry;
    }

    if (!lastEntry) {
      return { ok: false, reason: "GAP_DETECTED", lastKnownSeq: tail };
    }

    const snapshotBase = this.getSnapshotBase();

    return {
      ok: true,
      ack: {
        seq: lastEntry.seq,
        epoch: req.leaderEpoch,
        checksum: lastEntry.checksum,
        snapshotBase,
        replicaId,
      },
    };
  }

  async getEntries(fromSeq: number, limit: number): Promise<LogEntry[]> {
    const cursor = this.sql.exec(
      "SELECT entry_json FROM replica_log WHERE seq >= ? ORDER BY seq LIMIT ?",
      fromSeq,
      limit,
    );
    return [...cursor].map((r) => JSON.parse(r["entry_json"] as string) as LogEntry);
  }

  private getTailSeq(): number {
    const [row] = this.sql.exec("SELECT MAX(seq) as tail FROM replica_log").toArray();
    return (row?.["tail"] as number | null) ?? 0;
  }

  private getSnapshotBase(): number {
    const [row] = this.sql.exec("SELECT MIN(seq) as base FROM replica_log").toArray();
    return (row?.["base"] as number | null) ?? 0;
  }

  async fetch(_req: Request): Promise<Response> {
    return new Response("ReplicaDO", { status: 200 });
  }
}
