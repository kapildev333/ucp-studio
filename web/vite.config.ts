import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:4000";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: Object.fromEntries(["/api", "/ucp", "/.well-known", "/orders"].map((p) => [p, target])),
  },
});
