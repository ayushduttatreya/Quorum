#!/usr/bin/env node
import minimist from "minimist";
import { runDeterminismCheckFromServer } from "./commands/dev/determinism-check.js";

const argv = minimist(process.argv.slice(2));
const [group, command] = argv._ as [string | undefined, string | undefined];

async function main(): Promise<void> {
  if (group === "dev" && command === "determinism-check") {
    const namespace = String(argv["namespace"] ?? argv["n"] ?? "default");
    const url = String(argv["url"] ?? argv["u"] ?? "http://localhost:8787");

    console.log(
      `Running determinism check against ${url} (namespace: ${namespace})...`,
    );

    const result = await runDeterminismCheckFromServer({ namespace, url });

    if (result.passed) {
      console.log(`✓ PASS — ${result.entriesChecked} entries checked`);
      if (result.snapshotSeq !== null) {
        console.log(
          `  snapshot at seq=${result.snapshotSeq} + delta replay ≡ full replay`,
        );
      }
      process.exit(0);
    } else {
      console.error(`✗ FAIL — S5 invariant violated`);
      console.error(
        `  full replay state:  ${result.fullStateJson.slice(0, 200)}`,
      );
      console.error(
        `  delta replay state: ${result.deltaStateJson.slice(0, 200)}`,
      );
      process.exit(1);
    }
  } else {
    const cmd = [group, command].filter(Boolean).join(" ");
    console.error(`Unknown command: quorum ${cmd}`.trim());
    console.error(
      `Usage: quorum dev determinism-check [--namespace <id>] [--url <url>]`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
