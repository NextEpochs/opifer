/**
 * `o4r artifacts`: what the agents produced, across every task; and the files
 * of one task's folder, listed or printed.
 */

import { api, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface Artifact {
  id: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  kind: string;
  title: string;
  ref: string;
  summary: string;
  by: string;
  createdAt: string;
}

export async function runArtifactList(options: Common & { limit?: string }): Promise<void> {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const items = await api<Artifact[]>(base, `/v1/companies/${company.id}/artifacts?limit=${options.limit ?? 100}`);
  if (items.length === 0) return say.info(`Nothing produced yet in ${company.name}. Agents declare what they made when they deliver a task.`);
  for (const a of items) {
    say.info(`${c.bold(a.title)}  ${a.kind}  ${c.dim(a.by)}  ${c.dim(a.createdAt.slice(0, 16).replace("T", " "))}`);
    say.info(
      `  task: ${a.taskTitle} (${a.taskStatus}) ${c.dim(a.taskId)}${a.ref ? `\n  ${a.kind === "file" ? "file" : "ref"}: ${a.ref}` : ""}${a.summary ? `\n  ${a.summary.slice(0, 200)}` : ""}`,
    );
    if (a.kind === "file") say.info(c.dim(`  read it: o4r task files ${a.taskId} ${a.ref}`));
  }
}

export async function runTaskFiles(options: Common & { id: string; path?: string }): Promise<void> {
  const base = await serverBase(options.home);
  if (!options.path) {
    const listing = await api<{ folder: string; files: Array<{ path: string; size: number; modifiedAt: string }> }>(base, `/v1/tasks/${options.id}/files`);
    say.info(`${c.bold(listing.folder)}${listing.files.length === 0 ? "  (empty)" : ""}`);
    for (const f of listing.files) say.info(`  ${f.path}  ${c.dim(`${f.size} bytes · ${f.modifiedAt.slice(0, 16).replace("T", " ")}`)}`);
    return;
  }
  const res = await fetch(`${base}/v1/tasks/${options.id}/files/${options.path.split("/").map(encodeURIComponent).join("/")}`, { headers: await authHeaders(options.home) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  process.stdout.write(await res.text());
  if (!process.stdout.isTTY) return;
  process.stdout.write("\n");
}

async function authHeaders(home?: string): Promise<Record<string, string>> {
  const { readCliKey } = await import("./auth.js");
  const { resolveHome } = await import("../home.js");
  const key = await readCliKey(resolveHome(home));
  return key ? { authorization: `Bearer ${key}` } : {};
}
