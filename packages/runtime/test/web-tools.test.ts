import { describe, expect, it } from "vitest";
import { fetchReadable, htmlToText, isPrivateAddress, webSearch, webFetchTool, webSearchTool } from "../src/tools/web.js";

const response = (body: string, init: { status?: number; type?: string; location?: string } = {}) =>
  ({
    status: init.status ?? 200,
    ok: (init.status ?? 200) < 400,
    headers: { get: (name: string) => (name === "content-type" ? (init.type ?? "text/html; charset=utf-8") : name === "location" ? (init.location ?? null) : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    json: async () => JSON.parse(body) as unknown,
  }) as unknown as Response;

describe("web tools", () => {
  it("turns a page into readable text with title, headings, list items and links", () => {
    const html = `<html><head><title>Opifer &amp; friends</title><style>p{}</style></head><body><nav>Menu</nav>
      <h1>Hello</h1><p>First &quot;paragraph&quot;.<script>alert(1)</script></p><ul><li>one</li><li><a href="/docs">Docs</a></li></ul></body></html>`;
    const { title, text } = htmlToText(html, "https://opifer.dev/");
    expect(title).toBe("Opifer & friends");
    expect(text).toContain("## Hello");
    expect(text).toContain('First "paragraph".');
    expect(text).toContain("- one");
    expect(text).toContain("Docs (https://opifer.dev/docs)");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Menu");
  });

  it("never fetches private, loopback or link-local addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "100.64.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
    await expect(fetchReadable("http://127.0.0.1:4700/v1/health")).rejects.toThrow(/private/);
    await expect(fetchReadable("http://localhost/x")).rejects.toThrow(/local/);
    await expect(fetchReadable("ftp://example.com/x")).rejects.toThrow(/http/);
  });

  it("follows redirects, strips HTML, pretty-prints JSON and truncates", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: URL | string) => {
      const u = url.toString();
      calls.push(u);
      if (u === "https://example.com/old") return response("", { status: 301, location: "/new" });
      if (u === "https://example.com/new") return response("<title>New</title><p>Moved here.</p>");
      if (u === "https://example.com/data.json") return response('{"a":1}', { type: "application/json" });
      return response("x".repeat(100), { type: "text/plain" });
    }) as unknown as typeof fetch;
    const page = await fetchReadable("https://example.com/old", { fetcher });
    expect(calls).toEqual(["https://example.com/old", "https://example.com/new"]);
    expect(page).toMatchObject({ url: "https://example.com/new", title: "New", status: 200 });
    expect(page.text).toContain("Moved here.");
    expect((await fetchReadable("https://example.com/data.json", { fetcher })).text).toBe('{\n  "a": 1\n}');
    const short = await fetchReadable("https://example.com/long.txt", { fetcher, maxChars: 10 });
    expect(short.truncated).toBe(true);
    expect(short.text).toContain("[truncated at 10 characters of 100]");
    expect(webFetchTool.definition.name).toBe("web_fetch");
  });

  it("offers web_search only to companies with a provider, and explains itself otherwise", async () => {
    const options = new Map<string, { provider: "brave"; apiKey: string; fetcher: typeof fetch }>();
    const fetcher = (async () =>
      response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b", description: "brave" }] } }), { type: "application/json" })) as unknown as typeof fetch;
    options.set("acme", { provider: "brave", apiKey: "k", fetcher });
    const tool = webSearchTool(async (companyId) => options.get(companyId) ?? null);
    expect(await tool.available!({ companyId: "acme", agentId: "a" })).toBe(true);
    expect(await tool.available!({ companyId: "other", agentId: "a" })).toBe(false);
    const context = { sessionId: "s", companyId: "other", agentId: "a", runId: "r", callId: "c", agentRole: "x", workdir: "/tmp", signal: new AbortController().signal };
    expect((await tool.execute({ query: "q" }, context)).isError).toBe(true);
    expect((await tool.execute({ query: "q" }, { ...context, companyId: "acme" })).content).toContain("https://b");
  });

  it("searches through Brave, Tavily or SearXNG and normalises the results", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: url.toString(), ...(init ? { init } : {}) });
      const u = url.toString();
      if (u.startsWith("https://api.search.brave.com"))
        return response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b", description: "brave" }] } }), { type: "application/json" });
      if (u.startsWith("https://api.tavily.com")) return response(JSON.stringify({ results: [{ title: "T", url: "https://t", content: "tavily" }] }), { type: "application/json" });
      return response(JSON.stringify({ results: [{ title: "S", url: "https://s", content: "searx" }] }), { type: "application/json" });
    }) as unknown as typeof fetch;
    expect(await webSearch("opifer", { provider: "brave", apiKey: "k", fetcher })).toEqual([{ title: "B", url: "https://b", snippet: "brave" }]);
    expect((seen[0]!.init!.headers as Record<string, string>)["X-Subscription-Token"]).toBe("k");
    expect(await webSearch("opifer", { provider: "tavily", apiKey: "k", fetcher })).toEqual([{ title: "T", url: "https://t", snippet: "tavily" }]);
    expect(await webSearch("opifer", { provider: "searxng", url: "https://searx.example/", fetcher })).toEqual([{ title: "S", url: "https://s", snippet: "searx" }]);
    expect(seen[2]!.url).toBe("https://searx.example/search?q=opifer&format=json");
    await expect(webSearch("x", { provider: "brave", fetcher })).rejects.toThrow(/API key/);
  });
});
