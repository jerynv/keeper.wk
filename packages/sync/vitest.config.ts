import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the runtime the Worker ships on, against a migrated local D1.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "../database/migrations"),
          ),
        },
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
      },
    })),
  ],
  test: {
    globals: true,
    include: ["./tests/**/*.test.ts"],
    setupFiles: ["../database/tests/apply-migrations.ts"],
  },
});
