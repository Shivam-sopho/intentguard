import { useEffect, useState } from 'react';
import { AlertOctagon, BadgeCheck, CalendarClock, CheckCircle2, Gavel, Loader2, Play, ScrollText, Sparkles, Zap } from 'lucide-react';
import type { Narrative, RunState } from '../types';
import { usd } from '../useRun';

type Call = (path: string, body?: unknown) => Promise<unknown>;

export function ActionPanel({ state, call, disabled }: { state: RunState | null; call: Call; disabled: boolean }) {
  const [floor, setFloor] = useState<string>('');
  const act = state?.act ?? 0;
  const busy = Boolean(state?.busy) || disabled;
  const run = (p: string, b?: unknown) => call(p, b).catch(() => undefined);
  useEffect(() => {
    if (state?.guardrails) setFloor(String(state.guardrails.reserveFloor));
  }, [state?.guardrails?.reserveFloor]);

  return (
    <div className="space-y-3 p-3">
      {state?.busy && (
        <div className="flex items-center gap-2 rounded-lg border border-flame-500/40 bg-flame-500/10 px-3 py-2 text-[13px] text-flame-400">
          <Loader2 className="h-4 w-4 animate-spin" /> {state.busy}…
        </div>
      )}
      {state?.error && !state.busy && (
        <div className="rounded-lg border border-status-critical/50 bg-status-critical/10 px-3 py-2 text-[12px] text-status-critical">{state.error}</div>
      )}

      {act === 0 && (
        <Step n={1} title="Set the goal and guardrails" body="Buy CloudScale Enterprise APM (10 seats) without ever letting cash drop below the reserve floor over the next 8 weeks.">
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-ink-400">Reserve floor</label>
            <input
              className="w-32 rounded-md border border-ink-600 bg-ink-950 px-2 py-1.5 font-mono text-sm"
              placeholder="auto"
              value={floor}
              onChange={(e) => setFloor(e.target.value.replace(/[^\d.]/g, ''))}
            />
            <button className="btn-primary ml-auto" disabled={busy} onClick={() => run('act1', floor ? { reserveFloor: Number(floor) } : {})}>
              <Play className="h-4 w-4" fill="currentColor" /> Start Act 1
            </button>
          </div>
          <div className="mt-1 text-[11px] text-ink-500">Leave blank for the default: opening balance minus $18,000 ($40,000 on the $58,000 seed).</div>
        </Step>
      )}

      {act === 1 && state?.guardrails && (
        <Step n={2} title="Analyze contract against the 8-week cash projection" body={`Opening ${usd(state.guardrails.openingBalance)} (${state.guardrails.balanceSource}). Floor ${usd(state.guardrails.reserveFloor)}.`}>
          <button className="btn-primary w-full" disabled={busy} onClick={() => run('act2')}>
            <Sparkles className="h-4 w-4" /> Read order form & project cash
          </button>
        </Step>
      )}

      {act === 2 && state?.intent && (
        <Step n={3} title="Human approval bound to exact terms" body="Approving signs the SHA-256 intent hash with the operator's Ed25519 key, then issues a virtual card that can only pay this intent.">
          <div className="mb-2 rounded-lg border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-300">
            <div>merchant {state.intent.intent.merchant.name} · MCC {state.intent.intent.merchant.mcc}</div>
            <div>sku {state.intent.intent.sku} · {state.intent.intent.billing.cadence}</div>
            <div className="text-ink-100">amount {usd(state.intent.intent.billing.amount)} {state.intent.intent.billing.currency}</div>
            <div className="truncate text-flame-400" title={state.intent.intentHash}>sha256 {state.intent.intentHash}</div>
          </div>
          <button className="btn-good w-full" disabled={busy} onClick={() => run('approve')}>
            <BadgeCheck className="h-4 w-4" /> Approve {usd(state.intent.intent.billing.amount)}/mo intent & issue card
          </button>
        </Step>
      )}

      {act === 3 && (
        <Step n={3} title="Checkout, with a live merchant shock" body="The agent opens a TAP-signed checkout for the approved $1,000.00 cart. The vendor's billing system then adds an unapproved fee when it authorizes the card.">
          <button className="btn-danger w-full" disabled={busy} onClick={() => run('shock')}>
            <Zap className="h-4 w-4" fill="currentColor" /> Trigger Act 3 shock: vendor adds $250 fee
          </button>
        </Step>
      )}

      {act === 4 && state?.incident && <Quarantine state={state} busy={busy} onResolve={() => run('resolve')} />}

      {act === 5 && state?.settlement && <Settled state={state} />}

      {state?.approval && (
        <div className="flex items-center gap-2 rounded-md border border-ink-700 px-2.5 py-1.5 text-[11px] text-ink-400">
          <Gavel className="h-3.5 w-3.5 text-status-good" />
          Approved by <span className="text-ink-200">{state.approval.approver}</span> · Ed25519 {state.approval.verified ? 'valid' : 'invalid'}
          {state.reapproval && <span className="ml-auto text-status-good">re-approved after quarantine</span>}
        </div>
      )}
      <StateTrail state={state} />
    </div>
  );
}

function Step({ n, title, body, children }: { n: number; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="slide-in rounded-xl border border-flame-500/30 bg-gradient-to-b from-flame-500/[0.07] to-transparent p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-flame-400">Act {n} · next action</div>
      <div className="mt-0.5 text-[14px] font-semibold">{title}</div>
      <p className="mb-3 mt-1 text-[12px] leading-relaxed text-ink-300">{body}</p>
      {children}
    </div>
  );
}

function Quarantine({ state, busy, onResolve }: { state: RunState; busy: boolean; onResolve: () => void }) {
  const inc = state.incident!;
  const v = inc.verification;
  const order = state.checkout?.order;
  return (
    <div className="slide-in space-y-2 rounded-xl border border-status-critical/60 bg-status-critical/10 p-3">
      <div className="flex items-center gap-2 text-status-critical">
        <AlertOctagon className="h-5 w-5" />
        <span className="text-[14px] font-bold uppercase tracking-wide">Quarantined: intent hash mismatch</span>
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[12px]">
        <div className="rounded-lg border border-status-good/30 bg-ink-950/60 p-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">Approved</div>
          <div className="text-[15px] font-semibold text-status-good">{usd(state.intent?.intent.billing.amount)}</div>
          <div className="truncate text-[10px] text-ink-400">{v.approvedBindingHash.slice(0, 20)}…</div>
        </div>
        <div className="rounded-lg border border-status-critical/40 bg-ink-950/60 p-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">Attempted</div>
          <div className="text-[15px] font-semibold text-status-critical">{usd(order?.charged_amount)}</div>
          <div className="truncate text-[10px] text-ink-400">{v.observedBindingHash.slice(0, 20)}…</div>
        </div>
      </div>
      <ul className="space-y-0.5 font-mono text-[11.5px]">
        {v.unapprovedLineItems.map((li) => (
          <li key={li.sku} className="text-status-critical">+ {usd(li.amount)} {li.description} [unapproved]</li>
        ))}
        <li className="text-ink-200">Rail: <span className="text-status-critical">{inc.failureReason}</span> → FAILED (no funds moved)</li>
        <li className="text-ink-200">Card → <span className="text-status-critical">{inc.cardStatusAfter}</span> via POST /issuing/cards/{'{id}'}/update</li>
        {inc.retry && <li className="text-ink-200">Separate fee retry: <span className="text-status-critical">{inc.retry.failure_reason ?? inc.retry.outcome}</span></li>}
        {state.checkout?.railAgreesWithPolicy === false && <li className="text-status-warn">Rail decision differed from policy prediction; flagged</li>}
      </ul>
      <NarrativeBlock title="Incident report" n={inc.narrative} />
      <button className="btn-good w-full" disabled={busy} onClick={onResolve}>
        <Gavel className="h-4 w-4" /> Enforce approved contract ($1,000.00): vendor waives fee
      </button>
    </div>
  );
}

function Settled({ state }: { state: RunState }) {
  const s = state.settlement!;
  const d = state.plan?.decision;
  const chosen = d?.verdicts.find((v) => v.optionId === d.recommendedOptionId);
  return (
    <div className="slide-in space-y-2 rounded-xl border border-status-good/50 bg-status-good/10 p-3">
      <div className="flex items-center gap-2 text-status-good">
        <CheckCircle2 className="h-5 w-5" />
        <span className="text-[14px] font-bold uppercase tracking-wide">Verified settlement</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Kpi label="Settled" value={usd(s.order.capture ? state.intent?.intent.billing.amount : 0)} />
        <Kpi label="Unauthorized" value="$0.00" />
        <Kpi label="W7 low point" value={usd(chosen?.minBalance)} />
      </div>
      <div className="font-mono text-[11px] text-ink-300">
        order {s.order.order_id} · CLEARING + APPROVED · MONTHLY remaining {usd(s.limitsAfter.limits.find((l) => l.interval === 'MONTHLY')?.remaining)}
      </div>
      {state.triggers.map((t) => (
        <div key={t.id} className="flex items-start gap-1.5 rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1.5 text-[11.5px] text-ink-300">
          <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-flame-400" /> <span><span className="text-ink-100">W{t.week} trigger:</span> {t.condition}</span>
        </div>
      ))}
      <NarrativeBlock title="Audit note" n={s.narrative} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-1 py-1.5">
      <div className="font-mono text-[14px] font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-ink-400">{label}</div>
    </div>
  );
}

export function NarrativeBlock({ title, n }: { title: string; n?: Narrative }) {
  if (!n) return null;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
        <ScrollText className="h-3.5 w-3.5" /> {title}
        <span className={`chip ml-auto normal-case ${n.trace.engine === 'claude' ? 'border-flame-500/50 text-flame-400' : 'border-status-warn/50 text-status-warn'}`}>
          {n.trace.engine === 'claude' ? n.trace.model : 'template'}
        </span>
        <span className={`chip normal-case ${n.grounded ? 'border-status-good/40 text-status-good' : 'border-status-critical/50 text-status-critical'}`}>
          {n.grounded ? 'figures grounded' : `ungrounded: ${n.ungroundedFigures.join(', ')}`}
        </span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-200">{n.text}</p>
    </div>
  );
}

function StateTrail({ state }: { state: RunState | null }) {
  const h = state?.history ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-ink-500">
      <span className="text-ink-400">state</span>
      <span className="rounded bg-ink-800 px-1 py-0.5 text-ink-300">DRAFT</span>
      {h.map((t, i) => (
        <span key={i} className="flex items-center gap-1">
          →
          <span className={`rounded px-1 py-0.5 ${t.to === 'QUARANTINED_FROZEN' ? 'bg-status-critical/20 text-status-critical' : t.to === 'SETTLED' ? 'bg-status-good/20 text-status-good' : 'bg-ink-800 text-ink-300'}`}>{t.to}</span>
        </span>
      ))}
    </div>
  );
}
