import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Quorum } from "./client.ts";
import { QuorumError } from "@quorum/types";

function makeQuorum() {
  return new Quorum({ COORDINATION_RUNTIME: env.COORDINATION_RUNTIME, REPLICA: env.REPLICA, QUORUM_STORAGE: env.QUORUM_STORAGE });
}

describe("Quorum.workflow()", () => {
  it("completes a 2-step sequential workflow and returns results", async () => {
    const q = makeQuorum();
    const result = await q.workflow("wf-sequential-1", {
      steps: {
        "step-a": async () => "result-a",
        "step-b": async (ctx) => `result-b-from-${ctx.results["step-a"]}`,
      },
      parallelism: { "step-b": ["step-a"] },
    });
    expect(result.results).toHaveProperty("step-a", "result-a");
    expect(result.results["step-b"]).toContain("result-b-from-result-a");
  });

  it("executes 2 parallel steps (no deps) and both complete", async () => {
    const q = makeQuorum();
    const executed: string[] = [];
    const result = await q.workflow("wf-parallel-1", {
      steps: {
        "step-x": async () => { executed.push("x"); return "x"; },
        "step-y": async () => { executed.push("y"); return "y"; },
      },
    });
    expect(executed).toContain("x");
    expect(executed).toContain("y");
    expect(result.results).toHaveProperty("step-x", "x");
    expect(result.results).toHaveProperty("step-y", "y");
  });

  it("retries a failing step up to maxRetries then throws QuorumError WORKFLOW_FAILED", async () => {
    const q = makeQuorum();
    let attempts = 0;
    await expect(
      q.workflow("wf-fail-1", {
        steps: {
          "step-fail": async () => {
            attempts++;
            throw new Error("step failed");
          },
        },
        maxRetries: 2,
      }),
    ).rejects.toThrow(QuorumError);
    expect(attempts).toBe(3); // initial + 2 retries
  });
});
