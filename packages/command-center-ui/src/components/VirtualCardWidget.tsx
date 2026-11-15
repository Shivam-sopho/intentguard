import { Lock, Snowflake, CheckCircle2, CreditCard } from 'lucide-react';
import type { RunState } from '../types';
import { usd } from '../useRun';

export function VirtualCardWidget({ state, hideLimits = false }: { state: RunState | null; hideLimits?: boolean }) {
  const c = state?.card;
  const settled = state?.machineState === 'SETTLED';
  const frozen = c?.card.card_status === 'INACTIVE';
  const status = !c ? 'NOT ISSUED' : settled ? 'SETTLED' : frozen ? 'FROZEN · QUARANTINED' : c.card.card_status;
  const tone = !c ? 'idle' : settled ? 'good' : frozen ? 'critical' : 'active';
  const limits = (state?.settlement?.limitsAfter ?? c?.limits)?.limits ?? [];
  const ctrl = c?.card.authorization_controls;

  return (
    <div className={hideLimits ? '' : 'space-y-3 p-3'}>
      <div
        className={[
          'relative overflow-hidden rounded-2xl border p-4 transition-all duration-500',
          tone === 'critical' ? 'border-status-critical/70 pulse-critical' : tone === 'good' ? 'border-status-good/50' : 'border-ink-600',
        ].join(' ')}
        style={{
          background:
            tone === 'critical'
              ? 'linear-gradient(135deg,#2a1214 0%,#1a1b21 60%,#0e3a5b 140%)'
              : tone === 'idle'
                ? 'linear-gradient(135deg,#1a1b21,#14151a)'
                : 'linear-gradient(135deg,#ff6a1f 0%,#c2410c 38%,#1a1b21 100%)',
          aspectRatio: '1.586',
          maxHeight: 210,
        }}
      >
        {frozen && <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(208,59,59,.10)_0_8px,transparent_8px_16px)]" />}
        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/80">Airwallex · Virtual</div>
              <div className="text-[12px] text-white/70">{c?.card.nick_name ?? 'Single-purpose procurement card'}</div>
            </div>
            <StatusBadge status={status} tone={tone} />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-7 w-10 rounded-md bg-gradient-to-br from-yellow-200/80 to-yellow-600/70" />
            {frozen ? <Snowflake className="h-5 w-5 text-sky-300" /> : <CreditCard className="h-5 w-5 text-white/60" />}
          </div>
          <div>
            <div className="font-mono text-[17px] tracking-[0.12em] text-white">{c ? c.card.card_number.replace(/(.{4})/g, '$1 ').trim() : '•••• •••• •••• ••••'}</div>
            <div className="mt-1 flex items-end justify-between">
              <div className="font-mono text-[11px] text-white/70">
                {ctrl ? `MCC ${ctrl.allowed_merchant_categories?.join(',')} · ${ctrl.allowed_currencies?.join(',')} · ${ctrl.allowed_transaction_count}` : 'controls pending'}
              </div>
              <div className="text-[18px] font-black italic tracking-tight text-white">VISA</div>
            </div>
          </div>
        </div>
      </div>

      {!hideLimits && (<div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
        <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          <span className="flex items-center gap-1"><Lock className="h-3.5 w-3.5" /> Rail-enforced limits</span>
          <span className="font-mono normal-case tracking-normal text-ink-500">GET /issuing/cards/{'{id}'}/limits</span>
        </div>
        {limits.length === 0 ? (
          <div className="text-[12px] text-ink-400">Issued in Act 3 with an inclusive per-transaction ceiling equal to the approved charge.</div>
        ) : (
          <div className="space-y-2">
            {limits.map((l) => {
              const used = l.amount - l.remaining;
              const pct = l.amount ? Math.min(100, (used / l.amount) * 100) : 0;
              return (
                <div key={l.interval}>
                  <div className="flex justify-between font-mono text-[12px]">
                    <span className="text-ink-300">{l.interval}</span>
                    <span>
                      <span className="text-ink-100">{usd(l.remaining)}</span>
                      <span className="text-ink-500"> / {usd(l.amount)} ≤ inclusive</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full rounded-full bg-series-monthly transition-all duration-700" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
            <div className="pt-1 font-mono text-[11px] text-ink-400">$1,000.00 passes · $1,000.01 declines (LIMIT_EXCEEDED)</div>
          </div>
        )}
      </div>)}
    </div>
  );
}

function StatusBadge({ status, tone }: { status: string; tone: string }) {
  const cls =
    tone === 'critical'
      ? 'bg-status-critical text-white'
      : tone === 'good'
        ? 'bg-status-good text-ink-950'
        : tone === 'active'
          ? 'bg-white/90 text-ink-950'
          : 'bg-ink-700 text-ink-300';
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide ${cls}`}>
      {tone === 'good' ? <CheckCircle2 className="h-3 w-3" /> : tone === 'critical' ? <Snowflake className="h-3 w-3" /> : null}
      {status}
    </span>
  );
}
