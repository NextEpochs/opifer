/** Shared building blocks of the interface: avatars, chips, buttons, cards, inputs. */

import type { ReactNode } from "react";
import type { AgentActivity } from "./api";
import type { Strings } from "./i18n";

/** A stable colour per name, from a small palette that reads on both themes. */
const AVATAR_COLOURS = ["#A855F7", "#06B6D4", "#10B981", "#F97316", "#EC4899", "#3B82F6", "#EAB308", "#14B8A6"];

export function colourFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]![0] : parts[0]?.[1];
  return `${first}${second ?? ""}`.toUpperCase();
}

export function Avatar({ name, size = 34, colour, ring }: { name: string; size?: number; colour?: string; ring?: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-white"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size / 2.6)), background: colour ?? colourFor(name), boxShadow: ring ? `0 0 0 2px var(--o-card), 0 0 0 4px ${ring}` : undefined }}
    >
      {initials(name)}
    </span>
  );
}

export type Tone = "ok" | "warn" | "danger" | "info" | "accent" | "mute";

const toneCls: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent-text",
  mute: "bg-raised text-ink-2",
};

export function Chip({ tone = "mute", dot, pulse, children, className = "" }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${toneCls[tone]} ${className}`}>
      {dot && <span className={`h-2 w-2 rounded-full bg-current ${pulse ? "pulse" : ""}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

export function activityTone(activity: AgentActivity): Tone {
  switch (activity) {
    case "working":
      return "ok";
    case "waiting":
      return "warn";
    case "stopped":
      return "danger";
    case "paused":
      return "mute";
    default:
      return "mute";
  }
}

export function ActivityChip({ activity, t }: { activity: AgentActivity; t: Strings }) {
  return (
    <Chip tone={activityTone(activity)} dot pulse={activity === "working"}>
      {t.activity[activity]}
    </Chip>
  );
}

type ButtonVariant = "primary" | "ghost" | "soft" | "danger";

const buttonVariant: Record<ButtonVariant, string> = {
  primary: "accent-gradient text-white shadow-[0_6px_20px_-8px_rgba(168,85,247,.8)] hover:brightness-110",
  ghost: "border border-line-strong bg-transparent text-ink hover:bg-hover",
  soft: "bg-raised text-ink hover:bg-hover",
  danger: "bg-danger-soft text-danger hover:brightness-110",
};

export function Button({
  variant = "soft",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" | "lg" }) {
  const sizeCls = size === "sm" ? "h-9 px-3 text-[13px]" : size === "lg" ? "h-12 px-5 text-[15px]" : "h-10 px-4 text-sm";
  return <button type={type} className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-bold transition disabled:opacity-50 ${sizeCls} ${buttonVariant[variant]} ${className}`} {...rest} />;
}

export function Card({ children, className = "", ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`rounded-card border border-line bg-card shadow-card ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex items-center gap-2.5 px-[18px] pt-4">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {children}
      {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
    </header>
  );
}

export const inputCls =
  "w-full rounded-control border border-line-strong bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent-soft";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} min-h-20 ${props.className ?? ""}`} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-block rounded-md border border-line-strong bg-raised px-1.5 py-0.5 font-sans text-[11px] font-bold text-mute">{children}</kbd>;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="block whitespace-pre-wrap rounded-[10px] border border-line bg-bg px-3 py-2.5 font-mono text-[12.5px] text-ink">{children}</code>;
}

/** Three-state segmented control (Auto / Ask / Off, Simple / Advanced, …). */
export function Segmented<T extends string>({ value, options, onChange, label, className = "" }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="group" aria-label={label} className={`flex gap-1 rounded-control bg-raised p-1 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-[9px] px-2 py-1.5 text-[13px] font-bold transition ${value === o.value ? "bg-hover text-ink shadow-[0_1px_2px_rgba(0,0,0,.4)]" : "text-mute hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Currency formatting; tiny amounts keep enough decimals to be visible. */
export function money(amount: number, currency = "EUR", digits = 2): string {
  const small = amount !== 0 && Math.abs(amount) < 0.01 && digits <= 2;
  const fraction = small ? 4 : digits;
  return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: Math.min(fraction, 2), maximumFractionDigits: fraction }).format(amount);
}

export function timeAgo(iso: string, t: Strings): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return t.ago.now;
  if (minutes < 60) return t.ago.m.replace("{n}", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.ago.h.replace("{n}", String(hours));
  return t.ago.d.replace("{n}", String(Math.round(hours / 24)));
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-[18px] pb-4 pt-2 text-sm text-mute">{children}</p>;
}
