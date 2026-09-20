import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts"],
    // Every test file that uses the database starts an embedded Postgres: generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One cluster per file, files in sequence: avoids exhausting the ports on small machines.
    fileParallelism: false,
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
  },
});
