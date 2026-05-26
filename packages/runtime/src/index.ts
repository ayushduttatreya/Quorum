export { CoordinationRuntimeDO } from "./coordination-runtime-do.ts";
export { ReplicaDO } from "./replication/replica-do.ts";

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response("quorum-runtime", { status: 200 });
  },
};
