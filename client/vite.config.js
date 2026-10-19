import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  // Read only the server port; root server secrets never enter the browser config.
  const server = loadEnv(
    mode,
    fileURLToPath(new URL("..", import.meta.url)),
    "PORT",
  );
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
