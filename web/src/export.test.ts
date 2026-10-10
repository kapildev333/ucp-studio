import { describe, expect, it } from "vitest";
import { conformanceToMarkdown, parseCatalogImport, toCurl, traceToMarkdown } from "./export";
import type { Trace } from "./api";

const tr = (o: Partial<Trace> = {}): Trace => ({
  id: 1, method: "GET", url: "https://m.test/a", status: 200, duration_ms: 5,
  request: { method: "GET", url: "https://m.test/a", headers: { Accept: "x" } },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } }, ...o,
});

describe("toCurl", () => {
  it("GET has no body", () => {
    expect(toCurl(tr())).toBe("curl -X GET 'https://m.test/a' \\\n  -H 'Accept: x'");
  });
  it("POST with JSON body and headers", () => {
    const c = toCurl(tr({ request: { method: "POST", url: "https://m.test/c", headers: { A: "1", B: "2" }, body: { a: 1 } } }));
    expect(c).toBe("curl -X POST 'https://m.test/c' \\\n  -H 'A: 1' \\\n  -H 'B: 2' \\\n  --data-raw '{\"a\":1}'");
  });
  it("POST with null body emits no --data-raw", () => {
    expect(toCurl(tr({ request: { method: "POST", url: "https://m.test/c", body: null } }))).not.toContain("--data-raw");
  });
  it("GET with a body emits no --data-raw", () => {
    expect(toCurl(tr({ request: { method: "GET", url: "https://m.test/a", body: { a: 1 } } }))).not.toContain("--data-raw");
  });
  it("escapes single quotes in url, header and body", () => {
    const c = toCurl(tr({ request: { method: "POST", url: "https://m.test/it's", headers: { X: "a'b" }, body: "it's" } }));
    expect(c).toContain("'https://m.test/it'\\''s'");
    expect(c).toContain("-H 'X: a'\\''b'");
    expect(c).toContain("--data-raw 'it'\\''s'");
  });
  it("tolerates missing headers and falls back to entry method/url", () => {
    expect(toCurl(tr({ request: {} }))).toBe("curl -X GET 'https://m.test/a'");
  });
});

describe("traceToMarkdown", () => {
  it("keeps order, handles errored entries and backticks in bodies", () => {
    const md = traceToMarkdown([
      tr({ id: 1, url: "https://m.test/first", request: { method: "POST", url: "https://m.test/first", body: "a ``` b" } }),
      tr({ id: 2, method: "POST", url: "https://m.test/second", status: null, error: "boom", response: null }),
    ]);
    expect(md).toContain("# UCP Studio wire trace");
    expect(md).toContain("2 entries");
    expect(md.indexOf("/first")).toBeLessThan(md.indexOf("/second"));
    expect(md).toContain("## 2. POST https://m.test/second → ERR (5 ms)");
    expect(md).toContain("boom");
    expect(md).toContain("````\na ``` b\n````");
  });
});

const ex = (status: number, body: unknown = { a: 1 }) => ({
  request: { method: "GET", url: "https://m.test/x", headers: { H: "v" }, body: undefined },
  response: { status, headers: {}, body }, duration_ms: 3,
});
describe("conformanceToMarkdown", () => {
  const md = conformanceToMarkdown({
    origin: "https://m.test", transport: "rest", started_at: "2026-01-01T00:00:00Z", duration_ms: 42,
    summary: { pass: 1, fail: 2, warn: 3, skip: 4 },
    steps: [
      { id: "s1", title: "One", status: "pass", detail: "a | b\nc", exchanges: [ex(200), ex(0, "ECONNREFUSED")] },
      { id: "s2", title: "Two", status: "skip", detail: "n/a", exchanges: [] },
    ],
  });
  it("has summary counts and uppercase statuses", () => {
    expect(md).toContain("# UCP conformance report");
    expect(md).toMatch(/1 pass.*2 fail.*3 warn.*4 skip/);
    expect(md).toContain("| PASS | s1 |");
    expect(md).toContain("| SKIP | s2 |");
  });
  it("escapes pipes and newlines in cells", () => {
    expect(md).toContain("a \\| b c");
  });
  it("prints status 0 as no response", () => {
    expect(md).toContain("no response");
    expect(md).toContain("ECONNREFUSED");
    expect(md).not.toMatch(/→ 0/);
  });
  it("omits exchange section for steps without exchanges", () => {
    expect(md).toContain("## s1: One");
    expect(md).not.toContain("## s2: Two");
  });
});

describe("parseCatalogImport", () => {
  const p = [{ title: "A", variants: [] }];
  it("accepts { products } and ignores replace", () => {
    expect(parseCatalogImport(JSON.stringify({ replace: true, products: p }))).toEqual(p);
  });
  it("accepts a bare array", () => {
    expect(parseCatalogImport(JSON.stringify(p))).toEqual(p);
  });
  it("rejects invalid JSON", () => {
    expect(() => parseCatalogImport("{nope")).toThrow(/not valid JSON/);
  });
  it("rejects an object without products", () => {
    expect(() => parseCatalogImport("{}")).toThrow(/products/);
    expect(() => parseCatalogImport("null")).toThrow(/products/);
  });
  it("rejects products that is not an array", () => {
    expect(() => parseCatalogImport('{"products":{}}')).toThrow(/array/);
  });
});
