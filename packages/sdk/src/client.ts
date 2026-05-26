import type {
  LockOptions,
  LeaseOptions,
  ElectionOptions,
  WorkflowOptions,
  LockHandle,
  LeaseHandle,
  ElectionHandle,
} from "./types.ts";
import type { CommittedEntry } from "@quorum/types";
import { QuorumError } from "@quorum/types";

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}

export class Quorum {
  constructor(private readonly env: Env) {}

  async lock<T>(
    resourceKey: string,
    callbackOrOptions: LockOptions | ((token: bigint) => Promise<T>),
    callback?: (token: bigint) => Promise<T>,
  ): Promise<T> {
    const opts: LockOptions =
      typeof callbackOrOptions === "function" ? {} : callbackOrOptions;
    const cb: (token: bigint) => Promise<T> =
      typeof callbackOrOptions === "function" ? callbackOrOptions : callback!;

    const stub = this.getRuntimeStub("default");
    const idempotencyKey = crypto.randomUUID();
    const ttl = opts.ttl ?? 30_000;

    const acquireRes = await stub.fetch("http://do/coordinate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "LOCK",
        protocolVersion: 1,
        operation: "LOCK_ACQUIRE",
        resourceKey,
        payload: { ttl },
        idempotencyKey,
        traceId: idempotencyKey,
        clientId: "sdk",
      }),
    });

    const acquired = (await acquireRes.json()) as CommittedEntry;

    if (acquired.outcome === "REJECTED") {
      throw new QuorumError(
        "LOCK_HELD",
        `Lock on "${resourceKey}" is held by another client`,
      );
    }

    const fencingToken =
      (BigInt(acquired.term) << 32n) | BigInt(acquired.seq);

    try {
      return await cb(fencingToken);
    } finally {
      const releaseKey = crypto.randomUUID();
      await stub
        .fetch("http://do/coordinate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: "LOCK",
            protocolVersion: 1,
            operation: "LOCK_RELEASE",
            resourceKey,
            payload: { fencingToken: fencingToken.toString() },
            idempotencyKey: releaseKey,
            traceId: releaseKey,
            clientId: "sdk",
          }),
        })
        .catch(() => {
          // TTL covers failure — best-effort release
        });
    }
  }

  async acquireLock(
    resourceKey: string,
    opts?: LockOptions,
  ): Promise<LockHandle> {
    const stub = this.getRuntimeStub("default");
    const idempotencyKey = crypto.randomUUID();
    const ttl = opts?.ttl ?? 30_000;

    const acquireRes = await stub.fetch("http://do/coordinate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "LOCK",
        protocolVersion: 1,
        operation: "LOCK_ACQUIRE",
        resourceKey,
        payload: { ttl },
        idempotencyKey,
        traceId: idempotencyKey,
        clientId: "sdk",
      }),
    });

    const acquired = (await acquireRes.json()) as CommittedEntry;

    if (acquired.outcome === "REJECTED") {
      throw new QuorumError(
        "LOCK_HELD",
        `Lock on "${resourceKey}" is held by another client`,
      );
    }

    const fencingToken =
      (BigInt(acquired.term) << 32n) | BigInt(acquired.seq);
    const expiresAt = acquired.wallClockTs + ttl;

    return {
      fencingToken,
      expiresAt,
      release: async () => {
        const releaseKey = crypto.randomUUID();
        await stub.fetch("http://do/coordinate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: "LOCK",
            protocolVersion: 1,
            operation: "LOCK_RELEASE",
            resourceKey,
            payload: { fencingToken: fencingToken.toString() },
            idempotencyKey: releaseKey,
            traceId: releaseKey,
            clientId: "sdk",
          }),
        });
      },
    };
  }

  async lease(resourceKey: string, _opts: LeaseOptions): Promise<LeaseHandle> {
    throw new Error("not implemented — Phase 2");
  }

  async elect(
    _groupKey: string,
    _opts: ElectionOptions,
  ): Promise<ElectionHandle> {
    throw new Error("not implemented — Phase 2");
  }

  async workflow(
    _workflowId: string,
    _opts: WorkflowOptions,
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented — Phase 2");
  }

  async subscribe(_opts: {
    namespace: string;
    fromSeq?: number;
    fromSnapshot?: "latest";
    protocols?: string[];
    consistency?: import("@quorum/types").ConsistencyLevel;
  }): Promise<AsyncIterable<import("@quorum/types").CommittedEntry>> {
    throw new Error("not implemented — Phase 2");
  }

  private getRuntimeStub(_namespaceId: string): DurableObjectStub {
    const id = this.env.COORDINATION_RUNTIME.idFromName(_namespaceId);
    return this.env.COORDINATION_RUNTIME.get(id);
  }
}
