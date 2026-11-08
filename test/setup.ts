import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

/** Apply the production SQL migration to each isolated test database. */
beforeAll(async () => {
  const bindings = env as typeof env & {
    DB: D1Database;
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
