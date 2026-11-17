import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-proxy target port: the local `ui.port` from ai-flow.config.json (repo
 * root first, then the package root) — the same file the viewer itself binds,
 * so `vite dev` and `ai-flow ui` agree. Falls back to 7777.
 */
function uiPort(): number {
  for (const file of [path.join(root, "..", "ai-flow.config.json"), path.join(root, "ai-flow.config.json")]) {
    try {
      const cfg = JSON.parse(readFileSync(file, "utf8")) as { ui?: { port?: unknown } };
      if (typeof cfg.ui?.port === "number" && cfg.ui.port > 0) return cfg.ui.port;
    } catch {
      // no local config — use the fallback
    }
  }
  return 7777;
}

export default defineConfig({
  root: path.join(root, "viewer-ui"),
  plugins: [react()],
  resolve: {
    /* `@/` is the viewer's own src tree; `@server/` is the runtime tree whose
     * shared type definitions the viewer imports. Explicit aliases keep these
     * cross-directory imports stable when files move between layers. */
    alias: {
      "@server": path.join(root, "viewer-ui", "src", "_server"),
      "@": path.join(root, "viewer-ui", "src"),
    },
  },
  build: {
    outDir: path.join(root, "dist", "viewer-ui"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the vendor weight out of the app chunk: MUI/Emotion are the
        // bulk of the page, React a smaller second chunk, so the first paint
        // downloads three cacheable chunks instead of one ~600KB blob.
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@mui") || id.includes("@emotion") || id.includes("csstype")) return "vendor-mui";
          if (id.includes("react-dom") || id.includes("scheduler") || id.includes("react")) return "vendor-react";
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${uiPort()}`,
    },
  },
  /* Viewer-UI unit tests (vitest + jsdom + @testing-library/react). The React
   * layer had no runtime coverage — only `tsc --noEmit` + eslint — so the SSE
   * stream/poll fallback, the markdown escaper and the action-dialog lock were
   * unguarded. Glob patterns are relative to `root` (viewer-ui/). */
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
