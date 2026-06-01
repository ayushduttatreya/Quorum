import { describe, it, expect } from "vitest";
import { formatVerifyResult } from "./snapshot-verify.js";

describe("formatVerifyResult", () => {
  it("returns PASS and exitCode 0 on passed: true", () => {
    const r = formatVerifyResult({ passed: true, checksum: "abc123", seq: 5 });
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain("PASS");
    expect(r.message).toContain("seq=5");
  });

  it("returns FAIL and exitCode 1 on passed: false", () => {
    const r = formatVerifyResult({ passed: false, checksum: "abc123", seq: 5 });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("FAIL");
  });

  it("returns FAIL with no snapshot found on NOT_FOUND", () => {
    const r = formatVerifyResult({ passed: false, checksum: "", seq: 99, error: "NOT_FOUND" });
    expect(r.exitCode).toBe(1);
    expect(r.message).toContain("no snapshot found");
  });
});
