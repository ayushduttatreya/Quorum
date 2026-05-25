// Example: distributed lock for payment processing with fencing tokens
// Shows: quorum.lock(), fencing token usage, TTL, retry semantics

import { Quorum } from "@quorum/sdk";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const quorum = new Quorum(env);
    const { orderId } = await request.json() as { orderId: string };

    const result = await quorum.lock(`order-${orderId}`, async (fencingToken) => {
      // fencingToken is passed to downstream storage to prevent stale writes
      return { processed: true, fencingToken: fencingToken.toString() };
    });

    return Response.json(result);
  },
};

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
