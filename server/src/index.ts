import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 4000;
const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
const dbPath = fileURLToPath(new URL("../data.db", import.meta.url));
createApp({ dbPath, baseUrl }).listen(port, "127.0.0.1", () => console.log(`UCP Studio server on ${baseUrl}`));
