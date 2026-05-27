declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATION_RUNTIME: DurableObjectNamespace;
    COORDINATION_RUNTIME_0: DurableObjectNamespace;
    NAMESPACE_ROUTER: DurableObjectNamespace;
    REPLICA: DurableObjectNamespace;
    QUORUM_STORAGE: R2Bucket;
  }
}
