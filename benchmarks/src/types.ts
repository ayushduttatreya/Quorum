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
