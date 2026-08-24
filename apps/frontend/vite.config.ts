import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The app's XHR calls are prefixed with `/api` and the prefix is stripped
 * before forwarding, so `/api/events` reaches the API's `/events`.
 *
 * The prefix is NOT cosmetic. The SPA owns the `/events` and `/events/:id`
 * routes in the browser's address bar; proxying bare `/events` to the API
 * would intercept page navigation as well as data fetches, so opening
 * http://localhost:5173/events would return JSON instead of the app.
 *
 * `/api/docs` is proxied separately WITHOUT the rewrite, because the API
 * genuinely serves its Swagger UI at that path — stripping the prefix there
 * would rewrite it to `/docs` and 404.
 */
function apiProxy(target: string) {
  return {
    "^/api/docs": {
      target,
      changeOrigin: true,
    },
    "^/api/": {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ""),
    },
  };
}

export default defineConfig(() => {
  // Lets docker-compose point at the `api` service by name; defaults to
  // localhost for a standalone `npm run dev`.
  const target = process.env.VITE_API_TARGET ?? "http://localhost:3000";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        /**
         * Resolve the shared package to its TypeScript SOURCE, not its build
         * output.
         *
         * `packages/shared` compiles to CommonJS for the Node services, and
         * Rollup cannot statically extract named exports from a CJS module —
         * `import { PayrollEventType }` fails at build time even though it
         * type-checks. Vite compiles the TS directly, which also means the
         * frontend picks up shared-package edits without a rebuild step.
         */
        "@payroll/shared": fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
    },
    server: {
      host: true,
      port: 5173,
      proxy: apiProxy(target),
    },
    preview: {
      host: true,
      port: 4173,
      proxy: apiProxy(target),
    },
  };
});
