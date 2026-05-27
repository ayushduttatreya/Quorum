// Benchmark: distributed lock acquisition latency
// Measures: p50/p95/p99/p999 for lock() round-trip under no contention
// Sequential measurement — one request at a time (avoids hiding queueing latency)
// Connects to a running Wrangler dev server at BASE_URL

import { computePercentiles, printBenchmarkResult, saveResult } from "./types.ts";
import type { BenchmarkResult } from "./types.ts";

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8787";
const OUTPUT_DIR = process.env["OUTPUT_DIR"] ?? "results";

async function acquireLock(resourceKey: string, idempotencyKey: string): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/coordinate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: "LOCK",
      protocolVersion: 1,
      operation: "LOCK_ACQUIRE",
      resourceKey,
      payload: { ttl: 30_000 },
      idempotencyKey,
      traceId: idempotencyKey,
      clientId: "benchmark",
    }),
  });
  const elapsed = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json() as { outcome: string };
  if (body.outcome !== "COMMITTED") throw new Error(`Unexpected outcome: ${body.outcome}`);
  return elapsed;
}

async function warmup(rounds = 10): Promise<void> {
  console.log(` Warming up (${rounds} rounds)...`);
  for (let i = 0; i < rounds; i++) {
    const key = `warmup-${i}`;
    await acquireLock(key, `warmup-idem-${i}-${Date.now()}`);
  }
}

async function runLockLatencyBenchmark(ops: number): Promise<BenchmarkResult> {
  // Check server is up
  const health = await fetch(`${BASE_URL}/health`).then(r => r.json()) as { mode: string };
  if (health.mode !== "ACTIVE") throw new Error(`Runtime is ${health.mode}, not ACTIVE`);

  await warmup(20);

  console.log(` Running ${ops} lock acquisitions (no contention)...`);
  const samples: number[] = [];
  const start = performance.now();

  for (let i = 0; i < ops; i++) {
    // Each op uses a unique resource key to avoid contention
    const resourceKey = `bench-lock-${i}-${Date.now()}`;
    const idemKey = `bench-idem-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const latency = await acquireLock(resourceKey, idemKey);
    samples.push(latency);
    if (i % 100 === 0 && i > 0) process.stdout.write(`\r  progress: ${i}/${ops}`);
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  const totalMs = performance.now() - start;
  const { p50, p95, p99, p999 } = computePercentiles(samples);

  return {
    name: "Lock acquisition (no contention)",
    scenario: "warm_local",
    ops,
    durationMs: totalMs,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    latencyP99Ms: p99,
    latencyP999Ms: p999,
    throughputOpsPerSec: (ops / totalMs) * 1000,
    timestamp: new Date().toISOString(),
    note: "Sequential measurement, Miniflare/local — not production Cloudflare",
  };
}

const ops = parseInt(process.env["OPS"] ?? "500");
console.log(`\nQUORUM Lock Latency Benchmark`);
console.log(`Server: ${BASE_URL} | Ops: ${ops}`);

runLockLatencyBenchmark(ops)
  .then(async (result) => {
    printBenchmarkResult(result);
    await saveResult(result, OUTPUT_DIR);
  })
  .catch(err => {
    console.error("Benchmark failed:", err instanceof Error ? err.message : String(err));
    console.error("Make sure `wrangler dev` is running at", BASE_URL);
    process.exit(1);
  });
