// Example: multi-step onboarding workflow with compensation
// Shows: quorum.workflow(), step dependencies, parallel execution, compensation on failure

import { Quorum } from "@quorum/sdk";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const quorum = new Quorum(env);
    const { userId } = await request.json() as { userId: string };

    const result = await quorum.workflow(`onboard-${userId}`, {
      steps: {
        createAccount: async (ctx) => {
          return { accountId: `acct-${ctx.input["userId"]}` };
        },
        sendWelcomeEmail: async (ctx) => {
          const { accountId } = ctx.results["createAccount"] as { accountId: string };
          return { emailSent: true, to: accountId };
        },
        provisionResources: async (ctx) => {
          return { resourceId: `res-${ctx.input["userId"]}` };
        },
      },
      parallelism: {
        sendWelcomeEmail: ["createAccount"],
        provisionResources: ["createAccount"],
      },
    });

    return Response.json(result);
  },
};

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
  REPLICA: DurableObjectNamespace;
  QUORUM_STORAGE: R2Bucket;
}
