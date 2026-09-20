import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, eventsSocket, type Agent, type Company, type Session, type SessionDetail, type StoredMessage } from "./api";
import type { Strings } from "./i18n";

interface LiveState {
  streaming: string;
  tools: Array<{ id: string; name: string; status: "running" | "ok" | "error"; detail: string }>;
  notices: string[];
}

const emptyLive: LiveState = { streaming: "", tools: [], notices: [] };

export function Chat({ company, t }: { company: Company; t: Strings }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<LiveState>(emptyLive);
  const [text, setText] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadLists = useCallback(async () => {
    const [a, s] = await Promise.all([api.agents(company.id), api.sessions(company.id)]);
    setAgents(a);
    setSessions(s);
    setAgentId((current) => current || a[0]?.id || "");
  }, [company.id]);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api.session(id));
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (!selected) return;
    setLive(emptyLive);
    void loadDetail(selected);
    return eventsSocket((event) => {
      const payload = event.payload as { sessionId?: string; event?: Record<string, unknown> } | undefined;
      if (event.type === "session.created") void loadLists();
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
          setLive((l) => ({
            ...l,
            tools: l.tools.map((tool) => (tool.id === e["callId"] ? { ...tool, status: e["isError"] ? "error" : "ok", detail: String(e["content"] ?? "").split("\n")[0]!.slice(0, 160) } : tool)),
          }));
          break;
        case "message":
          // the assistant message is persisted: the streamed text becomes part of the history
          setLive((l) => ({ ...l, streaming: "" }));
          void loadDetail(selected);
          break;
        case "notice":
        case "retry":
        case "fallback":
          setLive((l) => ({ ...l, notices: [...l.notices, String(e["message"] ?? e["reason"] ?? e["type"])] }));
          break;
        case "done":
          setLive(emptyLive);
          void loadDetail(selected);
          void loadLists();
          break;
        default:
          break;
      }
    }, () => {});
  }, [selected, loadDetail, loadLists]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, live.streaming, live.tools.length]);

  const newSession = async () => {
    if (!agentId) return;
    setError(null);
    try {
      const session = await api.createSession(company.id, agentId);
      await loadLists();
      setSelected(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "?";
  const running = detail?.running || live.streaming !== "" || live.tools.some((tool) => tool.status === "running");

  return (
    <section className="grid gap-4 md:grid-cols-[16rem_1fr]" aria-label={t.chat}>
      <aside className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 space-y-2">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label={t.agents} className={inputCls}>
            {agents.length === 0 && <option value="">{t.noAgents}</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={newSession} disabled={!agentId} className={`${buttonCls} w-full`}>
            {t.newSession}
          </button>
        </div>
        <ul className="max-h-[28rem] space-y-1 overflow-y-auto text-sm">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setSelected(s.id)}
                aria-current={selected === s.id ? "true" : undefined}
                className={`w-full rounded px-2 py-1 text-left ${selected === s.id ? "bg-brand-50 text-brand-700 dark:bg-zinc-800 dark:text-brand-500" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
              >
                <span className="block truncate">{s.title ?? t.untitled}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {agentName(s.agentId)} · {s.status}
                </span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="px-2 text-xs text-zinc-500">{t.noSessions}</li>}
        </ul>
      </aside>

      <div className="flex min-h-[32rem] flex-col rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {!detail ? (
          <p className="m-auto text-sm text-zinc-500">{t.pickSession}</p>
        ) : (
          <>
            <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800">
              <span>
                <span className="font-medium">{agentName(detail.agentId)}</span> <span className="text-zinc-500">· {detail.model}</span>
              </span>
              <span className="flex items-center gap-2 text-xs text-zinc-500">
                {running && <span className="text-brand-600">{t.working}</span>}
                <span>{detail.status}</span>
              </span>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm" role="log" aria-live="polite">
              {detail.messages.map((m) => (
                <MessageView key={m.id} message={m} agent={agentName(detail.agentId)} t={t} />
              ))}
              {live.tools.length > 0 && (
                <ul className="space-y-1 font-mono text-xs text-zinc-500">
                  {live.tools.map((tool) => (
                    <li key={tool.id}>
                      {tool.status === "running" ? "…" : tool.status === "ok" ? "✓" : "✗"} {tool.name} <span className="text-zinc-400">{tool.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {live.streaming && (
                <div>
                  <span className="text-xs font-semibold uppercase text-brand-600">{agentName(detail.agentId)}</span>
                  <p className="whitespace-pre-wrap">{live.streaming}</p>
                </div>
              )}
              {live.notices.map((n, i) => (
                <p key={i} className="text-xs text-amber-600">
                  {n}
                </p>
              ))}
              <div ref={bottom} />
            </div>
            {error && (
              <p role="alert" className="px-4 text-xs text-red-600">
                {error}
              </p>
            )}
            <form onSubmit={send} className="flex gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder={running ? t.injectHint : t.messageHint} aria-label={t.message} className={inputCls} disabled={detail.status !== "active"} />
              {running ? (
                <button type="button" onClick={stop} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
                  {t.stop}
                </button>
              ) : null}
              <button type="submit" disabled={detail.status !== "active" || !text.trim()} className={buttonCls}>
                {t.send}
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

function MessageView({ message, agent, t }: { message: StoredMessage; agent: string; t: Strings }) {
  const label = message.role === "user" ? t.you : message.role === "assistant" ? agent : t.toolResults;
  const cls = message.role === "user" ? "text-zinc-600" : message.role === "assistant" ? "text-brand-600" : "text-zinc-400";
  return (
    <div>
      <span className={`text-xs font-semibold uppercase ${cls}`}>{label}</span>
      {message.content.map((part, i) => {
        if (part.type === "text") return <p key={i} className="whitespace-pre-wrap">{part.text}</p>;
        if (part.type === "tool_call") return <p key={i} className="font-mono text-xs text-zinc-500">⚙ {part.name} {JSON.stringify(part.arguments).slice(0, 160)}</p>;
        return (
          <pre key={i} className={`max-h-40 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs dark:bg-zinc-950 ${part.isError ? "text-red-600" : "text-zinc-600 dark:text-zinc-300"}`}>
            {part.content.slice(0, 2000)}
          </pre>
        );
      })}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-800";
const buttonCls =
  "rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:opacity-50 dark:focus:ring-zinc-700";
