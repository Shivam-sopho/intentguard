import { Check, Loader2, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import type { RunState } from '../types';

const ACTS = [
  { n: 1, label: 'Guardrails', sub: 'Live balance + reserve floor' },
  { n: 2, label: '8-wk plan', sub: 'Contract × cash projection' },
  { n: 3, label: 'Provision & shock', sub: 'Card controls + TAP checkout' },
  { n: 4, label: 'Quarantine', sub: 'Decline → hash diff → freeze' },
  { n: 5, label: 'Settlement', sub: 'Re-approve → CLEARING' },
];

export function ActStepper({ state, onRunDemo, onReset, demoRunning, connected }: { state: RunState | null; onRunDemo: () => void; onReset: () => void; demoRunning: boolean; connected: boolean }) {
  // Act 3 spans provisioning AND the shock; it is only complete once the shock ran (act 4).
  const act = state?.act === 3 ? 2 : state?.act ?? 0;
  const quarantined = state?.machineState === 'QUARANTINED_FROZEN';
  return (
    <header className="border-b border-ink-700 bg-ink-900/90 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-flame-500 text-ink-950">
            <ShieldCheck className="h-5 w-5" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[15px] font-bold leading-tight tracking-tight">IntentGuard</div>
            <div className="text-[11px] leading-tight text-ink-400">Liquidity-aware procurement agent</div>
          </div>
        </div>

        <ol className="order-last flex w-full min-w-0 items-center gap-1.5 overflow-x-auto scrollbar-thin xl:order-none xl:w-auto xl:flex-1">
          {ACTS.map((a, i) => {
            const done = act >= a.n && !(a.n === 4 && quarantined && act === 4);
            const current = act + 1 === a.n || (a.n === 4 && quarantined);
            const busy = Boolean(state?.busy) && act + 1 === a.n;
            const alarm = a.n === 4 && quarantined;
            return (
              <li key={a.n} className="flex items-center gap-1.5">
                <div
                  className={[
                    'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition',
                    alarm ? 'border-status-critical/70 bg-status-critical/15' : done ? 'border-ink-600 bg-ink-800' : current ? 'border-flame-500/60 bg-flame-500/10' : 'border-ink-700 bg-transparent',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold',
                      alarm ? 'bg-status-critical text-white' : done ? 'bg-status-good text-ink-950' : current ? 'bg-flame-500 text-ink-950' : 'bg-ink-700 text-ink-300',
                    ].join(' ')}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : done && !alarm ? <Check className="h-3 w-3" strokeWidth={3} /> : a.n}
                  </span>
                  <div className="whitespace-nowrap">
                    <div className="text-[12px] font-semibold leading-tight"><span className="hidden min-[1800px]:inline">Act {a.n}: </span>{a.label}</div>
                    <div className="hidden text-[10px] leading-tight text-ink-400 min-[1900px]:block">{a.sub}</div>
                  </div>
                </div>
                {i < ACTS.length - 1 && <div className={`h-px w-3 ${act > a.n ? 'bg-status-good' : 'bg-ink-600'}`} />}
              </li>
            );
          })}
        </ol>

        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <ModeBadges state={state} connected={connected} />
          <button className="btn-ghost" onClick={onReset} disabled={demoRunning || Boolean(state?.busy)} title="Reset run">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button className="btn-primary" onClick={onRunDemo} disabled={demoRunning || Boolean(state?.busy)}>
            {demoRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" fill="currentColor" />}
            Run full 5-act demo
          </button>
        </div>
      </div>
    </header>
  );
}

function ModeBadges({ state, connected }: { state: RunState | null; connected: boolean }) {
  const rail = state?.rail.mode;
  return (
    <div className="hidden items-center gap-1.5 xl:flex">
      <span className={`chip ${connected ? 'border-status-good/40 text-status-good' : 'border-status-critical/50 text-status-critical'}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-status-good' : 'bg-status-critical'}`} />
        {connected ? 'stream' : 'offline'}
      </span>
      <span
        className={`chip ${rail === 'LIVE' ? 'border-status-good/40 text-status-good' : rail === 'EMULATOR' ? 'border-status-warn/50 text-status-warn' : 'border-ink-600 text-ink-400'}`}
        title={state?.rail.note}
      >
        Airwallex · {rail === 'LIVE' ? 'live sandbox' : rail === 'EMULATOR' ? 'emulator' : '—'}
      </span>
      <span className={`chip ${state?.llm.engine === 'claude' ? 'border-flame-500/50 text-flame-400' : 'border-status-warn/50 text-status-warn'}`}>
        {state?.llm.engine === 'claude' ? state.llm.model : 'LLM offline'}
      </span>
    </div>
  );
}
