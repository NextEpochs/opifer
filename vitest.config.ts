import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Ogni file di test che usa il database avvia un Postgres incorporato: tempi generosi.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Un cluster per file, file in sequenza: evita di saturare le porte sulle macchine piccole.
    fileParallelism: false,
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
  },
});
