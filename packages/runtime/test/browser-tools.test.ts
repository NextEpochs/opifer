import { createServer } from "node:http";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSessions, browserTools, findBrowser } from "../src/tools/browser.js";
import type { ToolContext } from "../src/tools/types.js";

const executablePath = findBrowser();

/** A small site: a page with a link, a form that greets, a select. */
const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/hello") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><head><title>Hello ${url.searchParams.get("name") ?? ""}</title></head><body><h1>Hello ${url.searchParams.get("name") ?? "stranger"}</h1><p>Colour: ${url.searchParams.get("colour") ?? "none"}</p><a href="/">Home</a></body></html>`,
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><head><title>Front</title></head><body>
    <h1>Welcome</h1><p>${"lorem ".repeat(50)}</p>
    <a href="/hello?name=link">Say hello</a>
    <form action="/hello"><label for="n">Your name</label><input id="n" name="name"><select name="colour"><option value="r">Red</option><option value="b">Blue</option></select><button type="submit">Go</button></form>
    <input type="hidden" name="h" value="1"><script>document.body.insertAdjacentHTML("beforeend", "<p>Rendered by script</p>")</script>
  </body></html>`);
});

let base = "";
let workdir = "";
const sessions = new BrowserSessions({ executablePath: executablePath ?? "", allowPrivate: true, idleMs: 60_000 });
const tools = Object.fromEntries(browserTools(sessions).map((t) => [t.definition.name, t]));
const context = (): ToolContext => ({ sessionId: "s1", companyId: "c", agentId: "a", runId: "r", callId: "k", agentRole: "dev", workdir, signal: new AbortController().signal });

beforeAll(async () => {
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const address = site.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  workdir = await mkdtemp(join(tmpdir(), "opifer-browser-"));
});
afterAll(async () => {
  await sessions.closeAll();
  site.close();
});

describe("browser tools", () => {
  it("offers six tools; reading and screenshots are low risk, acting is medium", () => {
    expect(Object.keys(tools)).toEqual(["browser_open", "browser_read", "browser_click", "browser_type", "browser_select", "browser_screenshot"]);
    expect(tools["browser_open"]!.risk).toBe("low");
    expect(tools["browser_click"]!.risk).toBe("medium");
    expect(tools["browser_type"]!.risk).toBe("medium");
  });

  it("refuses private and non-http addresses before opening anything", async () => {
    const guarded = new BrowserSessions({ executablePath: "/nonexistent" });
    const [open] = browserTools(guarded);
    await expect(open!.execute({ url: "http://127.0.0.1:4700/" }, context())).rejects.toThrow(/private/);
    await expect(open!.execute({ url: "file:///etc/passwd" }, context())).rejects.toThrow(/http/);
  });

  it.skipIf(!executablePath)("opens a page with its script run, lists what can be acted on, types, selects, clicks and screenshots", async () => {
    const opened = await tools["browser_open"]!.execute({ url: `${base}/` }, context());
    expect(opened.content).toContain("# Front");
    expect(opened.content).toContain("Rendered by script");
    expect(opened.content).toMatch(/\[e1\] a "Say hello" → http:\/\/127\.0\.0\.1:\d+\/hello\?name=link/);
    expect(opened.content).toContain('input:text "Your name"');
    expect(opened.content).toContain("select");
    expect(opened.content).not.toContain("input:hidden");
    const refs = Object.fromEntries([...opened.content.matchAll(/\[(e\d+)\] (\S+) "?([^"\n]*)/g)].map((m) => [m[2] + ":" + m[3], m[1]]));
    const nameRef = refs["input:text:Your name"]!;
    const selectRef = Object.entries(refs).find(([k]) => k.startsWith("select"))![1];
    const goRef = refs["button:Go"]!;
    await tools["browser_type"]!.execute({ ref: nameRef, text: "Ada" }, context());
    await tools["browser_select"]!.execute({ ref: selectRef, option: "Blue" }, context());
    const after = await tools["browser_click"]!.execute({ ref: goRef }, context());
    expect(after.content).toContain("# Hello Ada");
    expect(after.content).toContain("Colour: b");
    const shot = await tools["browser_screenshot"]!.execute({}, context());
    expect(shot.content).toContain("browser/shot-1.png");
    expect(await readdir(join(workdir, "browser"))).toEqual(["shot-1.png"]);
    const paged = await tools["browser_read"]!.execute({ max_chars: 500, offset: 0 }, context());
    expect(paged.content).toContain("Hello Ada");
    expect((await tools["browser_click"]!.execute({ ref: "e99" }, context())).isError).toBe(true);
    expect(sessions.size).toBe(1);
  });

  it.skipIf(!executablePath)("submits with Enter and closes idle browsers", async () => {
    const now = { t: Date.now() };
    const idle = new BrowserSessions({ executablePath: executablePath ?? "", allowPrivate: true, idleMs: 1_000, now: () => now.t });
    const t = Object.fromEntries(browserTools(idle).map((x) => [x.definition.name, x]));
    const opened = await t["browser_open"]!.execute({ url: `${base}/` }, context());
    const nameRef = /\[(e\d+)\] input:text "Your name"/.exec(opened.content)![1];
    const after = await t["browser_type"]!.execute({ ref: nameRef, text: "Enter", submit: true }, context());
    expect(after.content).toContain("# Hello Enter");
    expect(await idle.reap()).toBe(0);
    now.t += 5_000;
    expect(await idle.reap()).toBe(1);
    expect(idle.size).toBe(0);
    await idle.closeAll();
  });
});
