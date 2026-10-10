import type { J, Trace } from "./api";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const text = (v: J) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

// Upstream request as a runnable curl (not the /api/proxy call).
export function toCurl(entry: Trace): string {
  const r = entry.request ?? {};
  const method = r.method ?? entry.method;
  const parts = [`curl -X ${method} ${q(r.url ?? entry.url)}`];
  for (const [k, v] of Object.entries(r.headers ?? {})) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (r.body !== undefined && r.body !== null && method !== "GET") parts.push(`--data-raw ${q(typeof r.body === "string" ? r.body : JSON.stringify(r.body))}`);
  return parts.join(" \\\n  ");
}

// Fence one backtick longer than the longest run inside, so content cannot close it.
function fence(v: J): string {
  const s = text(v) ?? "";
  const f = "`".repeat(Math.max(3, ...(s.match(/`+/g) ?? []).map((m) => m.length + 1)));
  return `${f}\n${s}\n${f}`;
}

const msgs = (req: J, res: J, h = "###") => {
  const o = [`${h} Request`, fence(req?.headers ?? {})];
  if (req?.body !== undefined && req?.body !== null) o.push(fence(req.body));
  if (res) o.push(`${h} Response`, fence(res.headers ?? {}), fence(res.body));
  return o;
};

export function traceToMarkdown(entries: Trace[]): string {
  const o = ["# UCP Studio wire trace", "", `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`];
  entries.forEach((t, i) => {
    o.push("", `## ${i + 1}. ${t.method} ${t.url} → ${t.status ?? "ERR"} (${t.duration_ms} ms)`);
    if (t.error) o.push("", t.error);
    o.push("", ...msgs(t.request, t.response).flatMap((l) => [l, ""]));
  });
  return o.join("\n").trimEnd() + "\n";
}

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*[\r\n]+\s*/g, " ");

export function conformanceToMarkdown(r: J): string {
  const s = r.summary;
  const o = [
    "# UCP conformance report", "",
    `- Origin: ${r.origin}`, `- Transport: ${r.transport}`, `- Started: ${r.started_at}`, `- Duration: ${r.duration_ms} ms`, "",
    `**${s.pass} pass, ${s.fail} fail, ${s.warn} warn, ${s.skip} skip**`, "",
    "| Status | Step | Title | Detail |", "| --- | --- | --- | --- |",
    ...r.steps.map((x: J) => `| ${cell(x.status).toUpperCase()} | ${cell(x.id)} | ${cell(x.title)} | ${cell(x.detail)} |`),
  ];
  for (const x of r.steps.filter((x: J) => x.exchanges?.length)) {
    o.push("", `## ${x.id}: ${x.title}`);
    for (const e of x.exchanges) {
      const none = e.response.status === 0;
      o.push("", `### ${e.request.method} ${e.request.url} → ${none ? "no response" : e.response.status} (${e.duration_ms} ms)`, "");
      if (none) o.push(text(e.response.body), "");
      o.push(...msgs(e.request, none ? null : e.response, "####").flatMap((l) => [l, ""]));
    }
  }
  return o.join("\n").trimEnd() + "\n";
}

export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Accepts { products: [...] } or a bare array; any `replace` key is ignored (the checkbox decides). Field validation is the server's job.
export function parseCatalogImport(text: string): J[] {
  let v: J;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`Catalog is not valid JSON: ${(e as Error).message}`);
  }
  const products = Array.isArray(v) ? v : v?.products;
  if (products === undefined) throw new Error('Expected {"products": [...]} or an array of products.');
  if (!Array.isArray(products)) throw new Error('"products" must be an array.');
  return products;
}
