// Benchmark: end-to-end quorum commit latency
// Measures: time from POST /coordinate to COMMITTED response (includes replication attempt)
// Sequential measurement

import { computePercentiles, printBenchmarkResult, saveResult } from "./types.ts";
import type { BenchmarkResult } from "./types.ts";

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8787";
const OUTPUT_DIR = process.env["OUTPUT_DIR"] ?? "results";

async function commit(resourceKey: string, idempotencyKey: string): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/coordinate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "LOCK",
      protocolVersion: 1,
      operation: "LOCK_ACQUIRE",
      resourceKey,
      payload: { ttl: 5_000 },
      idempotencyKey,
      traceId: idempotencyKey,
      clientId: "benchmark",
    }),
  });
  const elapsed = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return elapsed;
}

async function runQuorumCommitBenchmark(ops: number): Promise<BenchmarkResult> {
  const health = await fetch(`${BASE_URL}/health`).then(r => r.json()) as { mode: string; commitIndex: number };
  if (health.mode !== "ACTIVE") throw new Error(`Runtime is ${health.mode}`);

  // Warmup
  console.log(` Warming up...`);
  for (let i = 0; i < 20; i++) {
    await commit(`qc-warmup-${i}`, `qc-warmup-idem-${i}-${Date.now()}`);
  }

  console.log(` Running ${ops} quorum commits...`);
  const samples: number[] = [];
  const start = performance.now();

  for (let i = 0; i < ops; i++) {
    const latency = await commit(`qc-res-${i}-${Date.now()}`, `qc-idem-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    samples.push(latency);
    if (i % 100 === 0 && i > 0) process.stdout.write(`\r  progress: ${i}/${ops}`);
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  const totalMs = performance.now() - start;
  const { p50, p95, p99, p999 } = computePercentiles(samples);

  // Also fetch commitIndex to verify monotonicity
  const afterHealth = await fetch(`${BASE_URL}/health`).then(r => r.json()) as { commitIndex: number };
  const commitsMade = afterHealth.commitIndex - health.commitIndex;

  return {
    name: "Quorum commit latency",
    scenario: "warm_local",
    ops,
    durationMs: totalMs,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    latencyP99Ms: p99,
    latencyP999Ms: p999,
    throughputOpsPerSec: (ops / totalMs) * 1000,
    timestamp: new Date().toISOString(),
    note: `commit index advanced by ${commitsMade} — Miniflare/local, not production Cloudflare`,
  };
}

const ops = parseInt(process.env["OPS"] ?? "500");
console.log(`\nQUORUM Quorum Commit Benchmark`);
console.log(`Server: ${BASE_URL} | Ops: ${ops}`);

runQuorumCommitBenchmark(ops)
  .then(async (result) => {
    printBenchmarkResult(result);
    await saveResult(result, OUTPUT_DIR);
  })
  .catch(err => {
    console.error("Benchmark failed:", err instanceof Error ? err.message : String(err));
    console.error("Make sure `wrangler dev` is running at", BASE_URL);
    process.exit(1);
  });
