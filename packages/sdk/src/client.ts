import type {
  LockOptions,
  LeaseOptions,
  ElectionOptions,
  WorkflowOptions,
  WorkflowContext,
  LockHandle,
  LeaseHandle,
  ElectionHandle,
} from "./types.ts";
import type { CommittedEntry } from "@quorum/types";
import { QuorumError } from "@quorum/types";
import { LeaseProtocol, ElectionProtocol, WorkflowProtocol } from "@quorum/protocol";

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
  COORDINATION_RUNTIME_0?: DurableObjectNamespace;
  COORDINATION_RUNTIME_1?: DurableObjectNamespace;
  COORDINATION_RUNTIME_2?: DurableObjectNamespace;
  NAMESPACE_ROUTER?: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
  AUTH_SECRET?: string;
}

interface QuorumOptions {
  namespaceId?: string;
}

export class Quorum {
  private cachedStub: DurableObjectStub | null = null;

  constructor(
    private readonly env: Env,
    private readonly opts: QuorumOptions = {},
  ) {}

  async lock<T>(
    resourceKey: string,
    callbackOrOptions: LockOptions | ((token: bigint) => Promise<T>),
    callback?: (token: bigint) => Promise<T>,
  ): Promise<T> {
    const opts: LockOptions =
      typeof callbackOrOptions === "function" ? {} : callbackOrOptions;
    const cb: (token: bigint) => Promise<T> =
      typeof callbackOrOptions === "function" ? callbackOrOptions : callback!;

    const stub = await this.getRuntimeStub();
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
    const stub = await this.getRuntimeStub();
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
    const stub = await this.getRuntimeStub();
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
    const stub = await this.getRuntimeStub(groupKey);

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

  async workflow(workflowId: string, opts: WorkflowOptions): Promise<Record<string, unknown>> {
    const stub = await this.getRuntimeStub();
    const maxRetries = opts.maxRetries ?? 3;

    const stepIds = Object.keys(opts.steps);
    const dagEdges: Record<string, string[]> = {};
    for (const stepId of stepIds) {
      dagEdges[stepId] = opts.parallelism?.[stepId] ?? [];
    }

    const post = async (operation: string, payload: Record<string, unknown>): Promise<CommittedEntry> => {
      const key = crypto.randomUUID();
      const r = await stub.fetch("http://do/coordinate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: "WORKFLOW", protocolVersion: 1, operation,
          resourceKey: workflowId, payload,
          idempotencyKey: key, traceId: key, clientId: "sdk",
        }),
      });
      return r.json() as Promise<CommittedEntry>;
    };

    const proto = new WorkflowProtocol();
    const applyEntry = (entry: CommittedEntry, state: ReturnType<WorkflowProtocol["initialState"]>) =>
      proto.apply(entry, state);

    const startResult = await post("WORKFLOW_STARTED", { workflowId, dagEdges, stepIds });
    if (startResult.outcome === "REJECTED") {
      throw new QuorumError("WORKFLOW_EXISTS", `Workflow "${workflowId}" already exists`);
    }

    let localState = proto.initialState();
    localState = applyEntry({ ...startResult, outcome: "COMMITTED" } as CommittedEntry, localState);

    const results: Record<string, unknown> = {};

    while (true) {
      const ready = WorkflowProtocol.getReadySteps(workflowId, localState);
      if (ready.length === 0) {
        const wf = localState.workflows[workflowId]!;
        const allComplete = Object.values(wf.steps).every((s) => s.status === "complete");
        if (allComplete) break;
        throw new QuorumError("WORKFLOW_DEADLOCK", `Workflow "${workflowId}" has no ready steps but is not complete`);
      }

      for (const stepId of ready) {
        const schedResult = await post("STEP_SCHEDULED", { stepId });
        const execResult = await post("STEP_EXECUTING", { stepId });
        localState = applyEntry({ ...schedResult, outcome: "COMMITTED" } as CommittedEntry, localState);
        localState = applyEntry({ ...execResult, outcome: "COMMITTED" } as CommittedEntry, localState);

        const currentAttempt = localState.workflows[workflowId]!.steps[stepId]!.attempt;
        const ctx: WorkflowContext = { input: {}, results: { ...results }, attempt: currentAttempt };

        let succeeded = false;
        let lastError: unknown;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            results[stepId] = await opts.steps[stepId]!(ctx);
            succeeded = true;
            break;
          } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
              const retryResult = await post("STEP_RETRY", { stepId });
              const schedRetry = await post("STEP_SCHEDULED", { stepId });
              const execRetry = await post("STEP_EXECUTING", { stepId });
              localState = applyEntry({ ...retryResult, outcome: "COMMITTED" } as CommittedEntry, localState);
              localState = applyEntry({ ...schedRetry, outcome: "COMMITTED" } as CommittedEntry, localState);
              localState = applyEntry({ ...execRetry, outcome: "COMMITTED" } as CommittedEntry, localState);
              const backoff = WorkflowProtocol.computeBackoff(100, attempt, "default", workflowId);
              await new Promise<void>((r) => setTimeout(r, backoff));
              ctx.attempt = localState.workflows[workflowId]!.steps[stepId]!.attempt;
            }
          }
        }

        if (!succeeded) {
          const failReason = String(lastError);
          const failResult = await post("WORKFLOW_FAILED", { reason: failReason });
          localState = applyEntry({ ...failResult, outcome: "COMMITTED" } as CommittedEntry, localState);

          const wfState = localState.workflows[workflowId]!;
          const completedSteps = Object.entries(wfState.steps)
            .filter(([, s]) => s.status === "complete")
            .sort(([, a], [, b]) => (b.completedSeq ?? 0) - (a.completedSeq ?? 0));

          for (const [csId] of completedSteps) {
            const compResult = await post("STEP_COMPENSATE", { stepId: csId });
            localState = applyEntry({ ...compResult, outcome: "COMMITTED" } as CommittedEntry, localState);
          }

          const finalFail = await post("WORKFLOW_FAILED", { reason: failReason });
          localState = applyEntry({ ...finalFail, outcome: "COMMITTED" } as CommittedEntry, localState);

          throw new QuorumError("WORKFLOW_FAILED", `Workflow "${workflowId}" failed: ${failReason}`);
        }

        const completeResult = await post("STEP_COMPLETE", { stepId });
        localState = applyEntry({ ...completeResult, outcome: "COMMITTED" } as CommittedEntry, localState);
      }
    }

    await post("WORKFLOW_COMPLETE", {});
    return { results };
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

  private async getRuntimeStub(nameOverride?: string): Promise<DurableObjectStub> {
    // When a nameOverride is supplied (e.g. election groupKey), skip cache and
    // resolve a dedicated DO instance for that key.
    if (nameOverride !== undefined) {
      const ns = this.env.COORDINATION_RUNTIME;
      return ns.get(ns.idFromName(nameOverride));
    }

    if (this.cachedStub) return this.cachedStub;

    const namespaceId = this.opts.namespaceId ?? "default";

    if (this.env.NAMESPACE_ROUTER) {
      const routerId = this.env.NAMESPACE_ROUTER.idFromName("global-router");
      const router = this.env.NAMESPACE_ROUTER.get(routerId);
      const res = await router.fetch(
        `http://router/route?namespaceId=${encodeURIComponent(namespaceId)}`,
      );
      const { groupId } = (await res.json()) as { groupId: number };

      const nsKey = `COORDINATION_RUNTIME_${groupId}` as keyof Env;
      const ns =
        (this.env[nsKey] as DurableObjectNamespace | undefined) ??
        this.env.COORDINATION_RUNTIME;
      this.cachedStub = ns.get(ns.idFromName(namespaceId));
    } else {
      this.cachedStub = this.env.COORDINATION_RUNTIME.get(
        this.env.COORDINATION_RUNTIME.idFromName(namespaceId),
      );
    }

    return this.cachedStub;
  }
}
