// Example: leader election for a distributed job scheduler
// Shows: quorum.elect(), onElected/onDeposed callbacks, lease renewal

import { Quorum } from "@quorum/sdk";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const quorum = new Quorum(env);

    const election = await quorum.elect("job-scheduler", {
      candidateId: env.CF_WORKER_INSTANCE_ID ?? crypto.randomUUID(),
      onElected: async () => {
        console.log("Elected as leader — starting job scheduling");
      },
      onDeposed: async () => {
        console.log("Deposed — stopping job scheduling");
      },
    });

    return Response.json({ isLeader: election.isLeader() });
  },
};

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
  CF_WORKER_INSTANCE_ID?: string;
}
