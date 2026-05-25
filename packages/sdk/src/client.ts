import type { LockOptions, LeaseOptions, ElectionOptions, WorkflowOptions, LockHandle, LeaseHandle, ElectionHandle } from "./types.ts";

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
    throw new Error("not implemented");
  }

  async acquireLock(resourceKey: string, opts?: LockOptions): Promise<LockHandle> {
    throw new Error("not implemented");
  }

  async lease(resourceKey: string, opts: LeaseOptions): Promise<LeaseHandle> {
    throw new Error("not implemented");
  }

  async elect(groupKey: string, opts: ElectionOptions): Promise<ElectionHandle> {
    throw new Error("not implemented");
  }

  async workflow(workflowId: string, opts: WorkflowOptions): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }

  async subscribe(opts: {
    namespace: string;
    fromSeq?: number;
    fromSnapshot?: "latest";
    protocols?: string[];
    consistency?: import("@quorum/types").ConsistencyLevel;
  }): Promise<AsyncIterable<import("@quorum/types").CommittedEntry>> {
    throw new Error("not implemented");
  }

  private getRuntimeStub(namespaceId: string): DurableObjectStub {
    const id = this.env.COORDINATION_RUNTIME.idFromName(namespaceId);
    return this.env.COORDINATION_RUNTIME.get(id);
  }
}
