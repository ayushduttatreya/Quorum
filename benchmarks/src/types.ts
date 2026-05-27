import { writeFile } from "fs/promises";
import { mkdirSync } from "fs";

export interface BenchmarkResult {
  name: string;
  scenario: "warm_local" | "warm_cross_region" | "cold_start";
  ops: number;
  durationMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  latencyP999Ms: number;
  throughputOpsPerSec: number;
  timestamp: string;
  note?: string;
}

export interface BenchmarkReport {
  suite: string;
  runAt: string;
  results: BenchmarkResult[];
  environment: {
    namespaceId: string;
    replicaCount: number;
    region: string;
  };
}

export function computePercentiles(samples: number[]): {
  p50: number; p95: number; p99: number; p999: number;
} {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, p999: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]!;
  return { p50: at(0.50), p95: at(0.95), p99: at(0.99), p999: at(0.999) };
}

export function printBenchmarkResult(result: BenchmarkResult): void {
  console.log(`\n${"─".repeat(55)}`);
  console.log(` ${result.name} [${result.scenario}]`);
  console.log(`${"─".repeat(55)}`);
  console.log(` ops:          ${result.ops}`);
  console.log(` duration:     ${result.durationMs.toFixed(0)}ms`);
  console.log(` throughput:   ${result.throughputOpsPerSec.toFixed(1)} ops/sec`);
  console.log(` p50:          ${result.latencyP50Ms.toFixed(2)}ms`);
  console.log(` p95:          ${result.latencyP95Ms.toFixed(2)}ms`);
  console.log(` p99:          ${result.latencyP99Ms.toFixed(2)}ms`);
  console.log(` p999:         ${result.latencyP999Ms.toFixed(2)}ms`);
  if (result.note) console.log(` note:         ${result.note}`);
  console.log(`${"─".repeat(55)}\n`);
}

export async function saveResult(result: BenchmarkResult, outputDir: string): Promise<void> {
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch { /* already exists */ }
  const date = new Date().toISOString().slice(0, 10);
  const slug = result.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const path = `${outputDir}/${date}-${slug}-${result.scenario}.json`;
  await writeFile(path, JSON.stringify(result, null, 2));
  console.log(` Saved to: ${path}`);
}
