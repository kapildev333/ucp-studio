import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.UCP_SERVER ?? `http://127.0.0.1:${process.env.PORT || 4000}`;
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    host: "127.0.0.1",
    proxy: Object.fromEntries(["/api", "/ucp", "/.well-known", "/orders", "/merchant-admin", "/track"].map((p) => [p, target])),
  },
});
