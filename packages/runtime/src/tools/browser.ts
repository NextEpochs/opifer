/**
 * A browser for the agents: Chrome on the machine driven through Playwright.
 * One page per session, kept between tool calls and closed when the session
 * stays idle. The agent reads a page as text plus a numbered list of what it
 * can act on (links, buttons, fields), then clicks, types and reads again.
 * Screenshots land in the task's folder, so they are artifacts.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { str } from "./native.js";
import { assertPublic, isPrivateAddress } from "./web.js";
import type { NativeTool, ToolContext } from "./types.js";

export interface BrowserOptions {
  /** Chrome, Chromium or Edge on this machine; found with findBrowser() when omitted. */
  executablePath?: string;
  /** Close a session's browser after this long without a call (default 10 minutes). */
  idleMs?: number;
  /** Tests only: let the browser reach private addresses. */
  allowPrivate?: boolean;
  /** Tests only: a fixed clock. */
  now?: () => number;
}

const CANDIDATES =
  process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge"];

/** A Chrome-like browser on this machine: OPIFER_BROWSER, the usual places, or Playwright's own download. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env["OPIFER_BROWSER"];
  if (named) return existsSync(named) ? named : null;
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    // no Playwright download on this machine
  }
  return null;
}

interface Live {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  shots: number;
}

const DEFAULT_CHARS = 12_000;
const MAX_ELEMENTS = 150;

/** What the page looks like to the agent: title, URL, the text, and the elements it can act on. */
export interface Snapshot {
  title: string;
  url: string;
  text: string;
  elements: string[];
}

/**
 * Runs in the page: marks every visible link, button, field and select with
 * a data-opifer-ref, and describes them. Plain JavaScript on purpose (it is
 * serialised into the browser).
 */
const SNAPSHOT_SCRIPT = `(max) => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const labelOf = (el) => {
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
    return clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.textContent || el.getAttribute("alt"));
  };
  const nodes = Array.from(document.querySelectorAll("a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [contenteditable=true]"));
  const out = [];
  let n = 0;
  for (const el of nodes) {
    if (out.length >= max) break;
    if (!visible(el)) continue;
    if (el.tagName === "INPUT" && el.type === "hidden") continue;
    n += 1;
    const ref = "e" + n;
    el.setAttribute("data-opifer-ref", ref);
    const tag = el.tagName.toLowerCase();
    let kind = tag;
    if (tag === "input") kind = "input:" + (el.type || "text");
    else if (el.getAttribute("role")) kind = el.getAttribute("role");
    const bits = [];
    const label = labelOf(el).slice(0, 80);
    if (label) bits.push(JSON.stringify(label));
    if (tag === "a" && el.getAttribute("href")) bits.push("→ " + el.href.slice(0, 120));
    if ((tag === "input" || tag === "textarea") && el.value) bits.push("value=" + JSON.stringify(String(el.value).slice(0, 40)));
    if (tag === "select") bits.push("options: " + Array.from(el.options).slice(0, 12).map((o) => o.value === o.text ? o.text : o.text + " (" + o.value + ")").join(", "));
    if (el.checked) bits.push("checked");
    if (el.disabled) bits.push("disabled");
    out.push("[" + ref + "] " + kind + " " + bits.join(" "));
  }
  return { text: clean(document.body ? document.body.innerText : ""), elements: out };
}`;

export class BrowserSessions {
  private readonly live = new Map<string, Live>();
  private readonly idleMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private readonly hostCache = new Map<string, boolean>();

  constructor(private readonly options: BrowserOptions = {}) {
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get allowPrivate(): boolean {
    return this.options.allowPrivate === true;
  }

  get executablePath(): string | null {
    return this.options.executablePath ?? findBrowser();
  }

  /** The page of this session, opened on first use. */
  async pageFor(sessionId: string): Promise<Page> {
    const found = this.live.get(sessionId);
    if (found && !found.page.isClosed()) {
      found.lastUsed = this.now();
      return found.page;
    }
    const executablePath = this.executablePath;
    if (!executablePath) throw new Error("no browser on this machine: install Google Chrome or Chromium, or set OPIFER_BROWSER to its path");
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-dev-shm-usage", "--disable-gpu"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(30_000);
    if (!this.options.allowPrivate) {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol !== "http:" && url.protocol !== "https:") return route.abort("blockedbyclient");
        if (await this.isBlocked(url.hostname)) return route.abort("blockedbyclient");
        return route.continue();
      });
    }
    const page = await context.newPage();
    const entry: Live = { browser, context, page, lastUsed: this.now(), shots: 0 };
    this.live.set(sessionId, entry);
    if (!this.timer) {
      this.timer = setInterval(() => void this.reap(), 60_000);
      this.timer.unref();
    }
    return page;
  }

  private async isBlocked(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const cached = this.hostCache.get(host);
    if (cached !== undefined) return cached;
    let blocked: boolean;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) blocked = true;
    else if (isIP(host)) blocked = isPrivateAddress(host);
    else {
      const addresses = await lookup(host, { all: true }).catch(() => []);
      blocked = addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address));
    }
    this.hostCache.set(host, blocked);
    return blocked;
  }

  entry(sessionId: string): Live | undefined {
    return this.live.get(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const found = this.live.get(sessionId);
    if (!found) return;
    this.live.delete(sessionId);
    await found.browser.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  /** Closes the browsers nobody used for a while. */
  async reap(): Promise<number> {
    const cutoff = this.now() - this.idleMs;
    const stale = [...this.live.entries()].filter(([, l]) => l.lastUsed < cutoff).map(([id]) => id);
    await Promise.all(stale.map((id) => this.close(id)));
    return stale.length;
  }

  get size(): number {
    return this.live.size;
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const result = (await page.evaluate(`(${SNAPSHOT_SCRIPT})(${MAX_ELEMENTS})`)) as { text: string; elements: string[] };
  return { title: await page.title(), url: page.url(), text: result.text, elements: result.elements };
}

function render(s: Snapshot, args: Record<string, unknown>): string {
  const max = typeof args["max_chars"] === "number" ? args["max_chars"] : DEFAULT_CHARS;
  const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
  const text = s.text.slice(offset, offset + max);
  const more = s.text.length > offset + max ? `\n… ${s.text.length - offset - max} more characters: call browser_read with offset ${offset + max}.` : "";
  const elements = s.elements.length > 0 ? `\n\nYou can act on (use the ref with browser_click, browser_type, browser_select):\n${s.elements.join("\n")}` : "";
  return `# ${s.title || "(untitled)"}\nURL: ${s.url}\n\n${text}${more}${elements}`;
}

function refLocator(page: Page, args: Record<string, unknown>) {
  const ref = str(args, "ref").trim();
  return page.locator(`[data-opifer-ref="${ref.replace(/"/g, "")}"]`).first();
}

/** The six browser tools, sharing the sessions' pages. */
export function browserTools(sessions: BrowserSessions): NativeTool[] {
  const page = (context: ToolContext) => sessions.pageFor(context.sessionId);
  const read = async (p: Page, args: Record<string, unknown>) => ({ content: render(await snapshot(p), args) });

  const open: NativeTool = {
    risk: "low",
    definition: {
      name: "browser_open",
      description:
        "Opens a public URL in a real browser (JavaScript runs) and returns the page as text plus the numbered elements you can act on. Use it when web_fetch is not enough: web apps, forms, sites that need clicks. The page stays open for browser_click, browser_type, browser_read.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", description: "http(s) URL" }, max_chars: { type: "integer", minimum: 500, maximum: 60000 } },
      },
    },
    async execute(args, context) {
      const url = new URL(str(args, "url"));
      if (!sessions.allowPrivate) await assertPublic(url);
      const p = await page(context);
      const response = await p.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await settle(p);
      const s = await snapshot(p);
      return { content: `${render(s, args)}${response && response.status() >= 400 ? `\n\nHTTP ${response.status()}` : ""}` };
    },
  };

  const readTool: NativeTool = {
    risk: "low",
    definition: {
      name: "browser_read",
      description: "Reads the current page again (after a click, a form, or to see more text with offset): text and the elements you can act on.",
      inputSchema: {
        type: "object",
        properties: { max_chars: { type: "integer", minimum: 500, maximum: 60000 }, offset: { type: "integer", minimum: 0 } },
      },
    },
    async execute(args, context) {
      const p = await page(context);
      if (p.url() === "about:blank") return { content: "No page is open: call browser_open first.", isError: true };
      return read(p, args);
    },
  };

  const click: NativeTool = {
    risk: "medium",
    definition: {
      name: "browser_click",
      description: "Clicks an element of the current page by its ref (from browser_open or browser_read), waits for the page to settle and returns it.",
      inputSchema: { type: "object", required: ["ref"], properties: { ref: { type: "string", description: "e.g. e12" } } },
    },
    async execute(args, context) {
      const p = await page(context);
      const target = refLocator(p, args);
      if ((await target.count()) === 0) return { content: `No element ${str(args, "ref")} on this page: read it again.`, isError: true };
      await Promise.all([p.waitForEvent("framenavigated", { timeout: 2_000 }).catch(() => null), target.click()]);
      await settle(p);
      return read(p, args);
    },
  };

  const type: NativeTool = {
    risk: "medium",
    definition: {
      name: "browser_type",
      description: "Types into a field of the current page by its ref, replacing what was there; submit presses Enter afterwards. Returns the page.",
      inputSchema: {
        type: "object",
        required: ["ref", "text"],
        properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean", description: "Press Enter after typing" } },
      },
    },
    async execute(args, context) {
      const p = await page(context);
      const target = refLocator(p, args);
      if ((await target.count()) === 0) return { content: `No element ${str(args, "ref")} on this page: read it again.`, isError: true };
      await target.fill(typeof args["text"] === "string" ? args["text"] : "");
      if (args["submit"] === true) {
        await Promise.all([p.waitForEvent("framenavigated", { timeout: 2_000 }).catch(() => null), target.press("Enter")]);
      }
      await settle(p);
      return read(p, args);
    },
  };

  const select: NativeTool = {
    risk: "medium",
    definition: {
      name: "browser_select",
      description: "Chooses an option of a select element by its ref: the option's value or its visible text.",
      inputSchema: { type: "object", required: ["ref", "option"], properties: { ref: { type: "string" }, option: { type: "string" } } },
    },
    async execute(args, context) {
      const p = await page(context);
      const target = refLocator(p, args);
      if ((await target.count()) === 0) return { content: `No element ${str(args, "ref")} on this page: read it again.`, isError: true };
      const option = str(args, "option");
      await target.selectOption(option);
      await settle(p);
      return read(p, args);
    },
  };

  const screenshot: NativeTool = {
    risk: "low",
    definition: {
      name: "browser_screenshot",
      description: "Saves a PNG screenshot of the current page into the task folder (browser/shot-N.png), so people can see it among the artifacts. Returns the path.",
      inputSchema: { type: "object", properties: { full_page: { type: "boolean", description: "The whole page, not only the viewport" } } },
    },
    async execute(args, context) {
      const p = await page(context);
      const entry = sessions.entry(context.sessionId);
      if (!entry) throw new Error("no browser for this session");
      entry.shots += 1;
      const dir = join(context.workdir, "browser");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `shot-${entry.shots}.png`);
      await writeFile(file, await p.screenshot({ fullPage: args["full_page"] === true, type: "png" }));
      return { content: `Saved browser/shot-${entry.shots}.png (${p.url()}).` };
    },
  };

  return [open, readTool, click, type, select, screenshot];
}
