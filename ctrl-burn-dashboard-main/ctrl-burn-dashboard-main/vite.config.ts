import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

const APP_PORT = Number(process.env.PORT ?? 8080);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: APP_PORT,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 120,
    },
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": {
        target: process.env.CTRL_BACKEND_URL ?? "http://localhost:8787",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "::",
    port: APP_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.CTRL_BACKEND_URL ?? "http://localhost:8787",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
