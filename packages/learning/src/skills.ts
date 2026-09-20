/**
 * Skills: reusable procedures in the open agent-skills format (a SKILL.md
 * with a header, optional files). Only the index enters the prompt; the body
 * is loaded on demand. Every change is a version, nothing is ever deleted:
 * the curator archives unused agent-made skills and a person can restore
 * them; pinned skills are left alone.
 */

import type { Sql, TransactionSql } from "postgres";
import { audit } from "@opifer/db";
import {
  LearningError,
  type Actor,
  type Scope,
  type Skill,
  type SkillOrigin,
  type SkillUse,
  type SkillVersion,
  type UsageOutcome,
} from "./types.js";
import { visibleScopes } from "./memory.js";

interface SkillRow {
  id: string;
  company_id: string;
  scope: Scope;
  scope_agent_id: string | null;
  name: string;
  description: string;
  tags: string[];
  origin: SkillOrigin;
  status: Skill["status"];
  pinned: boolean;
  current_version: number;
  uses: number;
  last_used_at: Date | null;
  promoted_from_id: string | null;
  created_by_kind: Actor["kind"];
  created_by_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  skill_id: string;
  version: number;
  description: string;
  content: string;
  files: Record<string, string>;
  note: string;
  created_by_kind: Actor["kind"];
  created_by_id: string | null;
  created_at: Date;
}

interface UseRow {
  id: string;
  skill_id: string;
  version: number;
  agent_id: string;
  session_id: string | null;
  run_id: string | null;
  task_id: string | null;
  outcome: UsageOutcome;
  created_at: Date;
}

const toSkill = (r: SkillRow): Skill => ({
  id: r.id,
  companyId: r.company_id,
  scope: r.scope,
  scopeAgentId: r.scope_agent_id,
  name: r.name,
  description: r.description,
  tags: r.tags,
  origin: r.origin,
  status: r.status,
  pinned: r.pinned,
  currentVersion: r.current_version,
  uses: r.uses,
  lastUsedAt: r.last_used_at,
  promotedFromId: r.promoted_from_id,
  createdByKind: r.created_by_kind,
  createdById: r.created_by_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVersion = (r: VersionRow): SkillVersion => ({
  id: r.id,
  skillId: r.skill_id,
  version: r.version,
  description: r.description,
  content: r.content,
  files: r.files,
  note: r.note,
  createdByKind: r.created_by_kind,
  createdById: r.created_by_id,
  createdAt: r.created_at,
});

const toUse = (r: UseRow): SkillUse => ({
  id: r.id,
  skillId: r.skill_id,
  version: r.version,
  agentId: r.agent_id,
  sessionId: r.session_id,
  runId: r.run_id,
  taskId: r.task_id,
  outcome: r.outcome,
  createdAt: r.created_at,
});

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CreateSkillInput {
  companyId: string;
  scope: Scope;
  scopeAgentId?: string | null;
  name: string;
  description: string;
  content: string;
  files?: Record<string, string>;
  tags?: string[];
  origin: SkillOrigin;
  note?: string;
  pinned?: boolean;
}

/** The SKILL.md text of a version, in the open format: YAML header then body. */
export function renderSkillMarkdown(
  skill: Pick<Skill, "name" | "description" | "tags" | "currentVersion">,
  version: Pick<SkillVersion, "content" | "version">,
): string {
  const header = [
    `---`,
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    `version: ${version.version}`,
    skill.tags.length > 0 ? `tags: [${skill.tags.join(", ")}]` : null,
    `---`,
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${version.content.trim()}\n`;
}

/** Parses a SKILL.md: the header gives name and description, the rest is the body. */
export function parseSkillMarkdown(text: string): {
  name: string | null;
  description: string;
  tags: string[];
  content: string;
} {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!match)
    return { name: null, description: "", tags: [], content: text.trim() };
  const header: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) header[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const unquote = (v: string | undefined) => {
    if (!v) return "";
    try {
      return v.startsWith('"')
        ? (JSON.parse(v) as string)
        : v.replace(/^'(.*)'$/, "$1");
    } catch {
      return v;
    }
  };
  const tags = (header["tags"] ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: header["name"] ? unquote(header["name"]) : null,
    description: unquote(header["description"]),
    tags,
    content: text.slice(match[0].length).trim(),
  };
}

export class SkillService {
  constructor(private readonly sql: Sql) {}

  async create(input: CreateSkillInput, actor: Actor): Promise<Skill> {
    const name = input.name.trim().toLowerCase();
    if (!SKILL_NAME.test(name))
      throw new LearningError(
        "invalid_input",
        "a skill name is lowercase letters, digits and dashes (up to 64 characters)",
      );
    if (!input.content.trim())
      throw new LearningError("invalid_input", "a skill needs a body");
    if (!input.description.trim())
      throw new LearningError(
        "invalid_input",
        "a skill needs a one-line description",
      );
    const scopeAgentId =
      input.scope === "company" ? null : (input.scopeAgentId ?? null);
    if (input.scope !== "company" && !scopeAgentId)
      throw new LearningError(
        "invalid_input",
        `scope ${input.scope} needs an agent`,
      );
    return this.sql.begin(async (tx) => {
      const [existing] = await tx<
        { id: string }[]
      >`SELECT id FROM skills WHERE company_id = ${input.companyId} AND scope = ${input.scope} AND coalesce(scope_agent_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${scopeAgentId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid) AND name = ${name}`;
      if (existing)
        throw new LearningError(
          "conflict",
          `a skill named "${name}" already exists in this scope`,
        );
      const [row] = await tx<SkillRow[]>`
        INSERT INTO skills (company_id, scope, scope_agent_id, name, description, tags, origin, pinned, created_by_kind, created_by_id)
        VALUES (${input.companyId}, ${input.scope}, ${scopeAgentId}, ${name}, ${input.description.trim()}, ${input.tags ?? []}, ${input.origin}, ${input.pinned ?? false}, ${actor.kind}, ${actor.id ?? null})
        RETURNING *
      `;
      await tx`
        INSERT INTO skill_versions (company_id, skill_id, version, description, content, files, note, created_by_kind, created_by_id)
        VALUES (${input.companyId}, ${row!.id}, 1, ${input.description.trim()}, ${input.content.trim()}, ${(input.files ?? {}) as never}::jsonb, ${input.note ?? "created"}, ${actor.kind}, ${actor.id ?? null})
      `;
      await audit(tx, {
        companyId: input.companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "skill.created",
        subjectKind: "skill",
        subjectId: row!.id,
        after: {
          name,
          scope: input.scope,
          origin: input.origin,
          description: input.description.trim(),
        },
      });
      return toSkill(row!);
    });
  }

  async get(companyId: string, id: string): Promise<Skill | null> {
    const [row] = await this.sql<
      SkillRow[]
    >`SELECT * FROM skills WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toSkill(row) : null;
  }

  /** The skill an agent means by a name: its own first, then a team's, then the company's. */
  async resolve(
    companyId: string,
    agentId: string,
    name: string,
    db: Sql | TransactionSql = this.sql,
  ): Promise<Skill | null> {
    const { agentIds } = await visibleScopes(this.sql, companyId, agentId);
    const rows = await db<SkillRow[]>`
      SELECT * FROM skills WHERE company_id = ${companyId} AND name = ${name.trim().toLowerCase()} AND status <> 'archived'
        AND ((scope = 'agent' AND scope_agent_id = ${agentId}) OR (scope = 'team' AND scope_agent_id = ANY(${agentIds})) OR scope = 'company')
    `;
    const order: Record<Scope, number> = { agent: 0, team: 1, company: 2 };
    rows.sort((a, b) => order[a.scope] - order[b.scope]);
    return rows[0] ? toSkill(rows[0]) : null;
  }

  async list(
    companyId: string,
    filter: {
      scope?: Scope;
      scopeAgentId?: string | null;
      status?: Skill["status"][];
      agentView?: string;
    } = {},
  ): Promise<Skill[]> {
    const statuses = filter.status ?? ["active", "inactive"];
    let scopeFilter = this.sql``;
    if (filter.agentView) {
      const { agentIds } = await visibleScopes(
        this.sql,
        companyId,
        filter.agentView,
      );
      scopeFilter = this
        .sql`AND ((scope = 'agent' AND scope_agent_id = ${filter.agentView}) OR (scope = 'team' AND scope_agent_id = ANY(${agentIds})) OR scope = 'company')`;
    } else if (filter.scope) {
      scopeFilter =
        filter.scope === "company"
          ? this.sql`AND scope = 'company'`
          : this
              .sql`AND scope = ${filter.scope} AND scope_agent_id = ${filter.scopeAgentId ?? null}`;
    }
    const rows = await this.sql<
      SkillRow[]
    >`SELECT * FROM skills WHERE company_id = ${companyId} AND status = ANY(${statuses}) ${scopeFilter} ORDER BY scope, name`;
    return rows.map(toSkill);
  }

  /** The index that enters the prompt: name and description of what the agent can load. Closer scopes shadow farther ones. */
  async index(
    companyId: string,
    agentId: string,
  ): Promise<Array<{ name: string; description: string }>> {
    const skills = await this.list(companyId, {
      agentView: agentId,
      status: ["active", "inactive"],
    });
    const order: Record<Scope, number> = { agent: 0, team: 1, company: 2 };
    skills.sort((a, b) => order[a.scope] - order[b.scope]);
    const seen = new Set<string>();
    const out: Array<{ name: string; description: string }> = [];
    for (const s of skills) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, description: s.description });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async version(
    companyId: string,
    skillId: string,
    version?: number,
  ): Promise<SkillVersion | null> {
    const [row] = version
      ? await this.sql<
          VersionRow[]
        >`SELECT * FROM skill_versions WHERE company_id = ${companyId} AND skill_id = ${skillId} AND version = ${version}`
      : await this.sql<
          VersionRow[]
        >`SELECT v.* FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE v.company_id = ${companyId} AND v.skill_id = ${skillId} AND v.version = s.current_version`;
    return row ? toVersion(row) : null;
  }

  async versions(companyId: string, skillId: string): Promise<SkillVersion[]> {
    const rows = await this.sql<
      VersionRow[]
    >`SELECT * FROM skill_versions WHERE company_id = ${companyId} AND skill_id = ${skillId} ORDER BY version DESC`;
    return rows.map(toVersion);
  }

  /** A change is a new version; the skill's description follows it. */
  async update(
    companyId: string,
    skillId: string,
    input: {
      description?: string;
      content: string;
      files?: Record<string, string>;
      note?: string;
      tags?: string[];
    },
    actor: Actor,
  ): Promise<{ skill: Skill; version: SkillVersion }> {
    if (!input.content.trim())
      throw new LearningError("invalid_input", "a skill needs a body");
    return this.sql.begin(async (tx) => {
      const [current] = await tx<
        SkillRow[]
      >`SELECT * FROM skills WHERE id = ${skillId} AND company_id = ${companyId} FOR UPDATE`;
      if (!current) throw new LearningError("not_found", "skill not found");
      const previous = await this.version(
        companyId,
        skillId,
        current.current_version,
      );
      const next = current.current_version + 1;
      const description = (input.description ?? current.description).trim();
      const [v] = await tx<VersionRow[]>`
        INSERT INTO skill_versions (company_id, skill_id, version, description, content, files, note, created_by_kind, created_by_id)
        VALUES (${companyId}, ${skillId}, ${next}, ${description}, ${input.content.trim()}, ${(input.files ?? previous?.files ?? {}) as never}::jsonb, ${input.note ?? ""}, ${actor.kind}, ${actor.id ?? null})
        RETURNING *
      `;
      const [row] = await tx<
        SkillRow[]
      >`UPDATE skills SET current_version = ${next}, description = ${description}, tags = ${input.tags ?? current.tags}, status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END WHERE id = ${skillId} RETURNING *`;
      await audit(tx, {
        companyId,
        actorKind: actor.kind,
        actorId: actor.id ?? null,
        action: "skill.updated",
        subjectKind: "skill",
        subjectId: skillId,
        before: { version: current.current_version },
        after: { version: next, note: input.note ?? "" },
      });
      return { skill: toSkill(row!), version: toVersion(v!) };
    });
  }

  /** Going back is a new version with the old content. */
  async restore(
    companyId: string,
    skillId: string,
    version: number,
    actor: Actor,
  ): Promise<{ skill: Skill; version: SkillVersion }> {
    const old = await this.version(companyId, skillId, version);
    if (!old)
      throw new LearningError("not_found", `version ${version} not found`);
    return this.update(
      companyId,
      skillId,
      {
        description: old.description,
        content: old.content,
        files: old.files,
        note: `restored version ${version}`,
      },
      actor,
    );
  }

  async setStatus(
    companyId: string,
    skillId: string,
    status: Skill["status"],
    actor: Actor,
    reason = "",
  ): Promise<Skill> {
    const [before] = await this.sql<
      SkillRow[]
    >`SELECT * FROM skills WHERE id = ${skillId} AND company_id = ${companyId}`;
    if (!before) throw new LearningError("not_found", "skill not found");
    const [row] = await this.sql<SkillRow[]>`
      UPDATE skills SET status = ${status}, archived_at = ${status === "archived" ? new Date() : null} WHERE id = ${skillId} RETURNING *
    `;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action:
        status === "archived"
          ? "skill.archived"
          : before.status === "archived"
            ? "skill.restored"
            : "skill.status_changed",
      subjectKind: "skill",
      subjectId: skillId,
      before: { status: before.status },
      after: { status, reason },
    });
    return toSkill(row!);
  }

  async pin(
    companyId: string,
    skillId: string,
    pinned: boolean,
    actor: Actor,
  ): Promise<Skill> {
    const [row] = await this.sql<
      SkillRow[]
    >`UPDATE skills SET pinned = ${pinned} WHERE id = ${skillId} AND company_id = ${companyId} RETURNING *`;
    if (!row) throw new LearningError("not_found", "skill not found");
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: pinned ? "skill.pinned" : "skill.unpinned",
      subjectKind: "skill",
      subjectId: skillId,
    });
    return toSkill(row);
  }

  /** An agent loaded the skill: counts as a use, outcome unknown until the task closes. */
  async recordUse(
    companyId: string,
    skillId: string,
    use: {
      agentId: string;
      sessionId?: string | null;
      runId?: string | null;
      taskId?: string | null;
    },
  ): Promise<SkillUse> {
    return this.sql.begin(async (tx) => {
      const [skill] = await tx<
        SkillRow[]
      >`UPDATE skills SET uses = uses + 1, last_used_at = now(), status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END WHERE id = ${skillId} AND company_id = ${companyId} RETURNING *`;
      if (!skill) throw new LearningError("not_found", "skill not found");
      const [row] = await tx<UseRow[]>`
        INSERT INTO skill_usage (company_id, skill_id, version, agent_id, session_id, run_id, task_id)
        VALUES (${companyId}, ${skillId}, ${skill.current_version}, ${use.agentId}, ${use.sessionId ?? null}, ${use.runId ?? null}, ${use.taskId ?? null}) RETURNING *
      `;
      return toUse(row!);
    });
  }

  /** When a task closes, every skill used in it learns how it went. */
  async settleTask(
    companyId: string,
    taskId: string,
    outcome: Exclude<UsageOutcome, "unknown">,
  ): Promise<number> {
    const rows = await this.sql<
      { id: string }[]
    >`UPDATE skill_usage SET outcome = ${outcome} WHERE company_id = ${companyId} AND task_id = ${taskId} AND outcome = 'unknown' RETURNING id`;
    return rows.length;
  }

  async usage(
    companyId: string,
    skillId: string,
  ): Promise<{ uses: SkillUse[]; successes: number; failures: number }> {
    const rows = await this.sql<
      UseRow[]
    >`SELECT * FROM skill_usage WHERE company_id = ${companyId} AND skill_id = ${skillId} ORDER BY created_at DESC LIMIT 200`;
    const uses = rows.map(toUse);
    return {
      uses,
      successes: uses.filter((u) => u.outcome === "success").length,
      failures: uses.filter((u) => u.outcome === "failure").length,
    };
  }

  /**
   * The curator: agent-made, unpinned skills become inactive after
   * `inactiveAfterDays` without use and archived after `archiveAfterDays`.
   * A backup of every skill is saved first. Nothing is deleted.
   */
  async curate(
    companyId: string,
    thresholds: { inactiveAfterDays: number; archiveAfterDays: number },
    now: Date = new Date(),
  ): Promise<{ backupId: string; inactivated: string[]; archived: string[] }> {
    const all = await this.sql<
      SkillRow[]
    >`SELECT * FROM skills WHERE company_id = ${companyId}`;
    const versions = await this.sql<
      VersionRow[]
    >`SELECT * FROM skill_versions WHERE company_id = ${companyId}`;
    const [backup] = await this.sql<{ id: string }[]>`
      INSERT INTO learning_backups (company_id, kind, payload) VALUES (${companyId}, 'curator', ${{ at: now.toISOString(), skills: all.map(toSkill), versions: versions.map(toVersion) } as never}::jsonb) RETURNING id
    `;
    const inactivated: string[] = [];
    const archived: string[] = [];
    for (const s of all) {
      if (s.origin !== "agent" || s.pinned || s.status === "archived") continue;
      const last = s.last_used_at ?? s.created_at;
      const idle = (now.getTime() - last.getTime()) / 86_400_000;
      if (idle >= thresholds.archiveAfterDays) {
        await this.setStatus(
          companyId,
          s.id,
          "archived",
          { kind: "system" },
          `unused for ${Math.floor(idle)} days`,
        );
        archived.push(s.id);
      } else if (
        idle >= thresholds.inactiveAfterDays &&
        s.status === "active"
      ) {
        await this.setStatus(
          companyId,
          s.id,
          "inactive",
          { kind: "system" },
          `unused for ${Math.floor(idle)} days`,
        );
        inactivated.push(s.id);
      }
    }
    await audit(this.sql, {
      companyId,
      actorKind: "system",
      action: "skill.curated",
      subjectKind: "company",
      subjectId: companyId,
      after: { backupId: backup!.id, inactivated, archived },
    });
    return { backupId: backup!.id, inactivated, archived };
  }
}
