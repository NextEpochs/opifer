import { useState } from "react";
import { api, type Approval } from "../api";
import { fill, type Strings } from "../i18n";
import { Avatar, Button, Chip, Code, Input, timeAgo, money } from "../ui";

export interface ApprovalCardProps {
  approval: Approval;
  agentName: (id: string | null) => string;
  companyId: string;
  t: Strings;
  onDecided: () => void | Promise<void>;
  /** Fewer words: inside a chat or a small widget. */
  compact?: boolean;
}

function subjectOf(a: Approval) {
  const s = a.subject;
  const args = (s["arguments"] ?? {}) as Record<string, unknown>;
  return {
    tool: typeof s["tool"] === "string" ? (s["tool"] as string) : null,
    command: typeof args["command"] === "string" ? (args["command"] as string) : null,
    args,
    cap: typeof s["cap"] === "number" ? (s["cap"] as number) : Number(s["cap"] ?? 0),
    spent: typeof s["spent"] === "number" ? (s["spent"] as number) : Number(s["spent"] ?? 0),
    currency: typeof s["currency"] === "string" ? (s["currency"] as string) : "EUR",
    scope: typeof s["scope"] === "string" ? (s["scope"] as string) : "",
  };
}

/** One decision, explained in plain words, with everything needed to take it. */
export function ApprovalCard({ approval: a, agentName, companyId, t, onDecided, compact = false }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = subjectOf(a);
  const agent = agentName(a.agentId);
  const [cap, setCap] = useState(Math.max(1, Math.ceil(s.cap * 2)));
  const toolLabel = s.tool ? ((t.tools as Record<string, string>)[s.tool] ?? s.tool) : "";

  const decide = async (status: "approved" | "denied") => {
    setBusy(true);
    setError(null);
    try {
      if (status === "approved" && always && s.tool && a.agentId) {
        await api.setToolPolicy(companyId, { targetKind: "agent", targetId: a.agentId, toolName: s.tool, permission: "automatic" });
      }
      await api.decide(a.id, status, note.trim() || undefined, a.kind === "budget_increase" && status === "approved" ? cap : undefined);
      await onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    a.kind === "tool_use" ? fill(t.wantsTo.tool_use, { agent, tool: toolLabel.toLowerCase() }) : a.kind === "dangerous_command" ? fill(t.wantsTo.dangerous_command, { agent }) : a.kind === "budget_increase" ? fill(t.wantsTo.budget_increase, { agent }) : fill(t.wantsTo.other, { agent });
  const explanation = a.kind === "tool_use" ? fill(t.explain.tool_use, { agent }) : a.kind === "dangerous_command" ? t.explain.dangerous_command : a.kind === "budget_increase" ? fill(t.explain.budget_increase, { agent }) : null;
  const tone = a.risk === "high" ? "danger" : a.risk === "medium" ? "warn" : "mute";
  const pending = a.status === "pending";

  return (
    <article className={`flex flex-col gap-3 rounded-[14px] border ${a.kind === "dangerous_command" ? "border-danger/50" : "border-line"} bg-card p-4`} aria-label={title}>
      <div className="flex items-center gap-3">
        <Avatar name={agent} size={compact ? 30 : 38} />
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-tight">{title}</div>
          <div className="text-[13px] text-mute">
            {timeAgo(a.createdAt, t)} · {t.risks[a.risk]}
            {a.reason && !compact ? ` · ${a.reason}` : ""}
          </div>
        </div>
        <Chip tone={tone}>{(t.kinds as Record<string, string>)[a.kind] ?? a.kind}</Chip>
      </div>

      {s.command ? <Code>{s.command}</Code> : s.tool && Object.keys(s.args).length > 0 ? <Code>{JSON.stringify(s.args, null, 1).slice(0, 600)}</Code> : null}

      {a.kind === "budget_increase" && (
        <div className="text-[13px] text-mute">
          {s.scope}: {money(s.spent, s.currency)} / {money(s.cap, s.currency)}
        </div>
      )}
      {explanation && !compact && <p className="m-0 text-[13px] text-mute">{explanation}</p>}

      {pending && a.kind === "budget_increase" && (
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-mute">{t.newCap}</span>
          <input type="range" min={Math.max(1, Math.ceil(s.cap))} max={Math.max(10, Math.ceil(s.cap * 10))} step="1" value={cap} onChange={(e) => setCap(Number(e.target.value))} aria-label={t.newCap} className="flex-1" />
          <strong className="w-28 text-right">
            {money(cap, s.currency, 0)} {t.perMonth}
          </strong>
        </div>
      )}

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          {a.kind === "budget_increase" ? (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide("approved")}>
                {fill(t.raiseAndResume, { cap: money(cap, s.currency, 0) })}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide("denied")}>
                {t.keepPaused}
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide("approved")}>
                {t.approve}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide("denied")}>
                {t.deny}
              </Button>
              {a.kind === "tool_use" && s.tool && (
                <label className="ml-auto flex items-center gap-2 text-[13px] text-mute">
                  <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-accent" />
                  {fill(t.alwaysAllow, { tool: toolLabel.toLowerCase(), agent })}
                </label>
              )}
            </>
          )}
          {!compact && a.kind !== "budget_increase" && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={fill(t.noteFor, { agent })} aria-label={fill(t.noteFor, { agent })} className="basis-full sm:basis-64 sm:flex-1" />}
        </div>
      ) : (
        <div className="text-[13px] text-mute">
          {t.decidedAs[a.status as keyof typeof t.decidedAs] ?? a.status}
          {a.decisionNote ? ` · ${a.decisionNote}` : ""}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </article>
  );
}
