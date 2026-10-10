import { createApp } from "./app.js";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:4000";
createApp({ dbPath: "data.db", baseUrl }).listen(4000, "127.0.0.1", () => console.log(`UCP Studio server on ${baseUrl}`));
