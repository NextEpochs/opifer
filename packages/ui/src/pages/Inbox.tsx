import { useEffect, useState } from "react";
import { api, type Approval } from "../api";
import { fill } from "../i18n";
import { Button, Kbd } from "../ui";
import { ApprovalCard } from "../components/ApprovalCard";
import type { Workspace } from "../App";

/** The inbox: every decision a person has to take, oldest first. A / D decide the focused one. */
export function InboxPage({ ws }: { ws: Workspace }) {
  const { t, company, pending } = ws;
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [decided, setDecided] = useState<Approval[]>([]);
  const [focus, setFocus] = useState(0);

  useEffect(() => {
    if (tab === "decided") api.approvals(company.id).then((list) => setDecided(list.filter((a) => a.status !== "pending"))).catch(() => setDecided([]));
  }, [tab, company.id, pending.length]);

  const list = tab === "pending" ? [...pending].reverse() : decided;

  useEffect(() => {
    setFocus((f) => Math.min(f, Math.max(0, list.length - 1)));
  }, [list.length]);

  useEffect(() => {
    if (tab !== "pending") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const current = list[focus];
      if (e.key === "j" || e.key === "ArrowDown") setFocus((f) => Math.min(f + 1, list.length - 1));
      else if (e.key === "k" || e.key === "ArrowUp") setFocus((f) => Math.max(f - 1, 0));
      else if ((e.key === "a" || e.key === "d") && current) {
        e.preventDefault();
        void api.decide(current.id, e.key === "a" ? "approved" : "denied").then(ws.refresh);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, list, focus, ws.refresh]);

  return (
    <div className="flex flex-col gap-6 p-6 sm:p-9">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <h1 className="m-0 font-display text-[34px] font-bold leading-[1.1] tracking-tight">{t.inboxTitle}</h1>
          <p className="mt-1.5 text-[15px] text-mute">{t.inboxSub}</p>
        </div>
        <div className="flex items-center gap-1.5 text-[13px] text-mute">
          <Kbd>A</Kbd> <Kbd>D</Kbd> <Kbd>J</Kbd>/<Kbd>K</Kbd> <span className="ml-1">{t.shortcuts}</span>
        </div>
      </header>
      <div className="flex gap-2">
        <Button variant={tab === "pending" ? "primary" : "ghost"} size="sm" onClick={() => setTab("pending")}>
          {t.inboxTabs.pending} · {pending.length}
        </Button>
        <Button variant={tab === "decided" ? "primary" : "ghost"} size="sm" onClick={() => setTab("decided")}>
          {t.inboxTabs.decided}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-mute">{tab === "pending" ? t.nothingToDecide : "—"}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          {list.map((a, i) => (
            <div key={a.id} className={`rounded-[16px] transition ${tab === "pending" && i === focus ? "ring-2 ring-accent" : ""}`} onFocusCapture={() => setFocus(i)} onMouseEnter={() => setFocus(i)}>
              <ApprovalCard approval={a} agentName={ws.agentName} companyId={company.id} t={t} onDecided={ws.refresh} />
            </div>
          ))}
        </div>
      )}
      {tab === "pending" && pending.length > 0 && <p className="m-0 text-[13px] text-faint">{fill(t.waitingCount, { n: pending.length })}</p>}
    </div>
  );
}
