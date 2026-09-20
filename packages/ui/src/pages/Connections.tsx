import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { api, eventsSocket, type ChannelBinding, type ChannelRecord, type EventDelivery, type EventSubscription, type Health, type ToolConnection, type Webhook } from "../api";
import { fill } from "../i18n";
import { Button, Card, Chip, Code, Input, Segmented, Select, timeAgo } from "../ui";
import type { Workspace } from "../App";

type Tab = "tools" | "channels" | "webhooks";

const statusTone = (s: string) =>
  (s === "healthy" ? "ok" : s === "failed" || s === "missing_secret" ? "danger" : s === "degraded" ? "warn" : "mute") as "ok" | "danger" | "warn" | "mute";

/** The Connections page: tool connections, channels, webhooks and events. */
export function ConnectionsPage({ ws }: { ws: Workspace }) {
  const { t, company } = ws;
  const [tab, setTab] = useState<Tab>("tools");
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    void api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{t.connectionsTitle}</h1>
          <p className="mt-1.5 text-[15px] text-mute">{t.connectionsSub}</p>
          {health?.sandbox && (
            <p className="mt-1 flex items-center gap-2 text-[13px] text-mute">
              <Chip tone={health.sandbox.kind === "docker" ? "ok" : "warn"}>{health.sandbox.kind}</Chip>
              {t.sandboxLine[health.sandbox.kind]}
            </p>
          )}
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          label={t.connectionsTitle}
          options={(["tools", "channels", "webhooks"] as Tab[]).map((v) => ({ value: v, label: t.connTabs[v] }))}
        />
      </header>
      {tab === "tools" && <ToolsTab ws={ws} companyId={company.id} />}
      {tab === "channels" && <ChannelsTab ws={ws} companyId={company.id} />}
      {tab === "webhooks" && <WebhooksTab ws={ws} companyId={company.id} />}
    </div>
  );
}

// --- Tools ---------------------------------------------------------------------

function ToolsTab({ ws, companyId }: { ws: Workspace; companyId: string }) {
  const { t } = ws;
  const [list, setList] = useState<ToolConnection[]>([]);
  const [adding, setAdding] = useState<"mcp" | "workflow" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => setList(await api.connections(companyId)), [companyId]);
  useEffect(() => {
    void load().catch(() => setList([]));
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && e.type.startsWith("connection.") && void load(),
        () => {},
      ),
    [companyId, load],
  );

  const act = async (c: ToolConnection, fn: () => Promise<unknown>) => {
    setBusy(c.id);
    try {
      await fn();
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-mute">{t.toolsExplain}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => setAdding(adding === "mcp" ? null : "mcp")}>
          <Plus size={15} /> {t.addMcp}
        </Button>
        <Button size="sm" onClick={() => setAdding(adding === "workflow" ? null : "workflow")}>
          <Plus size={15} /> {t.addWorkflow}
        </Button>
      </div>
      {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
      {adding && (
        <ConnectionForm
          ws={ws}
          kind={adding}
          onDone={async (message) => {
            setAdding(null);
            setNotice(message);
            await load();
          }}
          onCancel={() => setAdding(null)}
        />
      )}
      {list.length === 0 ? (
        <p className="text-sm text-mute">{t.noConnections}</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 xl:grid-cols-2">
          {list.map((c) => (
            <li key={c.id} className={`flex flex-col gap-2 rounded-[14px] border border-line bg-card p-4 ${c.enabled ? "" : "opacity-60"}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[14px] font-bold text-accent-text">{c.name}</span>
                <Chip tone={statusTone(c.status)} dot>
                  {t.connStatus[c.status]}
                </Chip>
                <span className="ml-auto text-[12px] text-mute">{t.connKind[c.kind]}</span>
              </div>
              {c.description && <p className="m-0 text-[13px]">{c.description}</p>}
              <p className="m-0 text-[12px] text-mute">
                {fill(t.connTools, { n: c.tools.length })} · {t.risks[c.risk]}
                {c.lastCheckedAt ? ` · ${fill(t.connCheckedAgo, { when: timeAgo(c.lastCheckedAt, t) })}` : ""}
                {c.statusDetail ? ` · ${c.statusDetail}` : ""}
              </p>
              {c.tools.length > 0 && (
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                  {c.tools.slice(0, 12).map((tool) => (
                    <li key={tool.name} title={tool.description} className="rounded-md border border-line bg-raised px-2 py-0.5 font-mono text-[11px]">
                      {c.name}__{tool.name}
                    </li>
                  ))}
                  {c.tools.length > 12 && <li className="text-[11px] text-mute">… {c.tools.length - 12}</li>}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy === c.id} onClick={() => void act(c, () => api.checkConnection(companyId, c.id))}>
                  <RefreshCw size={13} /> {t.connCheck}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => void act(c, () => api.updateConnection(companyId, c.id, { enabled: !c.enabled }))}>
                  {c.enabled ? t.connDisable : t.connEnable}
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto text-danger" disabled={busy === c.id} onClick={() => void act(c, () => api.removeConnection(companyId, c.id))}>
                  {t.connRemove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionForm({ ws, kind, onDone, onCancel }: { ws: Workspace; kind: "mcp" | "workflow"; onDone: (message: string) => Promise<void>; onCancel: () => void }) {
  const { t, company } = ws;
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [risk, setRisk] = useState<ToolConnection["risk"]>("medium");
  const [description, setDescription] = useState("");
  const [field, setField] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const secretNames = secret.trim() ? [secret.trim().toUpperCase()] : [];
      const auth = secretNames[0] ? { headers: { authorization: `Bearer \${${secretNames[0]}}` } } : {};
      const config =
        kind === "workflow"
          ? {
              url: url.trim(),
              method: "POST",
              toolDescription: description.trim(),
              inputSchema: { type: "object", properties: { input: { type: "string", description: "What to send to the workflow" } } },
              ...(field.trim() ? { resultField: field.trim() } : {}),
              ...auth,
            }
          : url.trim()
            ? { url: url.trim(), ...auth }
            : {
                command: command.trim(),
                args: args
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
              };
      const created = await api.createConnection(company.id, {
        kind: kind === "workflow" ? "workflow" : url.trim() ? "mcp_http" : "mcp_stdio",
        name: name.trim().toLowerCase(),
        description: description.trim(),
        config,
        risk,
        secretNames,
      });
      await onDone(`${created.name}: ${t.connStatus[created.status]}${created.statusDetail ? ` (${created.statusDetail})` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-56">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.connName} aria-label={t.connName} required autoFocus pattern="[a-z0-9][a-z0-9_\-]*" />
          </div>
          <div className="min-w-64 flex-1">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.connDescription}
              aria-label={t.connDescription}
              required={kind === "workflow"}
            />
          </div>
        </div>
        {kind === "mcp" && (
          <div className="flex flex-wrap gap-3">
            <div className="w-56">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t.connCommand} aria-label={t.connCommand} />
            </div>
            <div className="min-w-64 flex-1">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={t.connArgs} aria-label={t.connArgs} />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <div className="min-w-64 flex-1">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.connUrl} aria-label={t.connUrl} required={kind === "workflow"} />
          </div>
          <div className="w-64">
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t.connSecret} aria-label={t.connSecret} />
          </div>
          {kind === "workflow" && (
            <div className="w-56">
              <Input value={field} onChange={(e) => setField(e.target.value)} placeholder={t.connResultField} aria-label={t.connResultField} />
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px] text-mute">
            {t.connRisk}
            <div className="w-32">
              <Select value={risk} onChange={(e) => setRisk(e.target.value as ToolConnection["risk"])}>
                {(["low", "medium", "high"] as const).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
          </label>
        </div>
        {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim() || (kind === "mcp" ? !command.trim() && !url.trim() : !url.trim())}>
            {t.saveMemory}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- Channels ------------------------------------------------------------------

function ChannelsTab({ ws, companyId }: { ws: Workspace; companyId: string }) {
  const { t, overview } = ws;
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");
  const [agent, setAgent] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const agents = (overview?.agents ?? []).filter((a) => a.status === "active");
  const load = useCallback(async () => {
    const [c, b] = await Promise.all([api.channels(companyId), api.channelBindings(companyId)]);
    setChannels(c);
    setBindings(b);
  }, [companyId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && e.type.startsWith("channel.") && void load(),
        () => {},
      ),
    [companyId, load],
  );

  const run = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) setNotice(message);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const addTelegram = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await api.setSecret(companyId, "TELEGRAM_BOT_TOKEN", token.trim());
      const ch = await api.createChannel(companyId, { kind: "telegram", name: "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId: agent || null });
      setNotice(
        `Telegram: ${t.connStatus[ch.status]}${ch.config.botUsername ? ` @${ch.config.botUsername}` : ""}${ch.statusDetail && ch.status !== "healthy" ? ` (${ch.statusDetail})` : ""}`,
      );
      setAdding(false);
      setToken("");
    });
  };
  const pair = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const b = await api.pairChannel(companyId, code.trim());
      setNotice(fill(t.paired, { name: b.displayName }));
      setCode("");
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-mute">{t.channelsExplain}</p>
      {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-3">
          {channels.length === 0 && !adding && <p className="m-0 text-sm text-mute">{t.noChannels}</p>}
          {channels.map((ch) => (
            <Card key={ch.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-center gap-2">
                <span className="font-bold">{ch.name}</span>
                {ch.config.botUsername && <span className="font-mono text-[13px] text-accent-text">@{ch.config.botUsername}</span>}
                <Chip tone={statusTone(ch.status)} dot pulse={ch.live}>
                  {t.connStatus[ch.status]}
                </Chip>
              </div>
              {ch.statusDetail && ch.status !== "healthy" && <p className="m-0 text-[12px] text-mute">{ch.statusDetail}</p>}
              <label className="flex items-center gap-2 text-[13px] text-mute">
                {t.defaultAgent}
                <div className="w-44">
                  <Select value={ch.defaultAgentId ?? ""} onChange={(e) => void run(() => api.updateChannel(companyId, ch.id, { defaultAgentId: e.target.value || null }))}>
                    <option value="">—</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </label>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void run(() => api.reconnectChannel(companyId, ch.id))}>
                  <RefreshCw size={13} /> {t.reconnect}
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => void run(() => api.removeChannel(companyId, ch.id))}>
                  {t.connRemove}
                </Button>
              </div>
            </Card>
          ))}
          {channels.length === 0 && !adding && (
            <div>
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                <Plus size={15} /> {t.addTelegram}
              </Button>
            </div>
          )}
          {adding && (
            <Card className="p-4">
              <form onSubmit={addTelegram} className="flex flex-col gap-3">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={t.telegramToken}
                  aria-label={t.telegramToken}
                  required
                  autoFocus
                  type="password"
                  autoComplete="off"
                />
                <p className="m-0 text-[12px] text-mute">{t.telegramTokenHint}</p>
                <label className="flex items-center gap-2 text-[13px] text-mute">
                  {t.defaultAgent}
                  <div className="w-44">
                    <Select value={agent} onChange={(e) => setAgent(e.target.value)}>
                      <option value="">—</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </label>
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" size="sm" disabled={!token.trim()}>
                    {t.addTelegram}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                    {t.cancel}
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <Card className="p-4">
            <h2 className="m-0 text-[15px] font-bold">{t.pairTitle}</h2>
            <form onSubmit={pair} className="mt-2 flex gap-2">
              <div className="w-48">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.pairHint} aria-label={t.pairHint} inputMode="numeric" pattern="[0-9]{6}" />
              </div>
              <Button type="submit" variant="primary" size="sm" disabled={code.trim().length !== 6}>
                {t.pair}
              </Button>
            </form>
          </Card>
          <h2 className="m-0 text-[15px] font-bold">{t.pairedChats}</h2>
          {bindings.length === 0 ? (
            <p className="m-0 text-sm text-mute">{t.noBindings}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {bindings.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-3 text-[13px]">
                  <span className="font-bold">{b.displayName}</span>
                  {b.userId ? <Chip tone="ok">{t.you}</Chip> : <Chip tone="warn">{b.pairingCode ? `${t.waitingCode} · ${b.pairingCode}` : t.waitingCode}</Chip>}
                  {b.userId && (
                    <>
                      <span className="text-mute">{t.talksTo}</span>
                      <div className="w-36">
                        <Select value={b.agentId ?? ""} onChange={(e) => void run(() => api.updateBinding(companyId, b.id, { agentId: e.target.value || null }))}>
                          <option value="">{t.defaultAgent}</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <label className="flex items-center gap-1.5 text-mute">
                        <input type="checkbox" checked={b.notify} onChange={(e) => void run(() => api.updateBinding(companyId, b.id, { notify: e.target.checked }))} />{" "}
                        {b.notify ? t.notifyOn : t.notifyOff}
                      </label>
                    </>
                  )}
                  <button type="button" onClick={() => void run(() => api.removeBinding(companyId, b.id))} className="ml-auto text-[12px] font-bold text-danger">
                    {t.unlink}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Webhooks and events --------------------------------------------------------

function WebhooksTab({ ws, companyId }: { ws: Workspace; companyId: string }) {
  const { t, overview } = ws;
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [subs, setSubs] = useState<EventSubscription[]>([]);
  const [deliveries, setDeliveries] = useState<EventDelivery[]>([]);
  const [adding, setAdding] = useState<"hook" | "sub" | null>(null);
  const [name, setName] = useState("");
  const [action, setAction] = useState<Webhook["action"]>("create_task");
  const [agent, setAgent] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("task.*, approval.*");
  const [reveal, setReveal] = useState<{ title: string; value: string; hint?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const agents = (overview?.agents ?? []).filter((a) => a.status === "active");
  const load = useCallback(async () => {
    const [h, s, d] = await Promise.all([api.webhooks(companyId), api.subscriptions(companyId), api.deliveries(companyId)]);
    setHooks(h);
    setSubs(s);
    setDeliveries(d);
  }, [companyId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(
    () =>
      eventsSocket(
        (e) => e.companyId === companyId && e.type === "webhook.called" && void load(),
        () => {},
      ),
    [companyId, load],
  );

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      if (adding === "hook") {
        const h = await api.createWebhook(companyId, { name: name.trim(), action, defaults: agent ? { agentId: agent } : {} });
        setReveal({
          title: t.webhookCreated,
          value: `curl -X POST ${location.origin}${h.url} -H "Authorization: Bearer ${h.token}" -H "content-type: application/json" -d '{"title":"..."}'`,
        });
      } else {
        const s = await api.createSubscription(companyId, {
          name: name.trim(),
          url: url.trim(),
          events: events
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        });
        setReveal({ title: t.subCreated, value: s.secret ?? "", hint: t.signatureHint });
      }
      setAdding(null);
      setName("");
      setUrl("");
    });
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: the text is visible anyway
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] text-mute">{t.webhooksExplain}</p>
      {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
      {reveal && (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <p className="m-0 text-[13px]">{reveal.title}</p>
            <Button size="sm" className="ml-auto" onClick={() => void copy(reveal.value)}>
              {copied ? t.copied : t.copy}
            </Button>
            <button type="button" onClick={() => setReveal(null)} aria-label={t.cancel} className="text-mute">
              <X size={14} />
            </button>
          </div>
          <Code>{reveal.value}</Code>
          {reveal.hint && <p className="m-0 text-[12px] text-mute">{reveal.hint}</p>}
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="flex flex-col gap-3">
          <div className="flex items-center">
            <h2 className="m-0 text-[15px] font-bold">{t.inbound}</h2>
            <Button variant="primary" size="sm" className="ml-auto" onClick={() => setAdding(adding === "hook" ? null : "hook")}>
              <Plus size={15} /> {t.addWebhook}
            </Button>
          </div>
          {adding === "hook" && (
            <Card className="p-4">
              <form onSubmit={create} className="flex flex-wrap gap-3">
                <div className="w-48">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.webhookName} aria-label={t.webhookName} required autoFocus />
                </div>
                <div className="w-48">
                  <Select value={action} onChange={(e) => setAction(e.target.value as Webhook["action"])} aria-label={t.webhookAction}>
                    {(Object.keys(t.webhookActions) as Array<Webhook["action"]>).map((a) => (
                      <option key={a} value={a}>
                        {t.webhookActions[a]}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="w-40">
                  <Select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label={t.webhookDefaultAgent}>
                    <option value="">{t.webhookDefaultAgent}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit" variant="primary" size="sm" disabled={!name.trim()}>
                  {t.saveMemory}
                </Button>
              </form>
            </Card>
          )}
          {hooks.map((h) => (
            <div key={h.id} className={`flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-3 text-[13px] ${h.enabled ? "" : "opacity-60"}`}>
              <span className="font-bold">{h.name}</span>
              <Chip tone="mute">{t.webhookActions[h.action]}</Chip>
              <code className="font-mono text-[11px] text-mute">POST /v1/hooks/{h.id.slice(0, 8)}…</code>
              <span className="text-mute">{fill(t.webhookCalls, { n: h.calls })}</span>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  className="font-bold text-accent-text"
                  onClick={() =>
                    void run(async () =>
                      setReveal({
                        title: t.webhookCreated,
                        value: `curl -X POST ${location.origin}/v1/hooks/${h.id} -H "Authorization: Bearer ${(await api.rotateWebhook(companyId, h.id)).token}" -H "content-type: application/json" -d '{"title":"..."}'`,
                      }),
                    )
                  }
                >
                  {t.rotate}
                </button>
                <button type="button" className="text-mute" onClick={() => void run(() => api.updateWebhook(companyId, h.id, { enabled: !h.enabled }))}>
                  {h.enabled ? t.connDisable : t.connEnable}
                </button>
                <button type="button" className="text-danger" onClick={() => void run(() => api.removeWebhook(companyId, h.id))}>
                  {t.connRemove}
                </button>
              </span>
            </div>
          ))}
        </section>
        <section className="flex flex-col gap-3">
          <div className="flex items-center">
            <h2 className="m-0 text-[15px] font-bold">{t.outbound}</h2>
            <Button variant="primary" size="sm" className="ml-auto" onClick={() => setAdding(adding === "sub" ? null : "sub")}>
              <Plus size={15} /> {t.addSubscription}
            </Button>
          </div>
          {adding === "sub" && (
            <Card className="p-4">
              <form onSubmit={create} className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-3">
                  <div className="w-48">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.webhookName} aria-label={t.webhookName} required autoFocus />
                  </div>
                  <div className="min-w-64 flex-1">
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.subUrl} aria-label={t.subUrl} required />
                  </div>
                </div>
                <Input value={events} onChange={(e) => setEvents(e.target.value)} placeholder={t.subEvents} aria-label={t.subEvents} />
                <div>
                  <Button type="submit" variant="primary" size="sm" disabled={!name.trim() || !url.trim()}>
                    {t.saveMemory}
                  </Button>
                </div>
              </form>
            </Card>
          )}
          {subs.map((s) => (
            <div key={s.id} className={`flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-card px-4 py-3 text-[13px] ${s.enabled ? "" : "opacity-60"}`}>
              <span className="font-bold">{s.name}</span>
              <code className="min-w-0 truncate font-mono text-[11px] text-mute">{s.url}</code>
              <span className="text-mute">{s.events.join(", ")}</span>
              {s.failures > 0 && <Chip tone="danger">{s.failures}</Chip>}
              <span className="ml-auto flex gap-2">
                <button type="button" className="text-mute" onClick={() => void run(() => api.updateSubscription(companyId, s.id, { enabled: !s.enabled }))}>
                  {s.enabled ? t.connDisable : t.connEnable}
                </button>
                <button type="button" className="text-danger" onClick={() => void run(() => api.removeSubscription(companyId, s.id))}>
                  {t.connRemove}
                </button>
              </span>
            </div>
          ))}
          <h3 className="m-0 mt-2 text-[12px] font-bold uppercase tracking-wide text-mute">{t.deliveries}</h3>
          {deliveries.length === 0 ? (
            <p className="m-0 text-[13px] text-mute">{t.noDeliveries}</p>
          ) : (
            <ul className="m-0 list-none space-y-1 p-0 text-[12px]">
              {deliveries.slice(0, 12).map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <Chip tone={d.status === "delivered" ? "ok" : d.status === "failed" ? "danger" : "mute"}>{d.status}</Chip>
                  <span className="font-mono">{d.eventType}</span>
                  <span className="text-mute">
                    {d.responseStatus ? `HTTP ${d.responseStatus}` : (d.error ?? "")} · {timeAgo(d.createdAt, t)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <p className="m-0 flex items-center gap-2 rounded-control border border-line bg-card px-3 py-2 text-[13px]">
      {text}
      <button type="button" onClick={onClose} className="ml-auto text-mute" aria-label="close">
        <X size={14} />
      </button>
    </p>
  );
}
