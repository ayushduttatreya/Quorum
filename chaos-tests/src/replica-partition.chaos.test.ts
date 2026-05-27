import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { CoordinationRuntimeDO } from "@quorum/runtime/src/coordination-runtime-do.ts";
import type { LogEntryInput } from "@quorum/types";
import { runAllInvariants, assertCommitIndexMonotonic, printChaosReport } from "./invariants.ts";

describe("Chaos: replica-partition", () => {
  it("S2 — commit index never decreases under replica degradation", async () => {
    const stub = env.COORDINATION_RUNTIME.get(
      env.COORDINATION_RUNTIME.idFromName("chaos-partition-1"),
    );
    await runInDurableObject(stub, async (instance) => {
      const do_ = instance as unknown as CoordinationRuntimeDO;

      // Make 5 writes. Replicas are stub DOs in Miniflare — every RPC fails.
      // After 3 consecutive failures ReplicationManager marks replicas degraded.
      // Writes still succeed because the kernel commits even without replica ACKs.
      const seqsSeen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const input: LogEntryInput = {
          protocol: "LOCK", protocolVersion: 1, operation: "LOCK_ACQUIRE",
          resourceKey: `partition-res-${i}`, payload: { ttl: 30_000 },
          idempotencyKey: `idem-partition-${i}`, traceId: "trace", clientId: "client",
        };
        const result = await do_.coordinate(input);
        expect(result.outcome).toBe("COMMITTED");
        seqsSeen.push(result.seq);
      }

      // Seqs must be strictly increasing
      for (let i = 1; i < seqsSeen.length; i++) {
        expect(seqsSeen[i]!).toBeGreaterThan(seqsSeen[i - 1]!);
      }

      const res = await do_.fetch(new Request("http://x/entries?fromSeq=0&limit=100"));
      const entries = await res.json() as any[];
      const committed = entries.filter((e: any) => e.committed);

      // Formal S2 assertion
      const s2 = assertCommitIndexMonotonic(committed as any);
      expect(s2.passed).toBe(true);

      // After 5 writes, replicas should be degraded (3+ consecutive failures each)
      const topology = await do_.getTopology() as any;
      const degraded = topology.replicaHealth.filter((r: any) => r.health === "degraded");
      expect(degraded.length).toBeGreaterThan(0);

      const results = runAllInvariants(committed as any, committed as any, {}, {});
      printChaosReport("replica-partition", results);

      // S1, S2, S3/S4, S5, S6 must pass; recovery-mode not applicable (no rollback entries)
      const relevant = results.filter((r) => !r.invariant.includes("Recovery"));
      for (const r of relevant) {
        expect(r.passed).toBe(true);
      }
    });
  });
});
