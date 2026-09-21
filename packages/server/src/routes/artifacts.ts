/**
 * Artifacts: everything the agents produce. The products they declare at
 * delivery (files, links, diffs, documents, decisions, notes) across every
 * task, and the files in a task's working folder, readable and downloadable.
 */

import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { WorkService } from "@opifer/work";

export interface ArtifactRoutesOptions {
  work: WorkService;
  workRoot: string;
  bus?: { publish(kind: string, companyId: string, payload: Record<string, unknown>): void } | undefined;
}

const MAX_LIST = 2000;
const MAX_INLINE = 20 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git", ".opifer", "dist", "build", ".cache", "__pycache__", ".venv", "venv", ".next", "target"]);

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

/** The files under a folder, relative paths, skipping dependencies and build output. */
export async function listFiles(root: string, limit = MAX_LIST): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= limit) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null);
        if (info) out.push({ path: path.relative(root, full).split(path.sep).join("/"), size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  };
  await walk(root);
  return out;
}

/** A path inside `root`, or null when it escapes it. */
export function insideOf(root: string, relative: string): string | null {
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (relative.split("/").some((part) => part === "..")) return null;
  return full;
}

export async function registerArtifactRoutes(app: FastifyInstance, options: ArtifactRoutesOptions): Promise<void> {
  const { work } = options;
  const { sql } = app.opifer.db;
  // Uploads arrive as raw bytes, whatever the file: parsed to a buffer, never as JSON.
  app.addContentTypeParser(["application/octet-stream", "image/*", "application/pdf", "application/zip"], { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  const folderOfTask = async (taskId: string): Promise<{ companyId: string; folder: string } | null> => {
    const [row] = await sql<{ company_id: string }[]>`SELECT company_id FROM tasks WHERE id = ${taskId}`;
    if (!row) return null;
    const task = await work.getTask(row.company_id, taskId);
    if (!task) return null;
    const why = await work.whyChain(row.company_id, task);
    return { companyId: row.company_id, folder: why.project?.workdir ?? path.join(options.workRoot, `task-${task.id}`) };
  };

  /** Every product of every task of the company, newest first, with the task it belongs to. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/companies/:id/artifacts", async (request) => {
    const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 200) || 200));
    const rows = await sql<
      {
        id: string;
        task_id: string;
        task_title: string;
        task_status: string;
        run_id: string | null;
        kind: string;
        title: string;
        ref: string;
        summary: string;
        created_by_kind: string;
        created_by_id: string | null;
        created_at: Date;
        agent_name: string | null;
      }[]
    >`
      SELECT p.id, p.task_id, t.title AS task_title, t.status AS task_status, p.run_id, p.kind, p.title, p.ref, p.summary, p.created_by_kind, p.created_by_id, p.created_at,
        a.name AS agent_name
      FROM work_products p
      JOIN tasks t ON t.id = p.task_id
      LEFT JOIN agents a ON a.id = p.created_by_id AND p.created_by_kind = 'agent'
      WHERE p.company_id = ${request.params.id}
      ORDER BY p.created_at DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskTitle: r.task_title,
      taskStatus: r.task_status,
      runId: r.run_id,
      kind: r.kind,
      title: r.title,
      ref: r.ref,
      summary: r.summary,
      by: r.agent_name ?? (r.created_by_kind === "person" ? "a person" : r.created_by_kind),
      createdAt: r.created_at.toISOString(),
    }));
  });

  /** The files in the task's working folder. */
  app.get<{ Params: { id: string } }>("/tasks/:id/files", async (request, reply) => {
    const where = await folderOfTask(request.params.id);
    if (!where) return reply.code(404).send({ error: "task not found" });
    const files = await listFiles(where.folder).catch(() => []);
    return { folder: where.folder, files };
  });

  /** A file given to the task (a brief, a spreadsheet, an image): written into its folder and announced in a comment, so the agent finds it. */
  app.put<{ Params: { id: string; "*": string } }>("/tasks/:id/files/*", { bodyLimit: MAX_UPLOAD }, async (request, reply) => {
    const where = await folderOfTask(request.params.id);
    if (!where) return reply.code(404).send({ error: "task not found" });
    const relative = request.params["*"].replace(/^\/+/, "");
    if (!relative || relative.endsWith("/")) return reply.code(400).send({ error: "a file path is needed" });
    if (relative.split("/").some((part) => SKIP.has(part))) return reply.code(400).send({ error: "that folder is reserved" });
    const full = insideOf(where.folder, relative);
    if (!full) return reply.code(400).send({ error: "path outside the task folder" });
    const body = request.body;
    const bytes = Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body) : null;
    if (!bytes) return reply.code(415).send({ error: "send the file as raw bytes (application/octet-stream)" });
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
    const size = bytes.length;
    const comment = await work.comment(
      where.companyId,
      request.params.id,
      { kind: "person" },
      `Uploaded ${relative} (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} kB`}) to the task folder.`,
    );
    options.bus?.publish("task.commented", where.companyId, { taskId: request.params.id, commentId: comment.id });
    return reply.code(201).send({ path: relative, size, modifiedAt: new Date().toISOString() });
  });

  /** One file of the task's working folder: inline when the browser can show it, a download with ?download=1. */
  app.get<{ Params: { id: string; "*": string }; Querystring: { download?: string } }>("/tasks/:id/files/*", async (request, reply) => {
    const where = await folderOfTask(request.params.id);
    if (!where) return reply.code(404).send({ error: "task not found" });
    const relative = request.params["*"];
    const full = insideOf(where.folder, relative);
    if (!full) return reply.code(400).send({ error: "path outside the task folder" });
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) return reply.code(404).send({ error: "file not found" });
    if (info.size > MAX_INLINE && !request.query.download) return reply.code(413).send({ error: "file too large to show: download it" });
    const type = TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    const name = path.basename(full);
    reply.header("content-type", type);
    reply.header("content-length", String(info.size));
    reply.header("cache-control", "no-store");
    reply.header("content-disposition", `${request.query.download ? "attachment" : "inline"}; filename="${name.replace(/"/g, "")}"`);
    return reply.send(createReadStream(full));
  });
}
