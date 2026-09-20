/**
 * Memory and skills from the terminal: what an agent remembers, what it
 * can do, and the promotions a person decides. Skills come and go in the
 * open agent-skills folder format (a SKILL.md with optional files).
 */

import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { api, resolveAgent, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface Memory {
  id: string;
  scope: string;
  kind: string;
  subject: string;
  content: string;
  status: string;
  pinned: boolean;
  createdAt: string;
  score?: number;
}

interface Skill {
  id: string;
  scope: string;
  scopeAgentId: string | null;
  name: string;
  description: string;
  origin: string;
  status: string;
  pinned: boolean;
  currentVersion: number;
  uses: number;
  lastUsedAt: string | null;
}

async function connect(options: Common) {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const agents = await api<Array<{ id: string; name: string }>>(
    base,
    `/v1/companies/${company.id}/agents`,
  );
  const nameOf = (id: string | null) =>
    agents.find((a) => a.id === id)?.name ?? (id ? "?" : "—");
  return { base, company, agents, nameOf };
}

const scopeLabel = (
  s: Skill | Memory,
  nameOf: (id: string | null) => string,
) =>
  s.scope === "company"
    ? "company"
    : s.scope === "team"
      ? `team of ${nameOf((s as Skill).scopeAgentId ?? null)}`
      : nameOf((s as Skill).scopeAgentId ?? null);

// --- Memory ------------------------------------------------------------------

export async function runMemoryList(
  options: Common & { agent?: string; query?: string; all?: boolean },
): Promise<void> {
  const { base, company } = await connect(options);
  const params = new URLSearchParams();
  if (options.agent)
    params.set(
      "agent",
      (await resolveAgent(base, company.id, options.agent)).id,
    );
  if (options.query) params.set("q", options.query);
  if (options.all) params.set("status", "active,retired,superseded");
  if (options.query && !options.agent)
    throw new Error(
      "search needs --agent: memory is read from an agent's point of view",
    );
  const list = await api<Memory[]>(
    base,
    `/v1/companies/${company.id}/memories?${params}`,
  );
  if (list.length === 0) {
    say.info(
      options.query
        ? "Nothing in memory matches."
        : `No memories yet. Agents learn from their work; add one with ${c.cyan('o4r memory add "..." --agent Philip')}`,
    );
    return;
  }
  for (const m of list) {
    const flags = [
      m.pinned ? c.yellow("pinned") : null,
      m.status !== "active" ? c.dim(m.status) : null,
      m.scope !== "agent" ? c.cyan(m.scope) : null,
    ]
      .filter(Boolean)
      .join(" ");
    say.info(
      `${c.dim(m.id.slice(0, 8))} ${m.kind === "profile" && m.subject ? c.bold(`${m.subject}: `) : ""}${m.content} ${flags}`,
    );
  }
}

export async function runMemoryAdd(
  options: Common & {
    content: string;
    agent?: string;
    scope?: string;
    subject?: string;
    pin?: boolean;
  },
): Promise<void> {
  const { base, company } = await connect(options);
  const scope = options.scope ?? (options.agent ? "agent" : "company");
  const scopeAgentId =
    scope === "company"
      ? null
      : (await resolveAgent(base, company.id, options.agent ?? "")).id;
  const memory = await api<Memory>(
    base,
    `/v1/companies/${company.id}/memories`,
    {
      method: "POST",
      body: JSON.stringify({
        scope,
        scopeAgentId,
        content: options.content,
        kind: options.subject ? "profile" : "note",
        subject: options.subject ?? "",
        pinned: options.pin ?? false,
      }),
    },
  );
  say.ok(
    `Saved to ${scope} memory (${memory.id.slice(0, 8)}). It enters the prompt from the next session.`,
  );
}

export async function runMemoryAction(
  options: Common & {
    action: "retire" | "correct" | "pin" | "unpin" | "promote";
    id: string;
    text?: string;
  },
): Promise<void> {
  const { base, company } = await connect(options);
  const all = await api<Memory[]>(
    base,
    `/v1/companies/${company.id}/memories?status=active,retired,superseded&limit=1000`,
  );
  const memory = all.find(
    (m) => m.id === options.id || m.id.startsWith(options.id),
  );
  if (!memory) throw new Error(`memory ${options.id} not found`);
  const url = `/v1/companies/${company.id}/memories/${memory.id}`;
  if (options.action === "retire") {
    if (!options.text)
      throw new Error('say why: o4r memory retire <id> "reason"');
    await api(base, `${url}/retire`, {
      method: "POST",
      body: JSON.stringify({ reason: options.text }),
    });
    say.ok("Retired. It stays in the record with the reason.");
  } else if (options.action === "correct") {
    if (!options.text) throw new Error("give the corrected text");
    const next = await api<Memory>(base, `${url}/correct`, {
      method: "POST",
      body: JSON.stringify({ content: options.text }),
    });
    say.ok(
      `Corrected: ${next.id.slice(0, 8)} supersedes ${memory.id.slice(0, 8)}.`,
    );
  } else if (options.action === "promote") {
    const promotion = await api<{ status: string }>(base, `${url}/promote`, {
      method: "POST",
      body: JSON.stringify({ toScope: "company" }),
    });
    say.ok(
      promotion.status === "applied"
        ? "Shared with the whole company."
        : "Proposed: a person decides it in the inbox.",
    );
  } else {
    await api(base, `${url}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned: options.action === "pin" }),
    });
    say.ok(
      options.action === "pin"
        ? "Pinned: it stays first in the snapshot."
        : "Unpinned.",
    );
  }
}

// --- Skills ------------------------------------------------------------------

export async function runSkillList(
  options: Common & { agent?: string; all?: boolean },
): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const params = new URLSearchParams();
  if (options.agent)
    params.set(
      "agent",
      (await resolveAgent(base, company.id, options.agent)).id,
    );
  if (!options.all) params.set("status", "active,inactive");
  const skills = await api<Skill[]>(
    base,
    `/v1/companies/${company.id}/skills?${params}`,
  );
  if (skills.length === 0) {
    say.info(
      `No skills yet. Agents learn them from their work; install one with ${c.cyan("o4r skill install ./my-skill")}`,
    );
    return;
  }
  for (const s of skills) {
    const flags = [
      s.pinned ? c.yellow("pinned") : null,
      s.status !== "active" ? c.dim(s.status) : null,
      s.origin !== "agent" ? c.dim(s.origin) : null,
    ]
      .filter(Boolean)
      .join(" ");
    say.info(
      `${c.bold(s.name.padEnd(28))} ${s.description}  ${c.dim(`${scopeLabel(s, nameOf)} · v${s.currentVersion} · ${s.uses} uses`)} ${flags}`,
    );
  }
}

async function findSkill(
  base: string,
  companyId: string,
  name: string,
  agent?: string,
): Promise<Skill> {
  const params = new URLSearchParams({ status: "active,inactive,archived" });
  if (agent)
    params.set("agent", (await resolveAgent(base, companyId, agent)).id);
  const skills = await api<Skill[]>(
    base,
    `/v1/companies/${companyId}/skills?${params}`,
  );
  const matches = skills.filter(
    (s) => s.name === name || s.id === name || s.id.startsWith(name),
  );
  if (matches.length === 0) throw new Error(`skill "${name}" not found`);
  if (matches.length > 1 && !agent)
    throw new Error(
      `"${name}" exists in more than one scope: add --agent, or use the id (${matches.map((m) => `${m.scope}:${m.id.slice(0, 8)}`).join(", ")})`,
    );
  const order: Record<string, number> = { agent: 0, team: 1, company: 2 };
  return matches.sort(
    (a, b) => (order[a.scope] ?? 9) - (order[b.scope] ?? 9),
  )[0]!;
}

export async function runSkillShow(
  options: Common & { name: string; agent?: string; version?: string },
): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const skill = await findSkill(base, company.id, options.name, options.agent);
  const detail = await api<
    Skill & {
      version: { version: number; content: string; note: string };
      versions: Array<{
        version: number;
        note: string;
        createdAt: string;
        createdByKind: string;
      }>;
      usage: { successes: number; failures: number };
    }
  >(base, `/v1/companies/${company.id}/skills/${skill.id}`);
  const version = options.version
    ? await api<{ version: number; content: string }>(
        base,
        `/v1/companies/${company.id}/skills/${skill.id}/versions/${options.version}`,
      )
    : detail.version;
  say.info(`${c.bold(skill.name)} — ${skill.description}`);
  say.info(
    c.dim(
      `${scopeLabel(skill, nameOf)} · ${skill.origin} · ${skill.status}${skill.pinned ? " · pinned" : ""} · v${skill.currentVersion} · ${skill.uses} uses (${detail.usage.successes} ok, ${detail.usage.failures} failed)`,
    ),
  );
  say.info("");
  say.info(version.content);
  say.info("");
  say.info(
    c.dim(
      "Versions: " +
        detail.versions
          .map(
            (v) =>
              `v${v.version} (${v.createdByKind}${v.note ? `, ${v.note}` : ""})`,
          )
          .join(" · "),
    ),
  );
}

/** Reads a skill folder in the open format: SKILL.md plus scripts/, references/, templates/. */
async function readSkillFolder(
  dir: string,
): Promise<{ markdown: string; files: Record<string, string> }> {
  const md = path.join(dir, "SKILL.md");
  const markdown = await readFile(md, "utf8");
  const files: Record<string, string> = {};
  for (const sub of ["scripts", "references", "templates"]) {
    const subdir = path.join(dir, sub);
    try {
      if (!(await stat(subdir)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of await readdir(subdir)) {
      const full = path.join(subdir, entry);
      if ((await stat(full)).isFile())
        files[`${sub}/${entry}`] = await readFile(full, "utf8");
    }
  }
  return { markdown, files };
}

export async function runSkillInstall(
  options: Common & { dir: string; agent?: string; name?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const { markdown, files } = await readSkillFolder(path.resolve(options.dir));
  const scope = options.agent ? "agent" : "company";
  const scopeAgentId = options.agent
    ? (await resolveAgent(base, company.id, options.agent)).id
    : null;
  const skill = await api<Skill>(
    base,
    `/v1/companies/${company.id}/skills/import`,
    {
      method: "POST",
      body: JSON.stringify({
        scope,
        scopeAgentId,
        markdown,
        files,
        ...(options.name ? { name: options.name } : {}),
      }),
    },
  );
  say.ok(
    `Installed "${skill.name}" at ${scope} scope (${Object.keys(files).length} files). Agents see it from their next session.`,
  );
}

export async function runSkillExport(
  options: Common & { name: string; dir: string; agent?: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const skill = await findSkill(base, company.id, options.name, options.agent);
  const exported = await api<{
    name: string;
    markdown: string;
    files: Record<string, string>;
  }>(base, `/v1/companies/${company.id}/skills/${skill.id}/export`);
  const dir = path.resolve(options.dir, exported.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), exported.markdown);
  for (const [rel, content] of Object.entries(exported.files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  say.ok(`Exported to ${dir}`);
}

export async function runSkillAction(
  options: Common & {
    action: "restore" | "archive" | "unarchive" | "pin" | "unpin" | "promote";
    name: string;
    agent?: string;
    version?: string;
  },
): Promise<void> {
  const { base, company } = await connect(options);
  const skill = await findSkill(base, company.id, options.name, options.agent);
  const url = `/v1/companies/${company.id}/skills/${skill.id}`;
  switch (options.action) {
    case "restore": {
      if (!options.version)
        throw new Error("which version? o4r skill restore <name> <version>");
      const r = await api<{ version: { version: number } }>(
        base,
        `${url}/versions/${options.version}/restore`,
        { method: "POST" },
      );
      say.ok(`Restored version ${options.version} as v${r.version.version}.`);
      break;
    }
    case "archive":
      await api(base, `${url}/status`, {
        method: "POST",
        body: JSON.stringify({
          status: "archived",
          reason: "archived by a person",
        }),
      });
      say.ok(
        "Archived. Nothing is deleted: o4r skill unarchive brings it back.",
      );
      break;
    case "unarchive":
      await api(base, `${url}/status`, {
        method: "POST",
        body: JSON.stringify({ status: "active" }),
      });
      say.ok("Back in service.");
      break;
    case "pin":
    case "unpin":
      await api(base, `${url}/pin`, {
        method: "POST",
        body: JSON.stringify({ pinned: options.action === "pin" }),
      });
      say.ok(
        options.action === "pin"
          ? "Pinned: the curator and the agents leave it alone."
          : "Unpinned.",
      );
      break;
    case "promote": {
      const p = await api<{ status: string }>(base, `${url}/promote`, {
        method: "POST",
        body: JSON.stringify({ toScope: "company" }),
      });
      say.ok(
        p.status === "applied"
          ? "Shared with the whole company."
          : "Proposed: a person decides it in the inbox (o4r approvals).",
      );
      break;
    }
  }
}

// --- Learning settings and reviews ------------------------------------------

export async function runLearningShow(options: Common): Promise<void> {
  const { base, company, nameOf } = await connect(options);
  const s = await api<{
    reviewEnabled: boolean;
    promotion: string;
    promotionThreshold: number;
    snapshotMaxChars: number;
    inactiveAfterDays: number;
    archiveAfterDays: number;
    semanticSearch: boolean;
  }>(base, `/v1/companies/${company.id}/learning`);
  say.info(
    `${c.bold("Background review")}: ${s.reviewEnabled ? c.green("on") : c.yellow("off")}   ${c.bold("Promotion")}: ${s.promotion} (after ${s.promotionThreshold} successful uses)`,
  );
  say.info(
    `${c.bold("Snapshot")}: up to ${s.snapshotMaxChars} characters   ${c.bold("Curator")}: inactive after ${s.inactiveAfterDays} days, archived after ${s.archiveAfterDays}   ${c.bold("Search")}: ${s.semanticSearch ? "full-text + semantic" : "full-text (no embedding model configured)"}`,
  );
  const reviews = await api<
    Array<{
      status: string;
      agentId: string;
      createdAt: string;
      applied: { memoryIds?: string[]; skill?: { name: string } | null };
      error: string | null;
    }>
  >(base, `/v1/companies/${company.id}/learning/reviews?limit=10`);
  if (reviews.length > 0) {
    say.info("");
    say.info(c.bold("Last reviews"));
    for (const r of reviews) {
      const learned =
        r.status === "done"
          ? `${r.applied.memoryIds?.length ?? 0} memories${r.applied.skill ? `, skill ${r.applied.skill.name}` : ""}`
          : (r.error ?? "");
      say.info(
        `${c.dim(r.createdAt.slice(0, 16).replace("T", " "))} ${nameOf(r.agentId).padEnd(10)} ${r.status.padEnd(8)} ${c.dim(learned)}`,
      );
    }
  }
}

export async function runLearningSet(
  options: Common & { key: string; value: string },
): Promise<void> {
  const { base, company } = await connect(options);
  const keys: Record<string, (v: string) => unknown> = {
    review: (v) => ({ reviewEnabled: v === "on" || v === "true" }),
    promotion: (v) => ({ promotion: v }),
    threshold: (v) => ({ promotionThreshold: Number(v) }),
    snapshot: (v) => ({ snapshotMaxChars: Number(v) }),
    inactive: (v) => ({ inactiveAfterDays: Number(v) }),
    archive: (v) => ({ archiveAfterDays: Number(v) }),
  };
  const make = keys[options.key];
  if (!make)
    throw new Error(
      `unknown setting "${options.key}": use ${Object.keys(keys).join(", ")}`,
    );
  await api(base, `/v1/companies/${company.id}/learning`, {
    method: "PUT",
    body: JSON.stringify(make(options.value)),
  });
  say.ok(`${options.key} = ${options.value}`);
}
