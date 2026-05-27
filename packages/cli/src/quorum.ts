#!/usr/bin/env node
import minimist from "minimist";
import { runDeterminismCheckFromServer } from "./commands/dev/determinism-check.js";
import { runReplayCommandFromServer } from "./commands/dev/replay.js";
import { fetchTopology, formatTopology } from "./commands/ops/topology.js";
import { fetchSnapshotList, formatSnapshotList } from "./commands/ops/snapshot-list.js";
import { fetchSnapshotVerify, formatVerifyResult } from "./commands/ops/snapshot-verify.js";
import { triggerRecover, formatRecoverResult } from "./commands/ops/recover.js";

const argv = minimist(process.argv.slice(2));
const [group, command, sub] = argv._ as [string | undefined, string | undefined, string | undefined];

async function main(): Promise<void> {
  const url = String(argv["url"] ?? argv["u"] ?? "http://localhost:8787");
  const namespace = String(argv["namespace"] ?? argv["n"] ?? "default");

  if (group === "dev" && command === "determinism-check") {
    console.log(`Running determinism check against ${url} (namespace: ${namespace})...`);
    const result = await runDeterminismCheckFromServer({ namespace, url });
    if (result.passed) {
      console.log(`✓ PASS — ${result.entriesChecked} entries checked`);
      if (result.snapshotSeq !== null) {
        console.log(`  snapshot at seq=${result.snapshotSeq} + delta replay ≡ full replay`);
      }
      process.exit(0);
    } else {
      console.error(`✗ FAIL — S5 invariant violated`);
      console.error(`  full replay state:  ${result.fullStateJson.slice(0, 200)}`);
      console.error(`  delta replay state: ${result.deltaStateJson.slice(0, 200)}`);
      process.exit(1);
    }
  } else if (group === "dev" && command === "replay") {
    const from = parseInt(String(argv["from"] ?? ""), 10);
    const to = parseInt(String(argv["to"] ?? ""), 10);
    if (isNaN(from) || isNaN(to)) {
      console.error("Usage: quorum dev replay --from <seq> --to <seq> [--dry-run] [--url <url>]");
      process.exit(1);
    }
    const dryRun = Boolean(argv["dry-run"]);
    const result = await runReplayCommandFromServer({ namespace, url, from, to, dryRun });
    if (!result.determinismPassed) console.error("WARN: S5 invariant violation detected");
    if (dryRun) {
      console.log(result.materializedStateJson);
    } else {
      const header = `${"seq".padEnd(6)}  ${"wallClockTs".padEnd(24)}  ${"protocol".padEnd(10)}  ${"operation".padEnd(30)}  ${"resourceKey".padEnd(30)}  outcome`;
      console.log(header);
      for (const row of result.rows) {
        const ts = new Date(row.wallClockTs).toISOString();
        console.log(`${String(row.seq).padEnd(6)}  ${ts.padEnd(24)}  ${row.protocol.padEnd(10)}  ${row.operation.padEnd(30)}  ${row.resourceKey.padEnd(30)}  ${row.outcome}`);
      }
    }
    process.exit(0);
  } else if (group === "ops" && command === "topology") {
    const watch = Boolean(argv["watch"]);
    const print = async () => {
      const data = await fetchTopology(url);
      if (watch) process.stdout.write("\x1b[2J\x1b[H");
      console.log(formatTopology(data));
    };
    if (watch) {
      process.on("SIGINT", () => process.exit(0));
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await print();
        await new Promise<void>((r) => setTimeout(r, 2000));
      }
    } else {
      await print();
      process.exit(0);
    }
  } else if (group === "ops" && command === "snapshot" && sub === "list") {
    const snapshots = await fetchSnapshotList(url);
    console.log(formatSnapshotList(snapshots));
    process.exit(0);
  } else if (group === "ops" && command === "snapshot" && sub === "verify") {
    const seq = parseInt(String(argv["seq"] ?? ""), 10);
    if (isNaN(seq)) {
      console.error("Usage: quorum ops snapshot verify --seq <seq> [--url <url>]");
      process.exit(1);
    }
    const result = await fetchSnapshotVerify(url, seq);
    const { message, exitCode } = formatVerifyResult(result);
    if (exitCode === 0) console.log(message); else console.error(message);
    process.exit(exitCode);
  } else if (group === "ops" && command === "recover") {
    const result = await triggerRecover(url);
    const { message, exitCode } = formatRecoverResult(result);
    if (exitCode === 0) console.log(message); else console.error(message);
    process.exit(exitCode);
  } else {
    const cmd = [group, command, sub].filter(Boolean).join(" ");
    console.error(`Unknown command: quorum ${cmd}`.trim());
    console.error("Available commands:");
    console.error("  quorum dev determinism-check [--namespace <id>] [--url <url>]");
    console.error("  quorum dev replay --from <seq> --to <seq> [--dry-run] [--url <url>]");
    console.error("  quorum ops topology [--watch] [--url <url>]");
    console.error("  quorum ops snapshot list [--url <url>]");
    console.error("  quorum ops snapshot verify --seq <seq> [--url <url>]");
    console.error("  quorum ops recover [--url <url>]");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
