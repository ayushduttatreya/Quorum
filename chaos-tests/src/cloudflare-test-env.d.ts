declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATION_RUNTIME: DurableObjectNamespace;
    REPLICA: DurableObjectNamespace;
    QUORUM_STORAGE: R2Bucket;
  }
}
