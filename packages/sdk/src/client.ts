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
import { LeaseProtocol, ElectionProtocol } from "@quorum/protocol";

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

  async lease(resourceKey: string, opts: LeaseOptions): Promise<LeaseHandle> {
    const stub = this.getRuntimeStub("default");
    const ttl = opts.ttl;
    const idempotencyKey = crypto.randomUUID();

    const acquireRes = await stub.fetch("http://do/coordinate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: "LEASE", protocolVersion: 1, operation: "LEASE_ACQUIRE",
        resourceKey, payload: { ttl }, idempotencyKey, traceId: idempotencyKey, clientId: "sdk",
      }),
    });

    const acquired = (await acquireRes.json()) as CommittedEntry;
    if (acquired.outcome === "REJECTED") {
      throw new QuorumError("LEASE_HELD", `Lease on "${resourceKey}" is held by another client`);
    }

    let currentEpoch = 1;
    let currentExpiresAt = acquired.wallClockTs + ttl;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRenew = (): void => {
      if (!opts.autoRenew) return;
      const interval = LeaseProtocol.computeRenewInterval(ttl, "default", resourceKey, currentEpoch);
      renewTimer = setTimeout(async () => {
        try { await handle.renew(); scheduleRenew(); } catch { /* TTL covers */ }
      }, interval);
    };

    const handle: LeaseHandle = {
      get epoch() { return currentEpoch; },
      get expiresAt() { return currentExpiresAt; },
      renew: async () => {
        const renewKey = crypto.randomUUID();
        const r = await stub.fetch("http://do/coordinate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: "LEASE", protocolVersion: 1, operation: "LEASE_RENEW",
            resourceKey, payload: { epoch: currentEpoch, ttl },
            idempotencyKey: renewKey, traceId: renewKey, clientId: "sdk",
          }),
        });
        const renewed = (await r.json()) as CommittedEntry;
        if (renewed.outcome === "REJECTED") {
          throw new QuorumError("LEASE_RENEW_FAILED", `Lease renewal rejected`);
        }
        currentEpoch += 1;
        currentExpiresAt = Date.now() + ttl;
      },
      release: async () => {
        if (renewTimer !== null) { clearTimeout(renewTimer); renewTimer = null; }
        const releaseKey = crypto.randomUUID();
        await stub.fetch("http://do/coordinate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: "LEASE", protocolVersion: 1, operation: "LEASE_RELEASE",
            resourceKey, payload: { epoch: currentEpoch },
            idempotencyKey: releaseKey, traceId: releaseKey, clientId: "sdk",
          }),
        }).catch(() => {});
      },
    };

    if (opts.autoRenew) scheduleRenew();
    return handle;
  }

  async elect(
    groupKey: string,
    opts: ElectionOptions,
  ): Promise<ElectionHandle> {
    const { candidateId, onElected, onDeposed } = opts;
    // Each election group uses its own DO instance for isolation
    const stub = this.getRuntimeStub(groupKey);

    const post = async (operation: string, payload: Record<string, unknown>): Promise<CommittedEntry> => {
      const key = crypto.randomUUID();
      const r = await stub.fetch("http://do/coordinate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "ELECTION", protocolVersion: 1, operation,
          resourceKey: groupKey, payload,
          idempotencyKey: key, traceId: key, clientId: candidateId,
        }),
      });
      return r.json() as Promise<CommittedEntry>;
    };

    const openResult = await post("ELECTION_OPEN", { baseSeq: 0, windowSize: 64 });
    // If the election couldn't be opened (e.g. ELECTION_ALREADY_RUNNING or LEADER_ACTIVE),
    // this candidate is not the leader.
    if (openResult.outcome === "REJECTED") {
      return {
        isLeader: () => false,
        resign: async () => {},
      };
    }

    await post("ELECTION_NOMINATE", { candidateId });
    await post("ELECTION_CLOSE", {});

    const winner = ElectionProtocol.selectWinner([{ candidateId, seq: 1, term: 1 }]) ?? candidateId;
    let leaderCandidateId: string | null = winner;

    const established = await post("LEADER_ESTABLISHED", { candidateId: winner, leaseTtl: 30_000 });

    if (established.outcome === "COMMITTED" && winner === candidateId && onElected) {
      await onElected();
    }

    // If LEADER_ESTABLISHED was rejected, we are not the leader
    if (established.outcome === "REJECTED") {
      leaderCandidateId = null;
    }

    return {
      isLeader: () => leaderCandidateId === candidateId,
      resign: async () => {
        if (leaderCandidateId !== candidateId) return;
        leaderCandidateId = null;
        await post("LEADER_EXPIRED", {}).catch(() => {});
        if (onDeposed) await onDeposed().catch(() => {});
      },
    };
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
