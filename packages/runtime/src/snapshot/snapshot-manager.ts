import type { Snapshot, SnapshotMetadata, SnapshotSlice } from "@quorum/types";
import type { RclEngine } from "../rcl/rcl-engine.ts";
import type { ReplicationManager } from "../replication/replication-manager.ts";
import type { ProtocolRegistry } from "@quorum/protocol";

export interface SnapshotManagerOptions {
  namespaceId: string;
  r2Bucket: R2Bucket;
  threshold: number;
  rclEngine: RclEngine;
  replicationManager: ReplicationManager;
}

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}

function extractSeq(r2Key: string): number {
  const match = /snap_(\d+)_/.exec(r2Key);
  return match ? parseInt(match[1]!, 10) : 0;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class SnapshotManager {
  private lastSnapshotSeq = 0;

  constructor(private readonly opts: SnapshotManagerOptions) {}

  async maybeSnapshot(
    currentSeq: number,
    protocolStates: Record<string, unknown>,
    registry: ProtocolRegistry,
    term: number,
    epoch: number,
  ): Promise<boolean> {
    if (currentSeq - this.lastSnapshotSeq < this.opts.threshold) return false;
    await this.takeSnapshot(currentSeq, protocolStates, registry, term, epoch);
    return true;
  }

  async takeSnapshot(
    commitSeq: number,
    protocolStates: Record<string, unknown>,
    registry: ProtocolRegistry,
    term: number,
    epoch: number,
  ): Promise<SnapshotMetadata> {
    // 1. Serialize protocol state
    const slices = registry.serializeAllSnapshots(protocolStates);

    // 2. Compute SHA-256 checksum over concatenated slice data
    const totalLen = slices.reduce((n, s) => n + s.data.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const s of slices) {
      combined.set(s.data, offset);
      offset += s.data.length;
    }
    const checksum = await sha256Hex(combined);

    // 3. Build snapshot
    const protocolVersions: Record<string, number> = {};
    for (const s of slices) protocolVersions[s.protocol] = s.version;
    const createdAt = Date.now();

    // 4. Write to R2 (slices.data as base64)
    const r2Key = `snapshots/${this.opts.namespaceId}/snap_${commitSeq}_${checksum}.bin`;
    const serializable = {
      seq: commitSeq,
      term,
      epoch,
      protocolVersions,
      checksum,
      createdAt,
      slices: slices.map((s) => ({ ...s, data: uint8ToBase64(s.data) })),
    };
    await this.opts.r2Bucket.put(r2Key, JSON.stringify(serializable));

    // 5. Commit SNAPSHOT_COMPLETE to RCL
    const entry = this.opts.rclEngine.append({
      input: {
        protocol: "SYSTEM",
        protocolVersion: 1,
        operation: "SNAPSHOT_COMPLETE",
        resourceKey: this.opts.namespaceId,
        payload: { r2Key, checksum, protocolVersions, seq: commitSeq },
        idempotencyKey: `snapshot-${commitSeq}`,
        traceId: "kernel",
        clientId: "kernel",
      },
      term,
      epoch,
    });
    this.opts.rclEngine.markCommitted(entry.seq, "COMMITTED");

    // 6. Stabilization: wait for all non-degraded replicas to have ACKed up to commitSeq.
    // Phase 1C-ii will replace this with a proper SNAPSHOT_ADOPTED RPC per the spec §8.
    // Single-node / all-degraded case exits immediately — compaction is safe when no
    // active replicas need the log to catch up.
    await this.waitForStabilization(commitSeq);

    // 7. Archive entries from prior snapshot boundary to commitSeq into R2
    const archiveFrom = this.lastSnapshotSeq > 0 ? this.lastSnapshotSeq : 0;
    const toArchive = this.opts.rclEngine.getEntries({
      fromSeq: archiveFrom,
      limit: commitSeq - archiveFrom + 1,
    });
    if (toArchive.length > 0) {
      const segKey = `segments/${this.opts.namespaceId}/seg_${archiveFrom}_${commitSeq}.log`;
      await this.opts.r2Bucket.put(segKey, JSON.stringify(toArchive));
    }

    // 8. Delete entries before commitSeq from SQLite
    if (commitSeq > 1) {
      this.opts.rclEngine.deleteUpTo(commitSeq - 1);
    }
    this.lastSnapshotSeq = commitSeq;

    return { seq: commitSeq, r2Key, checksum, protocolVersions, createdAt };
  }

  async loadLatestSnapshot(): Promise<Snapshot | null> {
    const list = await this.opts.r2Bucket.list({
      prefix: `snapshots/${this.opts.namespaceId}/`,
    });
    if (list.objects.length === 0) return null;

    const sorted = [...list.objects].sort(
      (a, b) => extractSeq(b.key) - extractSeq(a.key),
    );
    const latest = sorted[0]!;
    const obj = await this.opts.r2Bucket.get(latest.key);
    if (!obj) return null;

    const raw = JSON.parse(await obj.text()) as {
      seq: number;
      term: number;
      epoch: number;
      protocolVersions: Record<string, number>;
      checksum: string;
      createdAt: number;
      slices: Array<{ protocol: string; version: number; data: string; checksum: string }>;
    };

    const slices: SnapshotSlice[] = raw.slices.map((s) => ({
      protocol: s.protocol,
      version: s.version,
      data: base64ToUint8(s.data),
      checksum: s.checksum,
    }));

    return {
      seq: raw.seq,
      term: raw.term,
      epoch: raw.epoch,
      protocolVersions: raw.protocolVersions,
      slices,
      checksum: raw.checksum,
      createdAt: raw.createdAt,
    };
  }

  async verifySnapshot(metadata: SnapshotMetadata): Promise<boolean> {
    const obj = await this.opts.r2Bucket.get(metadata.r2Key);
    if (!obj) return false;
    const raw = JSON.parse(await obj.text()) as {
      slices: Array<{ data: string }>;
    };
    const slices = raw.slices.map((s) => base64ToUint8(s.data));
    const totalLen = slices.reduce((n, d) => n + d.length, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const d of slices) {
      combined.set(d, offset);
      offset += d.length;
    }
    const recomputed = await sha256Hex(combined);
    return recomputed === metadata.checksum;
  }

  async listSnapshots(): Promise<SnapshotMetadata[]> {
    const list = await this.opts.r2Bucket.list({
      prefix: `snapshots/${this.opts.namespaceId}/`,
    });
    return list.objects.map((obj) => {
      const seq = extractSeq(obj.key);
      const checksumMatch = /snap_\d+_([a-f0-9]+)\.bin/.exec(obj.key);
      const checksum = checksumMatch?.[1] ?? "";
      return {
        seq,
        r2Key: obj.key,
        checksum,
        // protocolVersions not available from key alone — callers needing full metadata must use loadLatestSnapshot()
        protocolVersions: {},
        createdAt: obj.uploaded.getTime(),
      };
    });
  }

  private async waitForStabilization(commitSeq: number): Promise<void> {
    const maxWaitMs = 30_000;
    const pollMs = 500;
    const started = Date.now();

    while (Date.now() - started < maxWaitMs) {
      const health = this.opts.replicationManager.getAllHealth();
      const activeReplicas = health.filter((r) => r.health !== "degraded");
      const allStabilized = activeReplicas.every((r) => r.lastAckedSeq >= commitSeq);
      if (activeReplicas.length === 0 || allStabilized) return;
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    // Timeout — proceed anyway; lagging replicas catch up via gap-fill
  }
}
