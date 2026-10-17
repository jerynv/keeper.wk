import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs the Worker's own handlers inside workerd with its wrangler bindings.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "../database/migrations")),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    })),
  ],
  test: {
    include: ["./tests/**/*.test.ts"],
    setupFiles: ["../database/tests/apply-migrations.ts"],
  },
});
