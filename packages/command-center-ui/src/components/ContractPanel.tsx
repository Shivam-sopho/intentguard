import { useState } from 'react';
import { BadgeCheck, FileText, ShieldAlert, Sparkles } from 'lucide-react';
import type { RunState } from '../types';
import { usd } from '../useRun';

export function ContractPanel({ state }: { state: RunState | null }) {
  const [showDoc, setShowDoc] = useState(false);
  const c = state?.contract;
  if (!c) {
    return (
      <div className="p-4 text-sm text-ink-400">
        <div className="mb-1 font-medium text-ink-200">CloudScale Enterprise APM · 10 seats</div>
        In Act 2 the agent fetches the vendor's order form over a Visa TAP <span className="font-mono text-ink-300">agent-browser-auth</span> request, and Claude extracts the pricing and risk clauses.
      </div>
    );
  }
  const x = c.parsed.extraction;
  const g = c.parsed.grounding;
  /**
   * Highlight every quote Claude cited, tolerating PDF line wraps: whitespace in a quote matches
   * any run of whitespace, and a hyphen may be followed by a line break ("12-\nmonth").
   */
  const highlight = (doc: string) => {
    const quotes = [...x.options.map((o) => o.source_quote), ...x.risk_clauses.map((r) => r.source_quote)].filter((q) => q && q.trim().length > 3);
    if (!quotes.length) return doc;
    const pattern = (q: string) =>
      q
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/[\u2018\u2019']/g, "['\u2018\u2019]")
        .replace(/-\s*/g, '-\\s*')
        .replace(/\s+/g, '\\s+');
    const re = new RegExp(`(${quotes.map(pattern).join('|')})`, 'gi');
    const parts = doc.split(re);
    return parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-flame-500/25 px-0.5 text-flame-400">{part}</mark> : part));
  };
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`chip ${c.parsed.trace.engine === 'claude' ? 'border-flame-500/50 text-flame-400' : 'border-status-warn/50 text-status-warn'}`}>
          <Sparkles className="h-3 w-3" /> {c.parsed.trace.engine === 'claude' ? `${c.parsed.trace.model}${c.parsed.trace.via === 'claude-code' ? ' via Claude Code' : ''} · ${(c.parsed.trace.ms / 1000).toFixed(1)}s` : 'offline parser'}
        </span>
        <span className={`chip ${g.ok ? 'border-status-good/40 text-status-good' : 'border-status-critical/60 text-status-critical'}`}>
          <BadgeCheck className="h-3 w-3" /> {g.ok ? 'grounded in source' : 'grounding failed'}
        </span>
        <button className="chip ml-auto border-ink-600 text-ink-300 hover:text-ink-100" onClick={() => setShowDoc((s) => !s)}>
          <FileText className="h-3 w-3" /> {showDoc ? 'hide' : 'view'} order form
        </button>
      </div>

      {showDoc && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed text-ink-200 scrollbar-thin">{highlight(c.document)}</pre>}

      <div className="grid grid-cols-2 gap-2">
        {x.options.map((o) => (
          <div key={o.id} className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-ink-400">{o.cadence === 'ANNUAL' ? 'Option A · Annual' : 'Option B · Monthly'}</div>
            <div className="font-mono text-[15px] font-semibold">{usd(o.charge_amount)}<span className="text-[11px] font-normal text-ink-400">{o.cadence === 'MONTHLY' ? '/mo' : ' upfront'}</span></div>
            <div className="font-mono text-[11px] text-ink-400">12-mo {usd(o.annualized_cost)} · {o.refundable ? 'refundable' : 'non-refundable'}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400"><ShieldAlert className="h-3.5 w-3.5" /> Risk clauses flagged</div>
        <ul className="space-y-1">
          {x.risk_clauses.map((r) => (
            <li key={r.clause_ref + r.kind} className={`flex gap-2 rounded-md px-2 py-1 text-[12px] ${r.kind === 'ONBOARDING_FEE' ? 'bg-status-warn/10 text-ink-100' : 'text-ink-300'}`}>
              <span className="font-mono text-ink-400">§{r.clause_ref}</span>
              <span className="flex-1">{r.summary}</span>
              {r.max_amount ? <span className="font-mono text-status-warn">≤{usd(r.max_amount)}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
