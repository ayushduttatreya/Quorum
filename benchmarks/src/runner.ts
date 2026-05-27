// QUORUM Benchmark Runner
// Runs all benchmarks sequentially against a running wrangler dev server.
// Usage: BASE_URL=http://localhost:8787 OPS=500 tsx src/runner.ts

import { spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8787";
const OUTPUT_DIR = process.env["OUTPUT_DIR"] ?? join(__dirname, "..", "results");
const OPS = process.env["OPS"] ?? "200";

// Check server is reachable first
const healthRes = await fetch(`${BASE_URL}/health`).catch(() => null);
if (!healthRes?.ok) {
  console.error(`\n✗ Cannot reach QUORUM server at ${BASE_URL}`);
  console.error("  Start with: wrangler dev\n");
  process.exit(1);
}
const health = await healthRes.json() as { mode: string };
if (health.mode !== "ACTIVE") {
  console.error(`\n✗ Server is in ${health.mode} mode, not ACTIVE\n`);
  process.exit(1);
}

console.log(`\nQUORUM Benchmark Suite`);
console.log(`Server: ${BASE_URL} | Ops: ${OPS} | Output: ${OUTPUT_DIR}`);
console.log("═".repeat(55));

mkdirSync(OUTPUT_DIR, { recursive: true });

const benchmarks = ["lock-latency", "quorum-commit", "replication-lag"];
const env = { ...process.env, BASE_URL, OUTPUT_DIR, OPS };

for (const bench of benchmarks) {
  console.log(`\n► ${bench}`);
  const result = spawnSync(
    "npx",
    ["tsx", join(__dirname, `${bench}.ts`)],
    { env, stdio: "inherit", encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(`  ✗ ${bench} failed`);
  }
}

console.log("\n✓ All benchmarks complete");
