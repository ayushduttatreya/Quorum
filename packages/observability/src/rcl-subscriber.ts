import type { CommittedEntry } from "@quorum/types";

export interface RclEngineReader {
  getEntries(opts: { fromSeq: number; limit: number }): Array<{
    seq: number;
    committed: boolean;
    [key: string]: unknown;
  }>;
  getLatestCommittedSeq(): number;
}

export type EntryHandler = (entry: CommittedEntry) => void;

export class RclSubscriber {
  private cursor = 0;
  private readonly handlers: Set<EntryHandler> = new Set();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly rclEngine: RclEngineReader,
    opts?: { pollIntervalMs?: number; batchSize?: number },
  ) {
    this.pollIntervalMs = opts?.pollIntervalMs ?? 500;
    this.batchSize = opts?.batchSize ?? 200;
  }

  subscribe(handler: EntryHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle === null) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  getCursor(): number {
    return this.cursor;
  }

  // @internal — public for test synchronization
  poll(): void {
    const batch = this.rclEngine.getEntries({ fromSeq: this.cursor, limit: this.batchSize });
    if (batch.length === 0) return;

    let lastSeq = this.cursor;
    for (const raw of batch) {
      if (!raw.committed) { lastSeq = raw.seq; continue; }
      const entry = raw as unknown as CommittedEntry;
      for (const handler of this.handlers) {
        try { handler(entry); } catch { /* handler errors are swallowed */ }
      }
      lastSeq = raw.seq;
    }
    this.cursor = lastSeq + 1;
  }
}
