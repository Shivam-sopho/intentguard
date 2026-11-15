import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { RunState, TelemetryEvent } from '../types';
import { LiveTelemetryConsole } from './LiveTelemetryConsole';
import { VisaTapPassport } from './VisaTapPassport';

/** Right-hand slide-over with the raw evidence: API calls, signatures, state transitions. */
export function TechDrawer({ open, onClose, state, events, onProbe }: { open: boolean; onClose: () => void; state: RunState | null; events: TelemetryEvent[]; onProbe: () => void }) {
  const [tab, setTab] = useState<'activity' | 'identity' | 'states'>('activity');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`} onClick={onClose} />
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[640px] flex-col border-l border-ink-700 bg-ink-900 shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        aria-hidden={!open}
      >
        <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold">Under the hood</div>
            <div className="text-[12px] text-ink-400">
              {state?.rail.mode === 'LIVE' ? 'Live calls to api.sandbox.airwallex.com' : state?.rail.mode === 'EMULATOR' ? 'Offline emulator (no Airwallex keys set)' : 'Not connected yet'}
            </div>
          </div>
          <button className="btn-ghost ml-auto p-2" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex gap-1 border-b border-ink-700 px-3 py-2">
          {([
            ['activity', `Live activity (${events.length})`],
            ['identity', 'Agent identity'],
            ['states', 'State machine'],
          ] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-[13px] ${tab === k ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {tab === 'activity' && <LiveTelemetryConsole events={events} />}
          {tab === 'identity' && (
            <div className="overflow-y-auto">
              <VisaTapPassport state={state} onProbe={onProbe} />
            </div>
          )}
          {tab === 'states' && (
            <div className="space-y-1 overflow-y-auto p-4 font-mono text-[12px]">
              <div className="mb-2 font-sans text-[13px] text-ink-400">Every transition is checked by code. Illegal jumps are rejected.</div>
              <div className="text-ink-300">DRAFT</div>
              {(state?.history ?? []).map((h, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-ink-500">→</span>
                  <span className={h.to === 'QUARANTINED_FROZEN' ? 'text-status-critical' : h.to === 'SETTLED' ? 'text-status-good' : 'text-ink-100'}>{h.to}</span>
                  <span className="text-ink-500">{h.at.slice(11, 19)}</span>
                  {h.reason && <span className="truncate text-ink-400">{h.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
