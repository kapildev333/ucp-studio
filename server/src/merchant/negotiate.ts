import { UCP_VERSION } from "../ucp.js";
import { ProtocolError, type Result } from "./errors.js";

type Entry = { version: string; extends?: string };
type Cap = { name: string; version: string };
// What the platform sent: its capabilities object, raw (order-service reads the webhook config from it).
export type Negotiated = { capabilities: Cap[]; platformCapabilities: Record<string, unknown> };
export type ProfileCache = Map<string, { at: number; profile: Record<string, any> }>;

// The merchant's business capabilities: the single source for the served profile and for negotiation.
const v = { version: UCP_VERSION };
export const BUSINESS_CAPS: Record<string, Entry[]> = {
  "dev.ucp.shopping.checkout": [v],
  "dev.ucp.shopping.catalog.search": [v],
  "dev.ucp.shopping.catalog.lookup": [v],
  "dev.ucp.shopping.fulfillment": [{ ...v, extends: "dev.ucp.shopping.checkout" }],
  "dev.ucp.shopping.order": [v],
};

const TTL_MS = 5 * 60 * 1000;
const err = (status: number, code: string, content: string) => new ProtocolError(status, code, content);

// Highest version in both lists per name, then prune extensions whose parent was dropped until stable.
export function intersect(business: Record<string, Entry[]>, platform: Record<string, unknown>): Cap[] {
  let kept = Object.entries(business).flatMap(([name, entries]) => {
    const theirs = new Set((Array.isArray(platform[name]) ? platform[name] : []).map((c: any) => c?.version));
    const best = entries.filter((e) => theirs.has(e.version)).sort((a, b) => a.version.localeCompare(b.version)).at(-1);
    return best ? [{ name, ...best }] : [];
  });
  for (let n = -1; n !== kept.length;) {
    n = kept.length;
    kept = kept.filter((c) => !c.extends || kept.some((p) => p.name === c.extends));
  }
  return kept.map(({ name, version }) => ({ name, version }));
}

async function fetchProfile(url: string, f: typeof fetch) {
  let res: Response;
  try {
    // ponytail: fetches any URL the caller names; acceptable only because the server binds to 127.0.0.1. Add an allowlist / SSRF guard before exposing it.
    res = await f(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3000) });
  } catch {
    throw err(424, "profile_unreachable", `Could not fetch platform profile ${url}`);
  }
  if (!res.ok) throw err(424, "profile_unreachable", `Platform profile ${url} returned ${res.status}`);
  const profile = await res.json().catch(() => undefined);
  const version = profile?.ucp?.version;
  if (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version)) throw err(422, "profile_malformed", "Platform profile must be a JSON object with ucp.version (YYYY-MM-DD)");
  if (version > UCP_VERSION) throw err(422, "version_unsupported", `Platform UCP version ${version} is newer than ${UCP_VERSION}`);
  return profile as Record<string, any>;
}

// Transport-independent: REST passes the UCP-Agent profile URL, MCP passes meta["ucp-agent"].profile.
export async function negotiate(profileUrl: unknown, { fetch: f, cache }: { fetch: typeof fetch; cache: ProfileCache }): Promise<Negotiated> {
  let ok = false;
  try {
    ok = typeof profileUrl === "string" && ["http:", "https:"].includes(new URL(profileUrl).protocol);
  } catch {}
  if (!ok) throw err(400, "invalid_profile_url", "UCP-Agent must carry profile=\"<absolute http(s) URL>\"");
  let hit = cache.get(profileUrl as string);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), profile: await fetchProfile(profileUrl as string, f) };
    cache.set(profileUrl as string, hit);
  }
  const caps = hit.profile.ucp.capabilities;
  const platformCapabilities = caps && typeof caps === "object" && !Array.isArray(caps) ? caps : {};
  return { capabilities: intersect(BUSINESS_CAPS, platformCapabilities), platformCapabilities };
}

export const has = (n: Negotiated, name: string) => n.capabilities.some((c) => c.name === name);

// Response envelope listing the negotiated capabilities among `names`.
export const envelopeFor = (n: Negotiated, names: string[]) => ({ version: UCP_VERSION, capabilities: n.capabilities.filter((c) => names.includes(c.name)) });

// Step 4: when the operation's root capability isn't negotiated, answer 200 with an error envelope; else undefined.
export const incompatible = (n: Negotiated, root: string): Result | undefined => has(n, root) ? undefined : {
  status: 200,
  body: {
    ucp: { version: UCP_VERSION, status: "error", capabilities: [] },
    messages: [{ type: "error", code: "capabilities_incompatible", severity: "unrecoverable", content: `Platform and merchant share no version of ${root}` }],
  },
};
