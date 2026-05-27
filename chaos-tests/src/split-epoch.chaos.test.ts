import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CoordinationRuntimeDO } from "@quorum/runtime/src/coordination-runtime-do.ts";
import type { LogEntryInput } from "@quorum/types";
import { assertNoStaleEpochCommitted, printChaosReport } from "./invariants.ts";

describe("Chaos: split-epoch", () => {
  it("S6 — stale-epoch uncommitted entry is discarded; ENTRY_STALE_EPOCH_DISCARDED committed", async () => {
    const doName = "chaos-split-epoch-1";

    // Session 1: commit one legitimate entry at epoch=1,
    // then plant an uncommitted entry at epoch=0 (stale)
    const stub1 = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName(doName));
    await runInDurableObject(stub1, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;
      do_.rclInitialize();

      // Legitimate entry: term=1, epoch=1
      const legitInput: LogEntryInput = {
        protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
        resourceKey: "epoch-res-1", payload: { ttl: 60_000 },
        idempotencyKey: "idem-epoch-legit", traceId: "trace", clientId: "client",
      };
      do_.rclAppend(legitInput, 1, 1);
      do_.rclMarkCommitted(1, "COMMITTED");

      // Stale-epoch entry: term=1, epoch=0 (old epoch)
      const staleInput: LogEntryInput = {
        protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
        resourceKey: "epoch-res-stale", payload: { ttl: 60_000 },
        idempotencyKey: "idem-epoch-stale", traceId: "trace", clientId: "client",
      };
      do_.rclAppend(staleInput, 1, 0); // epoch=0 is stale
      // Leave it uncommitted
      expect(do_.rclGetUncommitted()).toHaveLength(1);
    });

    // Session 2: recovery scans uncommitted entries.
    // entry.epoch (0) < this.epoch (1) → ENTRY_STALE_EPOCH_DISCARDED path taken
    const stub2 = env.COORDINATION_RUNTIME.get(env.COORDINATION_RUNTIME.idFromName(doName));
    await runInDurableObject(stub2, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;

      // Trigger recovery
      const result = await do_.coordinate({
        protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
        resourceKey: "epoch-res-post", payload: { ttl: 30_000 },
        idempotencyKey: "idem-epoch-post", traceId: "trace", clientId: "client",
      });
      expect(result.outcome).toBe("COMMITTED");

      const res = await do_.fetch(new Request("http://x/entries?fromSeq=0&limit=100"));
      const entries = await res.json() as any[];

      // The stale entry must NOT appear as COMMITTED
      const staleCommitted = entries.find(
        (e: any) => e.idempotencyKey === "idem-epoch-stale" && e.outcome === "COMMITTED",
      );
      expect(staleCommitted).toBeUndefined();

      // ENTRY_STALE_EPOCH_DISCARDED must be committed in the log
      const discarded = entries.find(
        (e: any) => e.operation === "ENTRY_STALE_EPOCH_DISCARDED" && e.committed,
      );
      expect(discarded).toBeDefined();

      // S6 formal assertion
      const committed = entries.filter((e: any) => e.committed);
      const s6 = assertNoStaleEpochCommitted(committed as any);

      printChaosReport("split-epoch", [
        s6,
        {
          invariant: "Stale entry not committed",
          passed: staleCommitted === undefined,
        },
        {
          invariant: "ENTRY_STALE_EPOCH_DISCARDED emitted",
          passed: discarded !== undefined,
        },
      ]);

      expect(s6.passed).toBe(true);
    });
  });
});
