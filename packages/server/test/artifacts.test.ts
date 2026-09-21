import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { insideOf, listFiles } from "../src/routes/artifacts.js";

describe("Artifacts: products across tasks and the files of a task", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let dir: string;
  let taskId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "opifer-artifacts-"));
    app = await buildApp({ db, mode: "local", workRoot: path.join(dir, "work"), connections: { start: false, sandbox: "local" }, work: { scheduler: false } });
    await app.ready();
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Proclive" } })).json() as { id: string }).id;
    taskId = ((await app.inject({ method: "POST", url: `/v1/companies/${companyId}/tasks`, payload: { title: "Write the report" } })).json() as { id: string }).id;
    const folder = path.join(dir, "work", `task-${taskId}`);
    await mkdir(path.join(folder, "reports"), { recursive: true });
    await mkdir(path.join(folder, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(folder, "reports", "jev.md"), "# Jev\n\nA report.\n");
    await writeFile(path.join(folder, "node_modules", "x", "index.js"), "skip me");
    await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/products`,
      payload: { kind: "file", title: "Technical report", ref: "reports/jev.md", summary: "The evaluation" },
    });
    await app.inject({ method: "POST", url: `/v1/tasks/${taskId}/products`, payload: { kind: "link", title: "Sources", ref: "https://example.com" } });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("lists every product of the company with its task, newest first", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/companies/${companyId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ kind: string; title: string; taskTitle: string; ref: string; by: string }>;
    expect(items.map((i) => i.kind)).toEqual(["link", "file"]);
    expect(items[1]).toMatchObject({ title: "Technical report", taskTitle: "Write the report", ref: "reports/jev.md", by: "a person" });
  });

  it("lists the files of the task folder, skipping dependencies, and serves one inline or as a download", async () => {
    const listing = (await app.inject({ method: "GET", url: `/v1/tasks/${taskId}/files` })).json() as { files: Array<{ path: string; size: number }> };
    expect(listing.files.map((f) => f.path)).toEqual(["reports/jev.md"]);
    const inline = await app.inject({ method: "GET", url: `/v1/tasks/${taskId}/files/reports/jev.md` });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toContain("text/markdown");
    expect(inline.headers["content-disposition"]).toContain("inline");
    expect(inline.body).toContain("# Jev");
    const download = await app.inject({ method: "GET", url: `/v1/tasks/${taskId}/files/reports/jev.md?download=1` });
    expect(download.headers["content-disposition"]).toContain('attachment; filename="jev.md"');
    expect((await app.inject({ method: "GET", url: `/v1/tasks/${taskId}/files/reports/missing.md` })).statusCode).toBe(404);
  });

  it("never serves a path outside the task folder", async () => {
    expect(insideOf("/srv/work/task-1", "../secrets")).toBeNull();
    expect(insideOf("/srv/work/task-1", "reports/../../other")).toBeNull();
    expect(insideOf("/srv/work/task-1", "reports/jev.md")).toBe("/srv/work/task-1/reports/jev.md");
    const res = await app.inject({ method: "GET", url: `/v1/tasks/${taskId}/files/..%2F..%2Fetc%2Fpasswd` });
    expect([400, 404]).toContain(res.statusCode);
    expect(await listFiles(path.join(dir, "nowhere"))).toEqual([]);
  });
});
