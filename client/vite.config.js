import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  // Read only the server port and local-only flag; root server secrets never
  // enter the browser config.
  const server = loadEnv(
    mode,
    fileURLToPath(new URL("..", import.meta.url)),
    ["PORT", "LOCAL_DEV_ONLY"],
  );
  // With LOCAL_DEV_ONLY=true the browser must also use local Supabase and the
  // local API, so a stray hosted client/.env cannot sign in to production.
  if (server.LOCAL_DEV_ONLY === "true") {
    const client = loadEnv(
      mode,
      fileURLToPath(new URL(".", import.meta.url)),
      "VITE_",
    );
    const origin = (value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    };
    const api = client.VITE_API_URL || "/api";
    if (
      origin(client.VITE_SUPABASE_URL) !== "http://127.0.0.1:54321" ||
      (!api.startsWith("/") &&
        !["http://127.0.0.1", "http://localhost"].some(
          (local) => origin(api)?.startsWith(local + ":"),
        ))
    )
      throw new Error(
        "LOCAL_DEV_ONLY: client/.env must use VITE_SUPABASE_URL=http://127.0.0.1:54321 and a local VITE_API_URL such as /api.",
      );
  }
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${server.PORT || 3001}`,
          changeOrigin: true,
        },
      },
    },
    test: { environment: "jsdom", setupFiles: ["./tests/setup.js"] },
    build: {
      rollupOptions: {
        output: {
          // Startup libraries get their own long-cached chunks, so an app
          // update does not force browsers to download them again. Libraries
          // used only by lazy pages stay with those pages.
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (
              /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(
                id,
              )
            )
              return "vendor-react";
            if (id.includes("/node_modules/@supabase/"))
              return "vendor-supabase";
            if (
              /[\\/]node_modules[\\/](zod|react-hook-form|@hookform)[\\/]/.test(
                id,
              )
            )
              return "vendor-forms";
            if (id.includes("/node_modules/@tanstack/")) return "vendor-query";
          },
        },
      },
    },
  };
});
