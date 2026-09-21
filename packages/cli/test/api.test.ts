import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/api.js";

/** Fastify refuses an empty body declared as JSON, so the client must not declare one it does not send. */
describe("cli api client", () => {
  const seen: Array<{ method: string; contentType: string | undefined; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", contentType: req.headers["content-type"], body });
      if (req.headers["content-type"] === "application/json" && body === "") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request", message: "Body cannot be empty when content-type is set to 'application/json'" }));
        return;
      }
      res.writeHead(req.method === "DELETE" ? 204 : 200, { "content-type": "application/json" });
      res.end(req.method === "DELETE" ? undefined : JSON.stringify({ ok: true }));
    });
  });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(() => server.close());

  it("declares JSON only when it sends a body, and accepts 204", async () => {
    expect(await api(base, "/check", { method: "POST" })).toEqual({ ok: true });
    expect(await api(base, "/x", { method: "DELETE" })).toBeUndefined();
    expect(await api(base, "/y", { method: "PATCH", body: JSON.stringify({ enabled: false }) })).toEqual({ ok: true });
    expect(seen.map((s) => s.contentType)).toEqual([undefined, undefined, "application/json"]);
  });
});
