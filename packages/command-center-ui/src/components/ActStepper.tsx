import { Check, Loader2, Play, RotateCcw, ShieldCheck, SquareTerminal } from 'lucide-react';
import type { RunState } from '../types';

export const STEPS = [
  { n: 1, label: 'Set the rules' },
  { n: 2, label: 'Choose a plan' },
  { n: 3, label: 'Issue the card' },
  { n: 4, label: 'Stop the overcharge' },
  { n: 5, label: 'Pay safely' },
];

export function ActStepper(props: {
  state: RunState | null;
  view: number;
  onView: (n: number) => void;
  onRunDemo: () => void;
  onReset: () => void;
  onOpenDrawer: () => void;
  eventCount: number;
  demoRunning: boolean;
}) {
  const { state, view } = props;
  const act = state?.act ?? 0;
  const busy = Boolean(state?.busy) || props.demoRunning;
  const quarantined = state?.machineState === 'QUARANTINED_FROZEN';
  return (
    <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-flame-500 text-ink-950">
            <ShieldCheck className="h-5 w-5" strokeWidth={2.5} />
          </div>
          <div className="text-[15px] font-bold tracking-tight">IntentGuard</div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <ModeChip state={state} />
          <button className="btn-ghost relative" onClick={props.onOpenDrawer} title="See every API call, signature and decision">
            <SquareTerminal className="h-4 w-4" />
            <span className="hidden sm:inline">Under the hood</span>
            {props.eventCount > 0 && <span className="rounded-full bg-ink-600 px-1.5 font-mono text-[10px]">{props.eventCount}</span>}
          </button>
          <button className="btn-ghost" onClick={props.onReset} disabled={busy} title="Start over">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button className="btn-primary" onClick={props.onRunDemo} disabled={busy}>
            {props.demoRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" fill="currentColor" />}
            <span className="hidden sm:inline">{props.demoRunning ? 'Playing…' : 'Auto-play demo'}</span>
          </button>
        </div>

        <nav className="order-last w-full">
          <ol className="grid grid-cols-5 gap-1.5">
            {STEPS.map((s) => {
              const reachable = s.n <= Math.max(1, act + 1) && !busy;
              // Each screen ends with the action that starts the next act, so a step is
              // complete once the following act has run (steps 1 and 5 complete on their own act).
              const done = s.n === 1 ? act >= 1 : s.n === 5 ? act >= 5 : act > s.n;
              const active = view === s.n;
              const alarm = s.n === 4 && act >= 4;
              return (
                <li key={s.n}>
                  <button
                    disabled={!reachable}
                    onClick={() => props.onView(s.n)}
                    className={['group flex w-full flex-col gap-1.5 rounded-lg px-1 pb-1 pt-0.5 text-left transition', reachable ? 'cursor-pointer' : 'cursor-default opacity-50'].join(' ')}
                  >
                    <span
                      className={[
                        'h-1 w-full rounded-full transition-colors',
                        active ? (alarm && quarantined ? 'bg-status-critical' : 'bg-flame-500') : done ? 'bg-status-good/70' : alarm && quarantined ? 'bg-status-critical/60' : 'bg-ink-700',
                      ].join(' ')}
                    />
                    <span className="flex items-center gap-1.5">
                      <span
                        className={[
                          'grid h-4 w-4 shrink-0 place-items-center rounded-full font-mono text-[9px] font-bold',
                          done ? 'bg-status-good text-ink-950' : active ? 'bg-flame-500 text-ink-950' : 'bg-ink-700 text-ink-300',
                        ].join(' ')}
                      >
                        {done ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : s.n}
                      </span>
                      <span className={`truncate text-[12px] font-medium ${active ? 'text-ink-100' : 'hidden text-ink-400 group-hover:text-ink-200 sm:inline'}`}>{s.label}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>
    </header>
  );
}

function ModeChip({ state }: { state: RunState | null }) {
  const rail = state?.rail.mode;
  const llm = state?.llm.engine;
  const live = rail === 'LIVE';
  const label = !rail ? 'Airwallex: not connected' : live ? 'Airwallex: live sandbox' : 'Airwallex: emulator';
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] md:inline-flex ${live ? 'border-status-good/40 text-status-good' : 'border-ink-600 text-ink-300'}`}
      title={`${state?.rail.note ?? ''}${llm ? ` · Claude: ${llm === 'claude' ? state?.llm.model : 'offline templates'}` : ''}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-status-good' : rail ? 'bg-status-warn' : 'bg-ink-500'}`} />
      {label}
      {llm && <span className="text-ink-500">· AI: {llm === 'claude' ? state?.llm.model : 'templates'}</span>}
    </span>
  );
}
