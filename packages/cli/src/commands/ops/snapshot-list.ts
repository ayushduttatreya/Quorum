import type { SnapshotMetadata } from "@quorum/types";

export function formatSnapshotList(snapshots: SnapshotMetadata[]): string {
  if (snapshots.length === 0) return "No snapshots found.";
  const header = `${"SEQ".padEnd(6)}  ${"CHECKSUM".padEnd(68)}  CREATED_AT`;
  const rows = snapshots.map((s) =>
    `${String(s.seq).padEnd(6)}  ${s.checksum.padEnd(68)}  ${new Date(s.createdAt).toISOString()}`,
  );
  return [header, ...rows].join("\n");
}

export async function fetchSnapshotList(url: string): Promise<SnapshotMetadata[]> {
  return fetch(`${url.replace(/\/$/, "")}/snapshots`).then((r) => r.json()) as Promise<SnapshotMetadata[]>;
}
