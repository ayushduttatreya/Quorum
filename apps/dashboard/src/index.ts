// Dashboard Worker — serves topology visualization, replay inspector, trace UI

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/topology":
        return handleTopology(request, env);
      case "/api/replay":
        return handleReplay(request, env);
      case "/api/traces":
        return handleTraces(request, env);
      default:
        return new Response("QUORUM Dashboard", { status: 200 });
    }
  },
};

async function handleTopology(_req: Request, _env: Env): Promise<Response> {
  throw new Error("not implemented");
}

async function handleReplay(_req: Request, _env: Env): Promise<Response> {
  throw new Error("not implemented");
}

async function handleTraces(_req: Request, _env: Env): Promise<Response> {
  throw new Error("not implemented");
}

interface Env {
  COORDINATION_RUNTIME: DurableObjectNamespace;
}
