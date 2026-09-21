/**
 * `o4r project`: the projects of the company, and a project that is a git
 * repository (cloned into its folder, worked on a branch).
 */

import { api, resolveCompany, serverBase } from "../api.js";
import { c, say } from "../output.js";

interface Common {
  home?: string;
  company?: string;
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  workdir: string | null;
  repoUrl: string | null;
  branch: string | null;
  repoStatus: "none" | "cloned" | "failed";
  repoDetail: string;
}

export async function runProjectList(options: Common): Promise<void> {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  const projects = await api<ProjectRow[]>(base, `/v1/companies/${company.id}/projects`);
  if (projects.length === 0) return say.info(`No projects in ${company.name}: o4r project create "Name" --repo https://github.com/org/repo`);
  for (const p of projects) {
    const repo = p.repoUrl ? `  ${p.repoUrl}${p.branch ? `@${p.branch}` : ""} (${p.repoStatus === "cloned" ? "cloned" : `${p.repoStatus}: ${p.repoDetail}`})` : "";
    say.info(`${c.bold(p.name)}  ${p.status}${repo}  ${c.dim(p.workdir ?? "one folder per task")}  ${c.dim(p.id)}`);
  }
}

export async function runProjectCreate(options: Common & { name: string; description?: string; goal?: string; repo?: string; branch?: string }): Promise<void> {
  const base = await serverBase(options.home);
  const company = await resolveCompany(base, options.company);
  let goalId: string | null = null;
  if (options.goal) {
    const goals = await api<Array<{ id: string; title: string }>>(base, `/v1/companies/${company.id}/goals`);
    const goal = goals.find((g) => g.title.toLowerCase() === options.goal!.toLowerCase() || g.id === options.goal);
    if (!goal) throw new Error(`no goal "${options.goal}" in ${company.name}`);
    goalId = goal.id;
  }
  if (options.repo) say.step(`Cloning ${options.repo}${options.branch ? ` (${options.branch})` : ""}`);
  const project = await api<ProjectRow>(base, `/v1/companies/${company.id}/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: options.name,
      ...(options.description ? { description: options.description } : {}),
      goalId,
      ...(options.repo ? { repoUrl: options.repo } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
    }),
  });
  say.ok(`Project ${c.bold(project.name)} created ${c.dim(project.id)}`);
  if (project.repoUrl) {
    (project.repoStatus === "cloned" ? say.ok : say.warn)(`Repository ${project.repoStatus}: ${project.repoDetail}${project.workdir ? ` in ${project.workdir}` : ""}`);
    if (project.repoStatus !== "cloned") say.info(`Private repository? Store a token first: ${c.cyan("o4r secret set GITHUB_TOKEN")}, then create the project again.`);
    else say.info(`Agents push with a bound token: ${c.cyan("o4r secret set GITHUB_TOKEN")} and ${c.cyan("o4r secret bind GITHUB_TOKEN --agent <name> --tool terminal")}`);
  }
}
