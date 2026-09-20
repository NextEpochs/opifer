import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths: the interface works at the root and under a path (a reverse proxy at /opifer/).
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 4710,
    proxy: {
      "/v1": { target: "http://127.0.0.1:4700", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
