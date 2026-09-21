import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

const run = promisify(execFile);

describe("Projects with a repository", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let dir: string;
  let origin: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), "opifer-projects-"));
    app = await buildApp({ db, mode: "local", workRoot: path.join(dir, "work"), connections: { start: false, sandbox: "local" }, work: { scheduler: false } });
    await app.ready();
    companyId = ((await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Proclive" } })).json() as { id: string }).id;
    // A small repository to clone from, on this machine.
    const source = path.join(dir, "source");
    await run("git", ["init", "-q", "-b", "main", source]);
    await writeFile(path.join(source, "README.md"), "# Hello\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    await run("git", ["-C", source, "add", "."], { env });
    await run("git", ["-C", source, "commit", "-q", "-m", "first"], { env });
    await run("git", ["-C", source, "checkout", "-q", "-b", "work"], { env });
    origin = source;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("clones the repository into the project's folder, on the requested branch, with the credential helper in place", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/projects`, payload: { name: "Site", repoUrl: `file://${origin}`, branch: "main" } });
    expect(res.statusCode, res.body).toBe(201);
    const project = res.json() as { id: string; workdir: string; repoStatus: string; repoDetail: string; repoUrl: string; branch: string };
    expect(project.repoStatus, project.repoDetail).toBe("cloned");
    expect(project.repoDetail).toContain("main");
    expect(project.workdir).toBe(path.join(dir, "work", `project-${project.id}`));
    expect(existsSync(path.join(project.workdir, "README.md"))).toBe(true);
    expect(existsSync(path.join(project.workdir, ".opifer", "askpass"))).toBe(true);
    const listed = (await app.inject({ method: "GET", url: `/v1/companies/${companyId}/projects` })).json() as Array<{ id: string; repoUrl: string | null }>;
    expect(listed.find((p) => p.id === project.id)?.repoUrl).toBe(`file://${origin}`);
  });

  it("records a failed clone on the project instead of failing the creation", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/projects`, payload: { name: "Broken", repoUrl: `file://${dir}/nowhere` } });
    expect(res.statusCode).toBe(201);
    const project = res.json() as { repoStatus: string; repoDetail: string };
    expect(project.repoStatus).toBe("failed");
    expect(project.repoDetail.length).toBeGreaterThan(0);
  });

  it("refuses a repository URL that is not a git URL", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/companies/${companyId}/projects`, payload: { name: "Odd", repoUrl: "ftp://example.com/x" } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { repoStatus: string; repoDetail: string }).repoDetail).toContain("must start with");
  });
});
