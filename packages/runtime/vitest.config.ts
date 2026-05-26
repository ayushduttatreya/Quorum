import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: "./src/index.ts",
        wrangler: {
          configPath: "../../wrangler.toml",
        },
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
        },
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
