import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4000";
const dbPath = fileURLToPath(new URL("../data.db", import.meta.url));
createApp({ dbPath, baseUrl }).listen(4000, "127.0.0.1", () => console.log(`UCP Studio server on ${baseUrl}`));
