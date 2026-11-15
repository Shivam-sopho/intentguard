import { useState, type ReactNode } from 'react';
import { ChevronDown, Loader2, ScrollText } from 'lucide-react';
import type { Narrative, TelemetryEvent } from '../types';

/** Page frame for one step: eyebrow, headline, one-sentence subtitle, body, action bar. */
export function Screen(props: { step: number; title: ReactNode; subtitle: ReactNode; tone?: 'default' | 'critical' | 'good'; children: ReactNode; actions?: ReactNode }) {
  const tone = props.tone ?? 'default';
  return (
    <section className="slide-in mx-auto w-full max-w-4xl px-4 pb-28 pt-8 sm:px-6">
      <div className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${tone === 'critical' ? 'text-status-critical' : tone === 'good' ? 'text-status-good' : 'text-flame-400'}`}>Step {props.step} of 5</div>
      <h1 className="mt-1.5 text-[28px] font-bold leading-tight tracking-tight sm:text-[32px]">{props.title}</h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-300">{props.subtitle}</p>
      <div className="mt-7 space-y-5">{props.children}</div>
      {props.actions && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-700 bg-ink-950/95 backdrop-blur">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-end gap-3 px-4 py-3 sm:px-6">{props.actions}</div>
        </div>
      )}
    </section>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-ink-700 bg-ink-900/80 p-5 ${className}`}>{children}</div>;
}

export function Details({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-ink-700/70">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] text-ink-300 hover:text-ink-100" onClick={() => setOpen((o) => !o)}>
        {label}
        <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-ink-700/70 p-4">{children}</div>}
    </div>
  );
}

export function NarrativeBlock({ title, n }: { title: string; n?: Narrative }) {
  if (!n) return null;
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900/60 p-5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
        <ScrollText className="h-4 w-4" /> {title}
        <span className="ml-auto">{n.trace.engine === 'claude' ? `Written by ${n.trace.model}` : 'Template (no Claude key set)'}</span>
        {!n.grounded && <span className="text-status-critical">unverified figures: {n.ungroundedFigures.join(', ')}</span>}
      </div>
      <p className="text-[15px] leading-relaxed text-ink-100">{n.text}</p>
    </div>
  );
}

const FRIENDLY_SKIP = /^State /;

/** Shown while an act is running: a plain-language live feed of what the agent is doing. */
export function WorkingPanel({ label, events, since }: { label: string; events: TelemetryEvent[]; since: string | null }) {
  const recent = events.filter((e) => (!since || e.ts >= since) && !FRIENDLY_SKIP.test(e.title)).slice(-7);
  return (
    <Card className="border-flame-500/30">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-flame-400" />
        <div className="text-[15px] font-semibold">{label}</div>
      </div>
      <ul className="mt-4 space-y-2">
        {recent.map((e) => (
          <li key={e.id} className="slide-in flex items-start gap-2 text-[13px] text-ink-300">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${e.level === 'error' ? 'bg-status-critical' : e.level === 'warn' ? 'bg-status-warn' : e.level === 'success' ? 'bg-status-good' : 'bg-ink-500'}`} />
            <span>{e.title}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'critical' }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/80 px-4 py-3">
      <div className="text-[12px] text-ink-400">{label}</div>
      <div className={`mt-0.5 font-mono text-[22px] font-semibold ${tone === 'good' ? 'text-status-good' : tone === 'critical' ? 'text-status-critical' : 'text-ink-100'}`}>{value}</div>
      {sub && <div className="text-[12px] text-ink-400">{sub}</div>}
    </div>
  );
}
