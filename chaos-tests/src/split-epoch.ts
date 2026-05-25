// Chaos scenario: inject stale-epoch replication attempt
// Verifies: epoch rejection, ENTRY_STALE_EPOCH_DISCARDED emitted, no state corruption

async function runSplitEpochScenario(_namespaceId: string): Promise<void> {
  throw new Error("not implemented");
}

async function main() {
  const ns = process.env["NAMESPACE"] ?? "chaos-test";
  console.log(`Running split-epoch chaos scenario on namespace: ${ns}`);
  await runSplitEpochScenario(ns);
}

main().catch(console.error);
