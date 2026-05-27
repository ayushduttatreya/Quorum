// Benchmark: replica lag under sustained write load
// Measures: entries-behind for each replica at 1k/5k/10k ops/min write rates
// In local Miniflare environment, replicas always lag (stub DOs fail all RPCs)
// Note is included in output for honest reporting

import { computePercentiles, printBenchmarkResult, saveResult } from "./types.ts";
import type { BenchmarkResult } from "./types.ts";

const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:8787";
const OUTPUT_DIR = process.env["OUTPUT_DIR"] ?? "results";

interface ReplicaHealth {
  replicaId: string;
  lastAckedSeq: number;
  health: string;
  consecutiveFailures: number;
}

async function writeOpsAtRate(
  targetOpsPerMin: number,
  durationMs: number,
): Promise<{ latencies: number[]; opsCompleted: number }> {
  const intervalMs = 60_000 / targetOpsPerMin;
  const latencies: number[] = [];
  let opsCompleted = 0;
  const end = Date.now() + durationMs;
  let i = 0;

  while (Date.now() < end) {
    const start = performance.now();
    try {
      const res = await fetch(`${BASE_URL}/coordinate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "LOCK",
          protocolVersion: 1,
          operation: "LOCK_ACQUIRE",
          resourceKey: `repl-res-${i}-${Date.now()}`,
          payload: { ttl: 5_000 },
          idempotencyKey: `repl-idem-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          traceId: `repl-trace-${i}`,
          clientId: "benchmark",
        }),
      });
      if (res.ok) {
        latencies.push(performance.now() - start);
        opsCompleted++;
      }
    } catch { /* skip failed ops */ }

    i++;
    // Pace to target rate (best-effort)
    const elapsed = performance.now() - start;
    const wait = intervalMs - elapsed;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  return { latencies, opsCompleted };
}

async function measureReplicaLag(): Promise<{ commitIndex: number; maxLag: number; avgLag: number }> {
  const res = await fetch(`${BASE_URL}/topology`);
  const topology = await res.json() as {
    commitIndex: number;
    replicaHealth: ReplicaHealth[];
  };

  const lags = topology.replicaHealth.map(r => topology.commitIndex - r.lastAckedSeq);
  const maxLag = lags.length > 0 ? Math.max(...lags) : 0;
  const avgLag = lags.length > 0 ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;

  return { commitIndex: topology.commitIndex, maxLag, avgLag };
}

async function runReplicationLagBenchmark(opsPerMin: number): Promise<BenchmarkResult> {
  const health = await fetch(`${BASE_URL}/health`).then(r => r.json()) as { mode: string };
  if (health.mode !== "ACTIVE") throw new Error(`Runtime is ${health.mode}`);

  console.log(` Rate: ${opsPerMin} ops/min for 10s...`);

  // Run writes for 10 seconds at target rate
  const { latencies, opsCompleted } = await writeOpsAtRate(opsPerMin, 10_000);

  // Measure replica lag after the write burst
  const lagStats = await measureReplicaLag();

  const { p50, p95, p99, p999 } = computePercentiles(latencies);

  return {
    name: `Replication lag @ ${opsPerMin} ops/min`,
    scenario: "warm_local",
    ops: opsCompleted,
    durationMs: 10_000,
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    latencyP99Ms: p99,
    latencyP999Ms: p999,
    throughputOpsPerSec: (opsCompleted / 10_000) * 1000,
    timestamp: new Date().toISOString(),
    note: `commitIndex=${lagStats.commitIndex} maxReplicaLag=${lagStats.maxLag} avgReplicaLag=${lagStats.avgLag.toFixed(1)} entries — Miniflare/local replicas always lag (stub DOs)`,
  };
}

const BASE_RATE = parseInt(process.env["OPS_PER_MIN"] ?? "0");

console.log(`\nQUORUM Replication Lag Benchmark`);
console.log(`Server: ${BASE_URL}`);

const rates = BASE_RATE > 0 ? [BASE_RATE] : [1000, 5000, 10000];

for (const rate of rates) {
  try {
    const result = await runReplicationLagBenchmark(rate);
    printBenchmarkResult(result);
    await saveResult(result, OUTPUT_DIR);
  } catch (err) {
    console.error(`  Failed at ${rate} ops/min:`, err instanceof Error ? err.message : String(err));
    console.error("  Make sure `wrangler dev` is running at", BASE_URL);
  }
}
