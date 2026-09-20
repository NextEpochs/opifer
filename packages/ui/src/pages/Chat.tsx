import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Square } from "lucide-react";
import { api, eventsSocket, type Session, type SessionDetail, type StoredMessage } from "../api";
import { fill, type Strings } from "../i18n";
import { Avatar, Button, Chip, Code, Input, Select, money } from "../ui";
import { ApprovalCard } from "../components/ApprovalCard";
import type { Workspace } from "../App";

interface LiveState {
  streaming: string;
  tools: Array<{ id: string; name: string; status: "running" | "ok" | "error"; detail: string }>;
  notices: string[];
}

const emptyLive: LiveState = { streaming: "", tools: [], notices: [] };

/** Chat with an agent: the primary door. Approvals show up in the thread; the workbench shows what the agent is doing. */
export function ChatPage({ ws, param }: { ws: Workspace; param: string | null }) {
  const { t, company, overview, mode, pending } = ws;
  const agents = overview?.agents ?? [];
  const [sessions, setSessions] = useState<Session[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<LiveState>(emptyLive);
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const selected = param && !param.startsWith("new-") ? param : null;

  const loadSessions = useCallback(async () => {
    setSessions(await api.sessions(company.id));
  }, [company.id]);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api.session(id));
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    setAgentId((current) => current || agents[0]?.id || "");
  }, [agents]);

  // "#/chat/new-<agentId>" starts a conversation with that agent right away.
  useEffect(() => {
    if (!param?.startsWith("new-")) return;
    const id = param.slice(4);
    api
      .createSession(company.id, id)
      .then((s) => {
        void loadSessions();
        ws.go("chat", s.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [param, company.id, loadSessions, ws]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setLive(emptyLive);
    void loadDetail(selected);
    return eventsSocket((event) => {
      const payload = event.payload as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (event.type === "session.created") void loadSessions();
      if (event.type !== "session.event" || payload?.sessionId !== selected || !payload.event) return;
      const e = payload.event;
      switch (e["type"]) {
        case "text":
          setLive((l) => ({ ...l, streaming: l.streaming + String(e["text"] ?? "") }));
          break;
        case "tool_call":
          setLive((l) => ({ ...l, tools: [...l.tools, { id: String(e["callId"]), name: String(e["name"]), status: "running", detail: JSON.stringify(e["arguments"] ?? {}).slice(0, 160) }] }));
          break;
        case "tool_result":
          setLive((l) => ({ ...l, tools: l.tools.map((tool) => (tool.id === e["callId"] ? { ...tool, status: e["isError"] ? "error" : "ok", detail: String(e["content"] ?? "").split("\n")[0]!.slice(0, 160) } : tool)) }));
          break;
        case "message":
          setLive((l) => ({ ...l, streaming: "" }));
          void loadDetail(selected);
          break;
        case "notice":
        case "retry":
        case "fallback":
          setLive((l) => ({ ...l, notices: [...l.notices, String(e["message"] ?? e["reason"] ?? e["type"])] }));
          break;
        case "done": {
          const run = e["run"] as { status?: string; error?: string | null; stopReason?: string | null } | undefined;
          const notice = run?.status === "failed" ? `${t.turnFailed}: ${run.error ?? run.stopReason ?? "?"}` : null;
          setLive(notice ? { ...emptyLive, notices: [notice] } : emptyLive);
          void loadDetail(selected);
          void loadSessions();
          break;
        }
        default:
          break;
      }
    }, () => {});
  }, [selected, loadDetail, loadSessions, t.turnFailed]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, live.streaming, live.tools.length, pending.length]);

  const newSession = async () => {
    if (!agentId) return;
    ws.go("chat", `new-${agentId}`);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !text.trim()) return;
    setError(null);
    const message = text.trim();
    setText("");
    try {
      await api.sendMessage(selected, message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async () => {
    if (selected) await api.interrupt(selected).catch(() => {});
  };

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const name = detail ? ws.agentName(detail.agentId) : "";
  const running = detail?.running || live.streaming !== "" || live.tools.some((tool) => tool.status === "running");
  const lastRun = detail?.runs.at(-1);
  const inThread = detail ? pending.filter((a) => a.sessionId === detail.id) : [];
  const totalIn = detail?.runs.reduce((n, r) => n + r.inputTokens, 0) ?? 0;
  const totalOut = detail?.runs.reduce((n, r) => n + r.outputTokens, 0) ?? 0;
  const today = new Date().toDateString();
  const groups = [
    { label: t.today, items: sessions.filter((s) => new Date(s.createdAt).toDateString() === today) },
    { label: t.earlier, items: sessions.filter((s) => new Date(s.createdAt).toDateString() !== today) },
  ];

  return (
    <div className="flex h-full min-h-screen">
      <aside className="flex w-[260px] shrink-0 flex-col gap-2 border-r border-line bg-panel px-3.5 py-6">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label={t.teamTitle}>
              {agents.length === 0 && <option value="">{t.nobodyWorking}</option>}
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" size="md" onClick={() => void newSession()} disabled={!agentId} aria-label={t.newConversation}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups.map(
            (g) =>
              g.items.length > 0 && (
                <div key={g.label}>
                  <div className="px-2 pb-0.5 pt-3 text-[11px] font-bold uppercase tracking-wide text-mute">{g.label}</div>
                  {g.items.map((s) => (
                    <a key={s.id} href={`#/chat/${s.id}`} aria-current={selected === s.id ? "true" : undefined} className={`block rounded-control px-3 py-2.5 no-underline ${selected === s.id ? "bg-accent-soft text-ink" : "text-ink hover:bg-hover"}`}>
                      <span className="block truncate text-sm font-bold">{s.title ?? t.untitled}</span>
                      <span className="block truncate text-[13px] text-mute">
                        {ws.agentName(s.agentId)} · {s.status}
                      </span>
                    </a>
                  ))}
                </div>
              ),
          )}
          {sessions.length === 0 && <p className="px-2 text-[13px] text-mute">{t.noConversations}</p>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!detail ? (
          <p className="m-auto text-sm text-mute">{t.pickConversation}</p>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-line px-7 py-4">
              <Avatar name={name} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-bold">
                  {name} <span className="text-[13px] font-normal text-mute">· {agentOf(detail.agentId)?.role.split(/[.\n]/)[0]}</span>
                </div>
                <div className="truncate text-[13px] text-mute">
                  {detail.title ?? t.untitled} · {detail.model}
                </div>
              </div>
              {running ? (
                <Chip tone="ok" dot pulse>
                  {t.working}
                </Chip>
              ) : inThread.length > 0 ? (
                <Chip tone="warn" dot>
                  {t.activity.waiting}
                </Chip>
              ) : null}
              {running && (
                <Button variant="ghost" size="sm" onClick={() => void stop()}>
                  <Square size={12} /> {t.stop}
                </Button>
              )}
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto px-7 py-5" role="log" aria-live="polite">
              {detail.messages.map((m) => (
                <MessageView key={m.id} message={m} agent={name} t={t} advanced={mode === "advanced"} />
              ))}
              {live.tools.length > 0 && (
                <ul className="m-0 list-none space-y-1 p-0 pl-11 text-[13px]">
                  {live.tools.map((tool) => (
                    <li key={tool.id} className={`flex items-center gap-2 ${tool.status === "error" ? "text-danger" : tool.status === "ok" ? "text-ok" : "text-mute"}`}>
                      <span className="font-extrabold">{tool.status === "running" ? "…" : tool.status === "ok" ? "✓" : "✗"}</span>
                      <span className="font-mono text-[12px]">{tool.name}</span>
                      <span className="truncate text-mute">{tool.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {live.streaming && (
                <div className="flex max-w-[78%] gap-3">
                  <Avatar name={name} size={32} />
                  <p className="m-0 whitespace-pre-wrap rounded-[4px_18px_18px_18px] border border-line bg-card px-4 py-3 text-[15px] leading-relaxed">{live.streaming}</p>
                </div>
              )}
              {inThread.map((a) => (
                <div key={a.id} className="max-w-[78%] pl-11">
                  <ApprovalCard approval={a} agentName={ws.agentName} companyId={company.id} t={t} onDecided={ws.refresh} compact />
                </div>
              ))}
              {live.notices.map((n, i) => (
                <p key={i} className="m-0 text-[13px] text-warn">
                  {n}
                </p>
              ))}
              {live.notices.length === 0 && lastRun?.status === "failed" && !running && (
                <p role="alert" className="m-0 rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
                  {t.turnFailed}: {lastRun.error ?? lastRun.stopReason}
                </p>
              )}
              {lastRun?.stopReason === "budget_exhausted" && !running && <p className="m-0 text-[13px] text-warn">{fill(t.budgetExhaustedInChat, { agent: name })}</p>}
              <div ref={bottom} />
            </div>

            {error && (
              <p role="alert" className="m-0 px-7 text-xs text-danger">
                {error}
              </p>
            )}
            <form onSubmit={send} className="flex items-center gap-2.5 px-7 pb-6 pt-3">
              <div className="flex flex-1 items-center gap-2 rounded-2xl border border-line-strong bg-card py-2 pl-4 pr-2">
                <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={running ? fill(t.injectHint, { agent: name }) : fill(t.messageHint, { agent: name })} aria-label={t.message} disabled={detail.status !== "active"} className="border-0 bg-transparent px-0 py-1 text-[15px] focus:ring-0" />
                <Button type="submit" variant="primary" size="sm" disabled={detail.status !== "active" || !text.trim()}>
                  {t.send}
                </Button>
              </div>
            </form>
          </>
        )}
      </section>

      {detail && (
        <aside className="hidden w-[280px] shrink-0 flex-col gap-3.5 border-l border-line bg-panel p-5 xl:flex">
          <h2 className="m-0 text-[12px] font-bold uppercase tracking-wide text-mute">{t.workbench}</h2>
          <div className="rounded-[14px] border border-line bg-card p-3.5">
            <div className="text-[13px] text-mute">{t.thisConversation}</div>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[26px] font-semibold">{money(agentOf(detail.agentId)?.spend.eur ?? 0)}</span>
              <span className="text-[12px] text-mute">
                · {detail.runs.length} {t.calls}
              </span>
            </div>
            <div className="text-[12px] text-mute">
              {totalIn} / {totalOut} {t.tokens}
            </div>
          </div>
          <div className="rounded-[14px] border border-line bg-card p-3.5 text-[13px]">
            <div className="text-mute">{t.toolResults}</div>
            {detail.messages
              .flatMap((m) => m.content)
              .filter((p): p is Extract<StoredMessage["content"][number], { type: "tool_call" }> => p.type === "tool_call")
              .slice(-6)
              .map((p) => (
                <div key={p.id} className="mt-1 truncate font-mono text-[12px]">
                  {p.name} <span className="text-faint">{JSON.stringify(p.arguments).slice(0, 60)}</span>
                </div>
              ))}
          </div>
          {mode === "advanced" && lastRun && (
            <div className="rounded-[14px] border border-line bg-card p-3.5 text-[12px] text-mute">
              <div className="mb-1 text-[13px]">{t.underTheHood}</div>
              <div className="font-mono">
                run {lastRun.id.slice(0, 8)} · {lastRun.status} · {lastRun.stopReason ?? "—"}
              </div>
              <div className="font-mono">
                {lastRun.inputTokens} / {lastRun.outputTokens} {t.tokens}
              </div>
              <div className="font-mono">{detail.model}</div>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function MessageView({ message, agent, t, advanced }: { message: StoredMessage; agent: string; t: Strings; advanced: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="accent-gradient max-w-[70%] whitespace-pre-wrap rounded-[18px_18px_4px_18px] px-4 py-3 text-[15px] leading-relaxed text-white">{message.content.map((p) => (p.type === "text" ? p.text : "")).join("")}</div>
      </div>
    );
  }
  if (message.role === "tool") {
    return (
      <div className="pl-11">
        {message.content.map((part, i) =>
          part.type === "tool_result" ? (
            <details key={i} className="text-[13px]">
              <summary className={`cursor-pointer ${part.isError ? "text-danger" : "text-mute"}`}>
                {part.isError ? "✗" : "✓"} {t.toolResults}
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-[10px] border border-line bg-bg p-2.5 font-mono text-[12px] text-ink-2">{part.content.slice(0, 4000)}</pre>
            </details>
          ) : null,
        )}
      </div>
    );
  }
  return (
    <div className="flex max-w-[78%] gap-3">
      <Avatar name={agent} size={32} />
      <div className="flex min-w-0 flex-col gap-2">
        {message.content.map((part, i) => {
          if (part.type === "text") return <p key={i} className="m-0 whitespace-pre-wrap rounded-[4px_18px_18px_18px] border border-line bg-card px-4 py-3 text-[15px] leading-relaxed">{part.text}</p>;
          if (part.type === "tool_call")
            return (
              <div key={i} className="text-[13px] text-mute">
                <span className="font-mono text-[12px]">⚙ {part.name}</span>
                {advanced && <Code>{JSON.stringify(part.arguments, null, 1).slice(0, 800)}</Code>}
                {!advanced && typeof part.arguments["command"] === "string" && <Code>{String(part.arguments["command"])}</Code>}
              </div>
            );
          return null;
        })}
      </div>
    </div>
  );
}
