import type { ReplicaHealthRecord } from "@quorum/types";

export interface TopologyResponse {
  mode: string;
  commitIndex: number;
  replicaHealth: ReplicaHealthRecord[];
}

export function formatTopology(data: TopologyResponse): string {
  const lines = [
    `QUORUM TOPOLOGY`,
    `Mode:        ${data.mode}`,
    `CommitIndex: ${data.commitIndex}`,
    ``,
    `Replicas:`,
  ];
  for (const r of data.replicaHealth) {
    lines.push(
      `  ${r.replicaId.padEnd(12)} ${r.health.padEnd(18)} lastAckedSeq=${r.lastAckedSeq}  lastAckedEpoch=${r.lastAckedEpoch}  failures=${r.consecutiveFailures}`,
    );
  }
  return lines.join("\n");
}

export async function fetchTopology(url: string): Promise<TopologyResponse> {
  return fetch(`${url.replace(/\/$/, "")}/topology`).then((r) => r.json()) as Promise<TopologyResponse>;
}
