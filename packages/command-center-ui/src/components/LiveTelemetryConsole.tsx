import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TelemetryEvent } from '../types';

const CHANNEL: Record<TelemetryEvent['channel'], { label: string; cls: string }> = {
  AIRWALLEX: { label: 'AIRWALLEX', cls: 'border-flame-500/50 text-flame-400' },
  MERCHANT: { label: 'MERCHANT', cls: 'border-violet-400/50 text-violet-300' },
  VISA_TAP: { label: 'VISA TAP', cls: 'border-sky-400/50 text-sky-300' },
  CLAUDE: { label: 'CLAUDE', cls: 'border-amber-300/50 text-amber-200' },
  ENGINE: { label: 'ENGINE', cls: 'border-ink-500 text-ink-200' },
  OPERATOR: { label: 'OPERATOR', cls: 'border-emerald-400/50 text-emerald-300' },
};

const LEVEL: Record<TelemetryEvent['level'], string> = {
  info: 'bg-ink-500',
  success: 'bg-status-good',
  warn: 'bg-status-warn',
  error: 'bg-status-critical',
};

export function LiveTelemetryConsole({ events }: { events: TelemetryEvent[] }) {
  const [filter, setFilter] = useState<TelemetryEvent['channel'] | 'ALL'>('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (filter === 'ALL' ? events : events.filter((e) => e.channel === filter)), [events, filter]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-1 border-b border-ink-700 px-3 py-2">
        {(['ALL', 'AIRWALLEX', 'VISA_TAP', 'MERCHANT', 'ENGINE', 'CLAUDE', 'OPERATOR'] as const).map((c) => (
          <button
            key={c}
            onClick={() => setFilter(c)}
            className={`chip ${filter === c ? 'border-flame-500 bg-flame-500/15 text-flame-400' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}
          >
            {c === 'ALL' ? `all ${events.length}` : CHANNEL[c].label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[11.5px] scrollbar-thin"
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {shown.length === 0 && <div className="p-4 text-center font-sans text-sm text-ink-500">Every Airwallex call, TAP signature, engine decision and Claude call streams here.</div>}
        {shown.map((e) => {
          const expanded = open === e.id;
          const hasBody = e.request !== undefined || e.response !== undefined || e.detail !== undefined;
          return (
            <div key={e.id} className={`slide-in rounded-md px-1.5 py-1 ${expanded ? 'bg-ink-800' : 'hover:bg-ink-850'}`}>
              <button className="flex w-full items-start gap-1.5 text-left" onClick={() => hasBody && setOpen(expanded ? null : e.id)}>
                <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL[e.level]}`} />
                <span className="shrink-0 text-ink-500">{e.ts.slice(11, 19)}</span>
                <span className={`chip shrink-0 ${CHANNEL[e.channel].cls}`}>{CHANNEL[e.channel].label}</span>
                {e.mode && <span className={`chip shrink-0 ${e.mode === 'LIVE' ? 'border-status-good/40 text-status-good' : 'border-status-warn/40 text-status-warn'}`}>{e.mode === 'LIVE' ? 'live' : 'emu'}</span>}
                <span className="min-w-0 flex-1 break-words text-ink-100">
                  {e.method && <span className="text-ink-400">{e.method} </span>}
                  {e.path && <span className="text-sky-300">{e.path} </span>}
                  {e.status !== undefined && <span className={e.status >= 400 ? 'text-status-critical' : 'text-status-good'}>{e.status} </span>}
                  {e.ms !== undefined && <span className="text-ink-500">{e.ms}ms </span>}
                  <span className={e.level === 'error' ? 'text-status-critical' : e.level === 'warn' ? 'text-status-warn' : ''}>{e.path ? `· ${e.title}` : e.title}</span>
                </span>
                {hasBody && <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500 transition ${expanded ? 'rotate-90' : ''}`} />}
              </button>
              {expanded && (
                <div className="mt-1 space-y-1 pl-4">
                  {e.request !== undefined && <Json label="request" value={e.request} />}
                  {e.response !== undefined && <Json label="response" value={e.response} />}
                  {e.detail !== undefined && <Json label="detail" value={e.detail} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-500">{label}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-950 p-2 text-[10.5px] leading-snug text-ink-200 scrollbar-thin">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
