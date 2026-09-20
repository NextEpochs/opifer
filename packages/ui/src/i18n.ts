/** Interface strings: English (default) and Italian from day one. */

export type Locale = "en" | "it";

export interface Strings {
  tagline: string; dashboard: string; companies: string; status: string; server: string; database: string;
  version: string; mode: string; ok: string; degraded: string; unreachable: string; live: string; offline: string;
  newCompany: string; companyName: string; mission: string; create: string; noCompanies: string; agents: string;
  noAgents: string; newAgent: string; agentName: string; agentRole: string; reportsTo: string; nobody: string;
  audit: string; milestone: string; modes: Record<string, string>;
  chat: string; newSession: string; noSessions: string; untitled: string; pickSession: string; working: string;
  message: string; messageHint: string; injectHint: string; send: string; stop: string; you: string; toolResults: string;
  turnFailed: string;
  governance: string; inbox: string; nothingToDecide: string; approve: string; deny: string; decisionNote: string;
  costs: string; thisMonth: string; noCosts: string; byAgent: string; byModel: string; calls: string; budgets: string;
  noBudgets: string; newBudget: string; wholeCompany: string; cap: string; remove: string; permissions: string;
  pickAgent: string; tool: string; risk: string; permission: string; from: string; approvalPending: string;
  budgetExhausted: string; agentStatus: string; resume: string; pause: string;
  permissionNames: Record<string, string>; kinds: Record<string, string>; sources: Record<string, string>;
}

const strings: Record<Locale, Strings> = {
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
    milestone: "Milestone M2 — governance",
    modes: { local: "trusted local", authenticated: "authenticated", managed: "managed" },
    chat: "Chat",
    newSession: "New conversation",
    noSessions: "No conversations yet.",
    untitled: "(untitled)",
    pickSession: "Pick a conversation or start a new one.",
    working: "the agent is working…",
    message: "Message",
    messageHint: "Write to the agent…",
    injectHint: "Turn in progress: your message reaches the agent in the next tool result",
    send: "Send",
    stop: "Stop",
    you: "You",
    toolResults: "Tool results",
    turnFailed: "The turn failed",
    governance: "Governance",
    inbox: "Inbox — decisions waiting for you",
    nothingToDecide: "Nothing to decide.",
    approve: "Approve",
    deny: "Deny",
    decisionNote: "Note (optional, the agent reads it when denied)",
    costs: "Costs",
    thisMonth: "this month",
    noCosts: "No paid calls yet.",
    byAgent: "By agent",
    byModel: "By model",
    calls: "calls",
    budgets: "Budgets",
    noBudgets: "No cap: agents spend freely.",
    newBudget: "New monthly cap",
    wholeCompany: "whole company",
    cap: "Cap (EUR)",
    remove: "Remove",
    permissions: "Tool permissions",
    pickAgent: "Pick an agent",
    tool: "Tool",
    risk: "Risk",
    permission: "Permission",
    from: "from",
    approvalPending: "Waiting for your approval: see the Governance page.",
    budgetExhausted: "Budget reached: the agent is stopped until you approve an increase in Governance.",
    agentStatus: "Status",
    resume: "Resume",
    pause: "Pause",
    permissionNames: { automatic: "automatic", approval: "with approval", blocked: "blocked" },
    kinds: { tool_use: "Tool use", dangerous_command: "Dangerous command", budget_increase: "Budget increase" },
    sources: { agent: "agent policy", role: "role policy", company: "company policy", risk: "tool risk" },
  },
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
    milestone: "Milestone M2 — governance",
    modes: { local: "locale fidata", authenticated: "autenticata", managed: "gestita" },
    chat: "Chat",
    newSession: "Nuova conversazione",
    noSessions: "Nessuna conversazione.",
    untitled: "(senza titolo)",
    pickSession: "Scegli una conversazione o avviane una nuova.",
    working: "l'agente sta lavorando…",
    message: "Messaggio",
    messageHint: "Scrivi all'agente…",
    injectHint: "Turno in corso: il messaggio arriva all'agente nel prossimo risultato di tool",
    send: "Invia",
    stop: "Ferma",
    you: "Tu",
    toolResults: "Risultati dei tool",
    turnFailed: "Il turno è fallito",
    governance: "Governo",
    inbox: "Inbox — decisioni in attesa",
    nothingToDecide: "Niente da decidere.",
    approve: "Approva",
    deny: "Nega",
    decisionNote: "Nota (facoltativa, l'agente la legge se neghi)",
    costs: "Costi",
    thisMonth: "questo mese",
    noCosts: "Nessuna chiamata a pagamento.",
    byAgent: "Per agente",
    byModel: "Per modello",
    calls: "chiamate",
    budgets: "Budget",
    noBudgets: "Nessun tetto: gli agenti spendono liberamente.",
    newBudget: "Nuovo tetto mensile",
    wholeCompany: "tutta l'azienda",
    cap: "Tetto (EUR)",
    remove: "Rimuovi",
    permissions: "Permessi dei tool",
    pickAgent: "Scegli un agente",
    tool: "Tool",
    risk: "Rischio",
    permission: "Permesso",
    from: "da",
    approvalPending: "In attesa della tua approvazione: vedi la pagina Governo.",
    budgetExhausted: "Budget raggiunto: l'agente è fermo finché non approvi un aumento in Governo.",
    agentStatus: "Stato",
    resume: "Riattiva",
    pause: "Metti in pausa",
    permissionNames: { automatic: "automatico", approval: "con approvazione", blocked: "bloccato" },
    kinds: { tool_use: "Uso di tool", dangerous_command: "Comando pericoloso", budget_increase: "Aumento di budget" },
    sources: { agent: "policy dell'agente", role: "policy del ruolo", company: "policy aziendale", risk: "rischio del tool" },
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
    // preference not saved: no problem
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
