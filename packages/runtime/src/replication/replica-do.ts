import type { AppendEntriesRequest, AppendEntriesResponse } from "@quorum/types";

export class ReplicaDO {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
  }

  async appendEntries(req: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    throw new Error("not implemented");
  }

  async getEntries(fromSeq: number, limit: number): Promise<import("@quorum/types").LogEntry[]> {
    throw new Error("not implemented");
  }

  async fetch(_req: Request): Promise<Response> {
    return new Response("ReplicaDO", { status: 200 });
  }
}
