import { useEffect, useState } from "react";
import { api, type Artifact } from "../api";
import { Card, Chip, EmptyState, timeAgo } from "../ui";
import type { Workspace } from "../App";

/** Everything the agents produced, across every task: open a file, follow a link, read a decision. */
export function ArtifactsView({ ws }: { ws: Workspace }) {
  const { t, company } = ws;
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .artifacts(company.id)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [company.id]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!items) return <p className="text-sm text-mute">…</p>;
  if (items.length === 0) return <EmptyState>{t.noArtifacts}</EmptyState>;

  return (
    <Card className="p-4">
      <p className="m-0 mb-3 text-[13px] text-mute">{t.artifactsSub}</p>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {items.map((a) => {
          const path = a.ref.replace(/^\.?\//, "");
          const isFile = a.kind === "file" && path.length > 0;
          const isLink = a.kind === "link" && /^https?:\/\//.test(a.ref);
          return (
            <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]">
              <Chip tone={a.kind === "file" ? "info" : a.kind === "decision" ? "warn" : "mute"}>{a.kind}</Chip>
              {isFile ? (
                <a href={api.taskFileUrl(a.taskId, path)} target="_blank" rel="noopener" className="min-w-0 truncate font-bold">
                  {a.title}
                </a>
              ) : isLink ? (
                <a href={a.ref} target="_blank" rel="noopener" className="min-w-0 truncate font-bold">
                  {a.title}
                </a>
              ) : (
                <span className="min-w-0 truncate font-bold">{a.title}</span>
              )}
              {isFile && (
                <a href={api.taskFileUrl(a.taskId, path, true)} className="shrink-0 text-[12px] font-bold text-accent-text no-underline">
                  {t.download}
                </a>
              )}
              {a.summary && <span className="min-w-0 basis-full truncate text-mute sm:basis-auto sm:flex-1">{a.summary}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-faint">
                <span>{a.by}</span>
                <button type="button" onClick={() => ws.go("work", a.taskId)} className="text-accent-text">
                  {a.taskTitle}
                </button>
                <span>{timeAgo(a.createdAt, t)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
