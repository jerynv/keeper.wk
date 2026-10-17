import { resolve } from "node:path";
import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

// Built as a static single-page app; the Worker serves it and answers /api itself.
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      autoCodeSplitting: true,
      generatedRouteTree: "src/generated/tanstack/route-tree.generated.ts",
      target: "react",
    }),
    react(),
    babel({
      presets: [
        ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
        reactCompilerPreset(),
      ],
    }),
    svgr(),
  ],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/react-dom/") || id.includes("/react/")) {
            return "react-vendor";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": { changeOrigin: true, target: "http://localhost:8795" },
    },
  },
});
