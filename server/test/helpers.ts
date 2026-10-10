import { UCP_VERSION } from "../src/ucp.js";

export const AGENT_URL = "http://127.0.0.1:4000/api/agent-profile";
export const AGENT = { "UCP-Agent": `profile="${AGENT_URL}"` };
export const CAPS = ["checkout", "catalog.search", "catalog.lookup", "fulfillment"].map((c) => `dev.ucp.shopping.${c}`);

export const profileOf = (names: string[] = CAPS, version = UCP_VERSION) => ({
  ucp: { version, capabilities: Object.fromEntries(names.map((n) => [n, [{ version: UCP_VERSION }]])) },
});

// A fetch serving `profile` at AGENT_URL (404 elsewhere); records every requested URL in `calls`.
export const fakeFetch = (profile: unknown = profileOf()) => {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return String(url) === AGENT_URL ? new Response(JSON.stringify(profile)) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
};
