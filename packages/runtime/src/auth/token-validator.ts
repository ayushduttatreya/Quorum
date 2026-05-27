import type { NamespaceToken } from "@quorum/types";

export class TokenValidator {
  constructor(private readonly secret: string) {}

  async sign(
    namespaceId: string,
    permissions: ("read" | "write" | "admin")[],
    ttlMs: number,
  ): Promise<NamespaceToken> {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + ttlMs;
    const signature = await this.hmac(namespaceId, permissions, issuedAt, expiresAt);
    return { namespaceId, permissions, issuedAt, expiresAt, signature };
  }

  async verify(token: NamespaceToken): Promise<boolean> {
    const expected = await this.hmac(
      token.namespaceId,
      token.permissions,
      token.issuedAt,
      token.expiresAt,
    );
    const expectedBytes = this.hexToBytes(expected);
    const actualBytes = this.hexToBytes(token.signature);
    if (!expectedBytes || !actualBytes) return false;
    if (expectedBytes.length !== actualBytes.length) return false;
    // timing-safe comparison
    let diff = 0;
    for (let i = 0; i < expectedBytes.length; i++) {
      diff |= expectedBytes[i]! ^ actualBytes[i]!;
    }
    return diff === 0;
  }

  async validate(
    token: NamespaceToken,
    requiredPermission: "read" | "write" | "admin",
  ): Promise<boolean> {
    if (token.expiresAt < Date.now()) return false;
    if (!(await this.verify(token))) return false;

    const perms = token.permissions;
    if (perms.includes("admin")) return true;
    if (requiredPermission === "read") {
      return perms.includes("read") || perms.includes("write");
    }
    if (requiredPermission === "write") {
      return perms.includes("write");
    }
    return false; // admin required but not present
  }

  private async hmac(
    namespaceId: string,
    permissions: ("read" | "write" | "admin")[],
    issuedAt: number,
    expiresAt: number,
  ): Promise<string> {
    const canonical = `${namespaceId}:${permissions.join(",")}:${issuedAt}:${expiresAt}`;
    const keyBytes = new TextEncoder().encode(this.secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const dataBytes = new TextEncoder().encode(canonical);
    const sigBuffer = await crypto.subtle.sign("HMAC", key, dataBytes);
    return Array.from(new Uint8Array(sigBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private hexToBytes(hex: string): Uint8Array | null {
    if (hex.length % 2 !== 0) return null;
    if (!/^[0-9a-f]*$/i.test(hex)) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
