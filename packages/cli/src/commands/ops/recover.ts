export interface RecoverResponse {
  mode: string;
}

export function formatRecoverResult(result: RecoverResponse): { message: string; exitCode: 0 | 1 } {
  if (result.mode === "ACTIVE") {
    return { message: "Recovery complete. Runtime is ACTIVE.", exitCode: 0 };
  }
  return { message: `Recovery incomplete. Runtime is in ${result.mode} mode.`, exitCode: 1 };
}

export async function triggerRecover(url: string): Promise<RecoverResponse> {
  return fetch(`${url.replace(/\/$/, "")}/recover`, { method: "POST" }).then((r) => r.json()) as Promise<RecoverResponse>;
}
