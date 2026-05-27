function fnv1aHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

function assignGroup(namespaceId: string, groupCount: number): number {
  return fnv1aHash(namespaceId) % groupCount;
}

interface RouterEnv {
  GROUP_COUNT?: string;
}

export class NamespaceRouterDO {
  private initialized = false;
  private readonly sql: SqlStorage;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RouterEnv,
  ) {
    this.sql = state.storage.sql;
  }

  private initialize(): void {
    if (this.initialized) return;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS namespace_assignments (
        namespace_id TEXT PRIMARY KEY,
        group_id     INTEGER NOT NULL,
        assigned_at  INTEGER NOT NULL
      );
    `);
    this.initialized = true;
  }

  private getOrAssign(namespaceId: string): number {
    const [existing] = this.sql
      .exec("SELECT group_id FROM namespace_assignments WHERE namespace_id = ?", namespaceId)
      .toArray();
    if (existing) return existing["group_id"] as number;

    const groupCount = Math.max(1, parseInt(this.env.GROUP_COUNT ?? "1", 10));
    const groupId = assignGroup(namespaceId, groupCount);
    this.sql.exec(
      "INSERT INTO namespace_assignments (namespace_id, group_id, assigned_at) VALUES (?, ?, ?)",
      namespaceId,
      groupId,
      Date.now(),
    );
    return groupId;
  }

  async fetch(request: Request): Promise<Response> {
    this.initialize();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/route") {
      const namespaceId = url.searchParams.get("namespaceId");
      if (!namespaceId) {
        return Response.json({ error: "namespaceId required" }, { status: 400 });
      }
      const groupId = this.getOrAssign(namespaceId);
      return Response.json({ groupId, doName: `group-${groupId}` });
    }

    if (request.method === "POST" && url.pathname === "/assign") {
      const { namespaceId, groupId } = (await request.json()) as {
        namespaceId: string;
        groupId: number;
      };
      this.sql.exec(
        "INSERT OR REPLACE INTO namespace_assignments (namespace_id, group_id, assigned_at) VALUES (?, ?, ?)",
        namespaceId,
        groupId,
        Date.now(),
      );
      return Response.json({ namespaceId, groupId });
    }

    if (request.method === "GET" && url.pathname === "/assignments") {
      const rows = this.sql
        .exec("SELECT namespace_id, group_id, assigned_at FROM namespace_assignments ORDER BY assigned_at")
        .toArray();
      return Response.json(
        rows.map((r) => ({
          namespaceId: r["namespace_id"],
          groupId: r["group_id"],
          assignedAt: r["assigned_at"],
        })),
      );
    }

    return new Response("Not Found", { status: 404 });
  }
}
