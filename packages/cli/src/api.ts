/**
 * Small HTTP client for the commands that talk to the running server: the
 * CLI is a view over the same API as the web interface.
 */

import { requireConfig, resolveHome } from "./home.js";
import { isPortOpen } from "./database.js";

export async function serverBase(homeDir?: string): Promise<string> {
  const home = resolveHome(homeDir);
  const config = await requireConfig(home);
  const base = `http://${config.server.host}:${config.server.port}`;
  if (!(await isPortOpen(config.server.port, config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host))) {
    throw new Error(`The server is not running on ${base}: run o4r up first (also with --detach)`);
  }
  return base;
}

export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Company {
  id: string;
  name: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  model: string | null;
}

/** The company named, or the first one. */
export async function resolveCompany(base: string, name?: string): Promise<Company> {
  const companies = await api<Company[]>(base, "/v1/companies");
  const company = name ? companies.find((co) => co.name.toLowerCase() === name.toLowerCase()) : companies[0];
  if (!company) throw new Error(name ? `Company "${name}" not found` : "No company: create the first one with o4r init --company");
  return company;
}

export async function resolveAgent(base: string, companyId: string, name: string): Promise<Agent> {
  const agents = await api<Agent[]>(base, `/v1/companies/${companyId}/agents`);
  const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase() || a.id === name);
  if (!agent) throw new Error(`Agent "${name}" not found. Available: ${agents.map((a) => a.name).join(", ") || "none"}`);
  return agent;
}
