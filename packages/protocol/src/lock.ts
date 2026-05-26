import type { ProtocolExecutor, ValidationResult } from "./types.ts";
import type { LogEntryInput, CommittedEntry, SnapshotSlice } from "@quorum/types";
import { SnapshotCompatibilityError } from "@quorum/types";

export interface LockState {
  locks: Record<string, {
    holder: string;
    fencingToken: bigint;
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

export class LockProtocol implements ProtocolExecutor<LockState> {
  readonly protocol = "LOCK";
  readonly version = 1;

  initialState(): LockState {
    return { locks: {} };
  }

  validate(input: LogEntryInput, state: LockState): ValidationResult {
    const { operation, resourceKey, payload } = input;
    const now = (payload["wallClockTs"] as number | undefined) ?? Date.now();

    if (operation === "LOCK_ACQUIRE") {
      const existing = state.locks[resourceKey];
      if (!existing || existing.expiresAt < now) {
        return { valid: true, outcome: "COMMITTED" };
      }
      return { valid: false, outcome: "REJECTED", reason: "LOCK_HELD" };
    }

    if (operation === "LOCK_RELEASE") {
      const existing = state.locks[resourceKey];
      if (!existing) {
        return { valid: false, outcome: "REJECTED", reason: "TOKEN_MISMATCH" };
      }
      const token = BigInt(payload["fencingToken"] as string);
      if (existing.fencingToken === token) {
        return { valid: true, outcome: "COMMITTED" };
      }
      return { valid: false, outcome: "REJECTED", reason: "TOKEN_MISMATCH" };
    }

    if (operation === "LOCK_EXPIRE") {
      return { valid: true, outcome: "COMMITTED" };
    }

    throw new Error(`unknown lock operation: ${operation}`);
  }

  apply(entry: CommittedEntry, state: LockState): LockState {
    if (entry.outcome === "REJECTED") return state;

    const { operation, resourceKey, payload, wallClockTs, seq, term } = entry;
    const locks = { ...state.locks };

    if (operation === "LOCK_ACQUIRE") {
      const ttl = payload["ttl"] as number;
      locks[resourceKey] = {
        holder: entry.clientId,
        fencingToken: (BigInt(term) << 32n) | BigInt(seq),
        expiresAt: wallClockTs + ttl,
        acquiredSeq: seq,
      };
      return { locks };
    }

    if (operation === "LOCK_RELEASE" || operation === "LOCK_EXPIRE") {
      delete locks[resourceKey];
      return { locks };
    }

    return state;
  }

  serializeSnapshot(state: LockState): SnapshotSlice {
    const serializable = {
      locks: Object.fromEntries(
        Object.entries(state.locks).map(([k, v]) => [
          k,
          { ...v, fencingToken: v.fencingToken.toString() },
        ]),
      ),
    };
    const data = new TextEncoder().encode(JSON.stringify(serializable));
    return { protocol: "LOCK", version: 1, data, checksum: simpleHash(data) };
  }

  restoreSnapshot(slice: SnapshotSlice, fromVersion: number): LockState {
    if (fromVersion !== 1) {
      throw new SnapshotCompatibilityError(
        `LockProtocol snapshot version ${fromVersion} is not supported (expected 1)`,
      );
    }
    const raw = JSON.parse(new TextDecoder().decode(slice.data)) as {
      locks: Record<string, { holder: string; fencingToken: string; expiresAt: number; acquiredSeq: number }>;
    };
    const locks: LockState["locks"] = {};
    for (const [k, v] of Object.entries(raw.locks)) {
      locks[k] = { ...v, fencingToken: BigInt(v.fencingToken) };
    }
    return { locks };
  }
}
