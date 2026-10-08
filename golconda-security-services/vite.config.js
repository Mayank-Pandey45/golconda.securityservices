import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Local API calls remain relative (/api/*); only the Vite dev server proxies them.
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true } },
  },
});
