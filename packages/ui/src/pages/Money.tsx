import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type CostReport } from "../api";
import { Avatar, Button, Card, CardHeader, EmptyState, Input, Select, money } from "../ui";
import type { Workspace } from "../App";

/** Costs and caps: where every euro goes and the limits that stop it. */
export function MoneyPage({ ws }: { ws: Workspace }) {
  const { t, company, overview } = ws;
  const [report, setReport] = useState<CostReport | null>(null);
  const [scope, setScope] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const agents = overview?.agents ?? [];

  const load = useCallback(() => api.costs(company.id).then(setReport).catch(() => setReport(null)), [company.id]);
  useEffect(() => {
    void load();
  }, [load, overview]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amount = Number(cap);
    if (!Number.isFinite(amount) || amount < 0) return;
    setBusy(true);
    try {
      await api.setBudget(company.id, scope ? { scopeKind: "agent", scopeId: scope, cap: amount } : { scopeKind: "company", cap: amount });
      setCap("");
      await load();
      await ws.refresh();
    } finally {
      setBusy(false);
    }
  };

  const total = report?.total.eur ?? 0;
  const companyCap = report?.policies.find((p) => p.scopeKind === "company") ?? null;
  const palette = ["var(--o-accent)", "#06B6D4", "#10B981", "#F97316", "#EC4899", "#3B82F6"];

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header>
        <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{t.moneyTitle}</h1>
        <p className="mt-1.5 text-[15px] text-mute">{t.moneySub}</p>
      </header>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-7">
          <CardHeader title={t.thisMonth} />
          <div className="px-[18px] pb-[18px] pt-2">
            <div className="flex items-baseline gap-3">
              <span className="font-display text-[40px] font-bold leading-none">{money(total)}</span>
              {companyCap && <span className="text-mute">/ {money(companyCap.cap, companyCap.currency, 0)}</span>}
            </div>
            {report && report.byAgent.length > 0 ? (
              <div className="mt-5 flex flex-col gap-3">
                {report.byAgent.map((a, i) => (
                  <div key={a.agentId ?? "none"} className="flex items-center gap-3 text-sm">
                    <Avatar name={a.agentName ?? "?"} size={28} />
                    <span className="w-32 truncate">{a.agentName ?? "—"}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(2, (a.eur / Math.max(total, 0.0001)) * 100)}%`, background: palette[i % palette.length] }} />
                    </div>
                    <span className="w-24 text-right font-mono text-[12px]">{money(a.eur, "EUR", 4)}</span>
                    <span className="w-20 text-right text-[12px] text-mute">
                      {a.calls} {t.calls}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-mute">{t.noCosts}</p>
            )}
          </div>
        </Card>

        <Card className="xl:col-span-5">
          <CardHeader title={t.byModel} />
          {report && report.byModel.length > 0 ? (
            <div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-2 text-sm">
              {report.byModel.map((m) => (
                <div key={m.model ?? "none"} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m.model ?? "—"}</span>
                  <span className="font-mono text-[12px]">{money(m.eur, "EUR", 4)}</span>
                  <span className="w-28 text-right text-[12px] text-mute">
                    {m.inputTokens} / {m.outputTokens}
                  </span>
                </div>
              ))}
              <p className="m-0 mt-1 text-[12px] text-faint">{t.tokens}: {t.inOut}</p>
            </div>
          ) : (
            <EmptyState>{t.noCosts}</EmptyState>
          )}
        </Card>

        <Card className="xl:col-span-12">
          <CardHeader title={t.caps}>
            <span className="text-[13px] text-mute">{t.capsHint}</span>
          </CardHeader>
          <div className="flex flex-col gap-2.5 px-[18px] pb-[18px] pt-3">
            {report && report.policies.length === 0 && <p className="m-0 text-sm text-mute">{t.noCaps}</p>}
            {report?.policies.map((p) => {
              const agent = agents.find((a) => a.id === p.scopeId);
              const spent = p.scopeKind === "company" ? total : (agent?.spend.eur ?? 0);
              const ratio = p.cap > 0 ? Math.min(1, spent / p.cap) : 1;
              return (
                <div key={p.id} className="flex items-center gap-3.5 rounded-control border border-line px-3 py-2.5">
                  <Avatar name={agent?.name ?? company.name} size={30} colour={p.scopeKind === "company" ? "var(--o-accent-strong)" : undefined} />
                  <div className="w-44">
                    <div className="text-sm font-bold">{p.scopeKind === "company" ? t.wholeCompany : (agent?.name ?? p.scopeKind)}</div>
                    <div className="text-[12px] text-mute">{p.window}</div>
                  </div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full" style={{ width: `${ratio * 100}%`, background: ratio >= 1 ? "var(--o-danger)" : ratio >= p.warnRatio ? "var(--o-warn)" : "var(--o-accent)" }} />
                  </div>
                  <strong className="w-32 text-right text-sm">
                    {money(spent, p.currency)} / {money(p.cap, p.currency, 0)}
                  </strong>
                  <Button variant="ghost" size="sm" onClick={() => void api.removeBudget(company.id, p.id).then(load).then(ws.refresh)}>
                    {t.remove}
                  </Button>
                </div>
              );
            })}
            <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <div className="min-w-48 flex-1">
                <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label={t.addCap}>
                  <option value="">{t.wholeCompany}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-48">
                <Input value={cap} onChange={(e) => setCap(e.target.value)} type="number" min="0" step="0.5" placeholder={`${t.monthlyCap} (EUR)`} aria-label={t.monthlyCap} required />
              </div>
              <Button type="submit" variant="primary" disabled={busy}>
                {t.addCap}
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
