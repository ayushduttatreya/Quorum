import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";
import { SnapshotCompatibilityError } from "@quorum/types";

export interface LeaseState {
  leases: Record<string, {
    holder: string;
    epoch: number;
    expiresAt: number;
    acquiredSeq: number;
  }>;
}

function simpleHash(data: Uint8Array): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function simpleHashUint32(str: string): number {
  const data = new TextEncoder().encode(str);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]!) | 0;
  }
  return hash >>> 0;
}

export class LeaseProtocol implements ProtocolExecutor<LeaseState> {
  readonly protocol = "LEASE";
  readonly version = 1;

  initialState(): LeaseState {
    return { leases: {} };
  }

  validate(input: LogEntryInput, state: LeaseState): ValidationResult {
    const { operation, resourceKey, payload } = input;
    const now = (payload["wallClockTs"] as number | undefined) ?? Date.now();

    if (operation === "LEASE_ACQUIRE") {
      const existing = state.leases[resourceKey];
      if (!existing || existing.expiresAt < now) {
        return { valid: true, outcome: "COMMITTED" };
      }
      return { valid: false, outcome: "REJECTED", reason: "LEASE_HELD" };
    }

    if (operation === "LEASE_RENEW") {
      const existing = state.leases[resourceKey];
      if (!existing || existing.expiresAt < now) {
        return { valid: false, outcome: "REJECTED", reason: "LEASE_NOT_HELD" };
      }
      if (existing.epoch !== (payload["epoch"] as number)) {
        return { valid: false, outcome: "REJECTED", reason: "EPOCH_MISMATCH" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "LEASE_RELEASE") {
      const existing = state.leases[resourceKey];
      if (!existing || existing.expiresAt < now) {
        return { valid: false, outcome: "REJECTED", reason: "LEASE_NOT_HELD" };
      }
      if (existing.epoch !== (payload["epoch"] as number)) {
        return { valid: false, outcome: "REJECTED", reason: "EPOCH_MISMATCH" };
      }
      return { valid: true, outcome: "COMMITTED" };
    }

    if (operation === "LEASE_EXPIRE") {
      return { valid: true, outcome: "COMMITTED" };
    }

    throw new Error(`unknown lease operation: ${operation}`);
  }

  apply(entry: CommittedEntry, state: LeaseState): LeaseState {
    if (entry.outcome === "REJECTED") return state;

    const { operation, resourceKey, payload, wallClockTs, seq } = entry;

    if (operation === "LEASE_ACQUIRE") {
      const leases = { ...state.leases };
      leases[resourceKey] = {
        holder: entry.clientId,
        epoch: 1,
        expiresAt: wallClockTs + (payload["ttl"] as number),
        acquiredSeq: seq,
      };
      return { leases };
    }

    if (operation === "LEASE_RENEW") {
      const existing = state.leases[resourceKey]!;
      const leases = { ...state.leases };
      leases[resourceKey] = {
        ...existing,
        epoch: existing.epoch + 1,
        expiresAt: wallClockTs + (payload["ttl"] as number),
      };
      return { leases };
    }

    if (operation === "LEASE_RELEASE" || operation === "LEASE_EXPIRE") {
      const leases = { ...state.leases };
      delete leases[resourceKey];
      return { leases };
    }

    return state;
  }

  serializeSnapshot(state: LeaseState): SnapshotSlice {
    const data = new TextEncoder().encode(JSON.stringify(state));
    return { protocol: "LEASE", version: 1, data, checksum: simpleHash(data) };
  }

  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): LeaseState {
    if (fromVersion !== 1) {
      throw new SnapshotCompatibilityError(
        `LeaseProtocol snapshot version ${fromVersion} is not supported (expected 1)`,
      );
    }
    return JSON.parse(new TextDecoder().decode(slice.data)) as LeaseState;
  }

  static computeRenewInterval(ttlMs: number, namespaceId: string, leaseId: string, epoch: number): number {
    const baseInterval = Math.floor(ttlMs * 0.7);
    const jitterWindow = Math.floor(ttlMs / 10);
    const seed = simpleHashUint32(`${namespaceId}:${leaseId}:${epoch}`);
    const jitter = seed % jitterWindow;
    return baseInterval - jitter;
  }
}
