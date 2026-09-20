/** Testi dell'interfaccia: italiano e inglese dal primo giorno. */

export type Locale = "it" | "en";

export interface Strings {
  tagline: string; dashboard: string; companies: string; status: string; server: string; database: string;
  version: string; mode: string; ok: string; degraded: string; unreachable: string; live: string; offline: string;
  newCompany: string; companyName: string; mission: string; create: string; noCompanies: string; agents: string;
  noAgents: string; newAgent: string; agentName: string; agentRole: string; reportsTo: string; nobody: string;
  audit: string; milestone: string; modes: Record<string, string>;
}

const strings: Record<Locale, Strings> = {
  it: {
    tagline: "Agenti AI che lavorano, imparano e vengono governati come un'organizzazione",
    dashboard: "Cruscotto",
    companies: "Aziende",
    status: "Stato del sistema",
    server: "Server",
    database: "Database",
    version: "Versione",
    mode: "Modalità",
    ok: "in ordine",
    degraded: "degradato",
    unreachable: "non raggiungibile",
    live: "eventi in tempo reale",
    offline: "eventi non collegati",
    newCompany: "Nuova azienda",
    companyName: "Nome dell'azienda",
    mission: "Missione (facoltativa)",
    create: "Crea",
    noCompanies: "Nessuna azienda: creane una per iniziare.",
    agents: "Agenti",
    noAgents: "Nessun agente in organigramma.",
    newAgent: "Nuovo agente",
    agentName: "Nome dell'agente",
    agentRole: "Ruolo",
    reportsTo: "Risponde a",
    nobody: "nessuno (radice)",
    audit: "Audit",
    milestone: "Milestone M0 — fondamenta",
    modes: { locale: "locale fidata", autenticata: "autenticata", gestita: "gestita" },
  },
  en: {
    tagline: "AI agents that work, learn and are governed like an organisation",
    dashboard: "Dashboard",
    companies: "Companies",
    status: "System status",
    server: "Server",
    database: "Database",
    version: "Version",
    mode: "Mode",
    ok: "healthy",
    degraded: "degraded",
    unreachable: "unreachable",
    live: "live events",
    offline: "events disconnected",
    newCompany: "New company",
    companyName: "Company name",
    mission: "Mission (optional)",
    create: "Create",
    noCompanies: "No companies yet: create one to get started.",
    agents: "Agents",
    noAgents: "No agents in the org chart.",
    newAgent: "New agent",
    agentName: "Agent name",
    agentRole: "Role",
    reportsTo: "Reports to",
    nobody: "nobody (root)",
    audit: "Audit",
    milestone: "Milestone M0 — foundations",
    modes: { locale: "trusted local", autenticata: "authenticated", gestita: "managed" },
  },
};

export function stringsFor(locale: Locale): Strings {
  return strings[locale];
}

export function detectLocale(): Locale {
  const saved = safeGet("opifer.locale");
  if (saved === "it" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("it") ? "it" : "en";
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem("opifer.locale", locale);
  } catch {
    // preferenza non salvata: nessun problema
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
