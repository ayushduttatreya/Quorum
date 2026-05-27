import { describe, it, expect } from "vitest";
import { TokenValidator } from "./token-validator.ts";

const SECRET = "test-secret-key";

describe("TokenValidator", () => {
  it("sign() returns NamespaceToken with all fields and non-empty signature", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["read", "write"], 60_000);
    expect(token.namespaceId).toBe("payments");
    expect(token.permissions).toEqual(["read", "write"]);
    expect(token.signature.length).toBeGreaterThan(0);
    expect(token.expiresAt).toBeGreaterThan(token.issuedAt);
  });

  it("verify() returns true for freshly signed token", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["write"], 60_000);
    expect(await v.verify(token)).toBe(true);
  });

  it("verify() returns false for token with mutated signature", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["write"], 60_000);
    const tampered = { ...token, signature: "0".repeat(token.signature.length) };
    expect(await v.verify(tampered)).toBe(false);
  });

  it("verify() returns false when expiresAt is mutated after signing", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["write"], 60_000);
    const tampered = { ...token, expiresAt: token.expiresAt + 1 };
    expect(await v.verify(tampered)).toBe(false);
  });

  it("validate() returns true when token valid, not expired, permission matches", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["write"], 60_000);
    expect(await v.validate(token, "write")).toBe(true);
  });

  it("validate() returns false for read-only token when write required", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["read"], 60_000);
    expect(await v.validate(token, "write")).toBe(false);
  });

  it("validate() returns true for admin token when write required", async () => {
    const v = new TokenValidator(SECRET);
    const token = await v.sign("payments", ["admin"], 60_000);
    expect(await v.validate(token, "write")).toBe(true);
  });

  it("validate() returns false for expired token even with correct HMAC", async () => {
    const v = new TokenValidator(SECRET);
    // Sign with -1ms TTL so it's already expired
    const token = await v.sign("payments", ["write"], -1);
    expect(await v.validate(token, "write")).toBe(false);
  });
});
