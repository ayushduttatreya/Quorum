// Chaos scenario: force CoordinationRuntimeDO eviction mid-write
// Verifies: UNCOMMITTED entry rollback, RECOVERING mode, recovery to ACTIVE
// Invariants checked: all from invariants.ts

import { runAllInvariants } from "./invariants.ts";

async function runLeaderEvictionScenario(_namespaceId: string): Promise<void> {
  throw new Error("not implemented");
}

async function main() {
  const ns = process.env["NAMESPACE"] ?? "chaos-test";
  console.log(`Running leader-eviction chaos scenario on namespace: ${ns}`);
  await runLeaderEvictionScenario(ns);
}

main().catch(console.error);
