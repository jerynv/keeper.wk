import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
      },
    })),
  ],
  test: {
    include: ["./tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
