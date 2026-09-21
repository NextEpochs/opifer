/**
 * The web for the agents: fetch a page as readable text, and search.
 * Fetching never reaches private addresses (the server may sit on a VPS next
 * to other services); search goes through the provider the installation
 * configured: Brave, Tavily or a SearXNG instance.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { str } from "./native.js";
import type { NativeTool } from "./types.js";

const MAX_BODY = 5 * 1024 * 1024;
const DEFAULT_CHARS = 12_000;

/** Private, loopback, link-local and special ranges: never fetched, whatever the hostname said. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return false;
  }
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https are fetched, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("local addresses are not fetched");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error(`cannot resolve ${host}`);
  for (const { address } of addresses) if (isPrivateAddress(address)) throw new Error("private addresses are not fetched");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", laquo: "«", raquo: "»" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Readable text from an HTML page: title, headings, paragraphs, list items, links as "text (url)". */
export function htmlToText(html: string, baseUrl?: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|canvas)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, "\n");
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (!text || href.startsWith("#") || href.startsWith("javascript:")) return text;
    let abs = href;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      // keep as is
    }
    return `${text} (${abs})`;
  });
  s = s.replace(/<(h[1-6])[^>]*>/gi, "\n\n## ").replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/(p|div|section|article|li|tr|blockquote|pre|table|ul|ol|dl|dd|dt|header|main|figure|figcaption)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(td|th)[^>]*>/gi, " | ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

export interface FetchOptions {
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/** Fetches a public URL and returns it as readable text (HTML stripped), JSON or plain text, capped. */
export async function fetchReadable(
  rawUrl: string,
  options: FetchOptions & { maxChars?: number } = {},
): Promise<{ url: string; status: number; title: string; text: string; truncated: boolean }> {
  const fetcher = options.fetcher ?? fetch;
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "Opifer/1.3 (+https://opifer.dev)", accept: "text/html,application/json,text/plain,*/*;q=0.5", "accept-language": "en,it;q=0.8" },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        url = new URL(response.headers.get("location")!, url);
        continue;
      }
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_BODY) throw new Error(`the page is larger than ${MAX_BODY / 1024 / 1024} MB`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BODY) throw new Error(`the page is larger than ${MAX_BODY / 1024 / 1024} MB`);
      const body = buffer.toString("utf8");
      const max = options.maxChars ?? DEFAULT_CHARS;
      let title = "";
      let text: string;
      if (type.includes("html")) ({ title, text } = htmlToText(body, url.toString()));
      else if (type.includes("json")) {
        try {
          text = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          text = body;
        }
      } else if (type.startsWith("text/") || type === "") text = body;
      else text = `[${type}, ${buffer.length} bytes: not a text document]`;
      const truncated = text.length > max;
      return {
        url: url.toString(),
        status: response.status,
        title,
        text: truncated ? `${text.slice(0, max)}\n\n[truncated at ${max} characters of ${text.length}]` : text,
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("too many redirects");
}

export const webFetchTool: NativeTool = {
  risk: "low",
  definition: {
    name: "web_fetch",
    description:
      "Fetches a public web page or API URL and returns it as readable text (HTML stripped to title, headings, paragraphs and links; JSON pretty-printed). Use it to read documentation, articles, product pages, results of a search. Long pages are truncated: ask for a range with offset.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "http(s) URL" },
        max_chars: { type: "integer", minimum: 500, maximum: 60000, description: "Characters to return (default 12000)." },
        offset: { type: "integer", minimum: 0, description: "Skip this many characters of the text first (to read on)." },
      },
    },
  },
  async execute(args) {
    const url = str(args, "url");
    const max = typeof args["max_chars"] === "number" ? args["max_chars"] : DEFAULT_CHARS;
    const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
    const page = await fetchReadable(url, { maxChars: offset + max });
    const text = offset > 0 ? page.text.slice(offset) : page.text;
    return { content: `${page.title ? `# ${page.title}\n` : ""}URL: ${page.url} (HTTP ${page.status})\n\n${text}` };
  },
};

export interface SearchOptions {
  provider: "brave" | "tavily" | "searxng";
  /** The API key (Brave, Tavily). */
  apiKey?: string;
  /** The instance URL (SearXNG). */
  url?: string;
  fetcher?: typeof fetch;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Web search through the configured provider. */
export async function webSearch(query: string, options: SearchOptions, count = 8): Promise<SearchResult[]> {
  const fetcher = options.fetcher ?? fetch;
  const n = Math.max(1, Math.min(20, count));
  if (options.provider === "brave") {
    if (!options.apiKey) throw new Error("Brave search needs an API key (BRAVE_API_KEY)");
    const res = await fetcher(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
      headers: { accept: "application/json", "X-Subscription-Token": options.apiKey },
    });
    if (!res.ok) throw new Error(`Brave search answered ${res.status}`);
    const body = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (body.web?.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
  }
  if (options.provider === "tavily") {
    if (!options.apiKey) throw new Error("Tavily needs an API key (TAVILY_API_KEY)");
    const res = await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ query, max_results: n }),
    });
    if (!res.ok) throw new Error(`Tavily answered ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (body.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
  if (!options.url) throw new Error("SearXNG needs the instance URL (SEARXNG_URL)");
  const base = options.url.replace(/\/$/, "");
  const res = await fetcher(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`SearXNG answered ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (body.results ?? []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

export function webSearchTool(options: SearchOptions): NativeTool {
  return {
    risk: "low",
    definition: {
      name: "web_search",
      description:
        "Searches the web and returns titles, URLs and snippets. Follow up with web_fetch on the pages that matter. Say what you found and where: every number comes with its source.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, count: { type: "integer", minimum: 1, maximum: 20, description: "Results to return (default 8)." } },
      },
    },
    async execute(args) {
      const query = str(args, "query");
      const count = typeof args["count"] === "number" ? args["count"] : 8;
      const results = await webSearch(query, options, count);
      if (results.length === 0) return { content: `No results for "${query}".` };
      return { content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 300)}` : ""}`).join("\n\n") };
    },
  };
}
