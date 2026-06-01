import { describe, it, expect } from "vitest";
import { formatRecoverResult } from "./recover.js";

describe("formatRecoverResult", () => {
  it("returns ACTIVE message and exitCode 0 when mode is ACTIVE", () => {
    const r = formatRecoverResult({ mode: "ACTIVE" });
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("ACTIVE");
  });

  it("returns exitCode 1 when mode is not ACTIVE", () => {
    const r = formatRecoverResult({ mode: "RECOVERING" });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("RECOVERING");
  });
});
