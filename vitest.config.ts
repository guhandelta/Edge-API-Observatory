import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

/** Run tests in workerd with the real D1 migration and configured bindings. */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: {
    include: ["test/worker.spec.ts", "test/metrics.spec.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "istanbul",
      include: ["worker/index.ts", "shared/contracts.ts", "src/metrics.ts"],
      reportsDirectory: "./coverage/worker",
      reporter: ["text", "json", "json-summary", "html"],
      thresholds: { 100: true, perFile: true },
    },
  },
});
