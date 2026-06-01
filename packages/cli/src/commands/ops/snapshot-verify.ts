export interface VerifyResponse {
  passed: boolean;
  checksum: string;
  seq: number;
  error?: string;
}

export function formatVerifyResult(result: VerifyResponse): { message: string; exitCode: 0 | 1 } {
  if (result.error === "NOT_FOUND") {
    return { message: `FAIL: no snapshot found at seq=${result.seq}`, exitCode: 1 };
  }
  if (result.passed) {
    return { message: `PASS: checksum verified for snapshot seq=${result.seq} checksum=${result.checksum}`, exitCode: 0 };
  }
  return { message: `FAIL: checksum mismatch for snapshot seq=${result.seq} stored=${result.checksum}`, exitCode: 1 };
}

export async function fetchSnapshotVerify(url: string, seq: number): Promise<VerifyResponse> {
  const res = await fetch(`${url.replace(/\/$/, "")}/snapshots/${seq}/verify`);
  const body = await res.json() as VerifyResponse;
  if (res.status === 404) return { ...body, error: "NOT_FOUND" };
  return body;
}
