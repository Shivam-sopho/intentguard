import { AlertTriangle, CalendarClock, TrendingDown } from 'lucide-react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RunState } from '../types';
import { usd, usdK } from '../useRun';

const C = {
  monthly: '#3987e5',
  annual: '#d95926',
  floor: '#a3a4ad',
  critical: '#d03b3b',
  grid: '#25262e',
  axis: '#7a7b85',
};

export function CashflowChart({ state }: { state: RunState | null }) {
  const g = state?.guardrails;
  const d = state?.plan?.decision;

  if (!g) {
    return <Empty text="Act 1 fetches the live wallet balance and sets the reserve floor." />;
  }
  if (!d) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <div className="text-ink-300">Scheduled obligations (next {g.horizonWeeks} weeks)</div>
        <ul className="space-y-1 font-mono text-[12px]">
          {g.scheduled
            .filter((f) => f.kind !== 'OPEX')
            .map((f) => (
              <li key={f.id} className="flex justify-between">
                <span className="text-ink-300">W{f.week} · {f.label}</span>
                <span className={f.amount < 0 ? 'text-ink-100' : 'text-status-good'}>{f.amount < 0 ? '−' : '+'}{usd(Math.abs(f.amount))}</span>
              </li>
            ))}
          <li className="flex justify-between text-ink-400">
            <span>W1–W{g.horizonWeeks} · Operating expenses</span>
            <span>−$1,000.00 / wk</span>
          </li>
        </ul>
        <div className="pt-2 text-ink-400">Act 2 projects each billing option against these.</div>
      </div>
    );
  }

  const annual = d.projections['ANNUAL_UPFRONT'];
  const monthly = d.projections['MONTHLY'];
  const data = [
    { week: 0, label: 'Today', annual: g.openingBalance, monthly: g.openingBalance },
    ...monthly.weeks.map((w, i) => ({ week: w.week, label: `W${w.week}`, monthly: w.closing, annual: annual?.weeks[i]?.closing, mFlows: w.flows, aFlows: annual?.weeks[i]?.flows })),
  ];
  const values = data.flatMap((r) => [r.annual, r.monthly]).filter((v): v is number => typeof v === 'number');
  const yMin = Math.floor((Math.min(g.reserveFloor, ...values) - 4000) / 2000) * 2000;
  const yMax = Math.ceil((Math.max(...values) + 2000) / 2000) * 2000;
  const breachWeek = annual?.firstBreachWeek;
  const breachRow = breachWeek ? annual.weeks[breachWeek - 1] : null;
  const chosen = d.recommendedOptionId;

  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[12px]">
        <LegendItem color={C.monthly} label="Monthly $1,000/mo" chosen={chosen === 'MONTHLY'} />
        <LegendItem color={C.annual} label="Annual $9,600 upfront" chosen={chosen === 'ANNUAL_UPFRONT'} />
        <span className="flex items-center gap-1.5 text-ink-300">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={C.floor} strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          Reserve floor {usd(g.reserveFloor, 0)}
        </span>
      </div>
      <div className="h-[230px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 14, right: 64, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <ReferenceArea y1={yMin} y2={g.reserveFloor} fill={C.critical} fillOpacity={0.07} ifOverflow="hidden" />
            <XAxis dataKey="label" tick={{ fill: C.axis, fontSize: 11 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis domain={[yMin, yMax]} tickFormatter={usdK} tick={{ fill: C.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
            <ReferenceLine y={g.reserveFloor} stroke={C.floor} strokeDasharray="4 3" strokeWidth={1.5} label={{ value: 'Floor', position: 'right', fill: C.floor, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip floor={g.reserveFloor} />} cursor={{ stroke: '#4a4b55', strokeWidth: 1 }} />
            <Line
              type="linear"
              dataKey="annual"
              stroke={C.annual}
              strokeWidth={chosen === 'ANNUAL_UPFRONT' ? 2.5 : 2}
              strokeOpacity={chosen === 'ANNUAL_UPFRONT' ? 1 : 0.85}
              strokeDasharray={chosen === 'ANNUAL_UPFRONT' ? undefined : '6 3'}
              dot={{ r: 3.5, fill: C.annual, stroke: '#101116', strokeWidth: 2 }}
              activeDot={{ r: 5, stroke: '#101116', strokeWidth: 2 }}
              isAnimationActive
              animationDuration={900}
              label={<EndLabel last={data.length - 1} text="Annual" color={C.annual} />}
            />
            <Line
              type="linear"
              dataKey="monthly"
              stroke={C.monthly}
              strokeWidth={chosen === 'MONTHLY' ? 2.5 : 2}
              dot={{ r: 3.5, fill: C.monthly, stroke: '#101116', strokeWidth: 2 }}
              activeDot={{ r: 5, stroke: '#101116', strokeWidth: 2 }}
              isAnimationActive
              animationDuration={900}
              label={<EndLabel last={data.length - 1} text="Monthly" color={C.monthly} />}
            />
            {breachRow && (
              <ReferenceDot x={`W${breachRow.week}`} y={breachRow.closing} r={7} fill={C.critical} stroke="#101116" strokeWidth={2} ifOverflow="extendDomain" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {d.verdicts.map((v) => (
          <div key={v.optionId} className={`rounded-lg border px-3 py-2 ${v.safe ? 'border-status-good/30 bg-status-good/5' : 'border-status-critical/40 bg-status-critical/10'}`}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold">{v.optionId === 'MONTHLY' ? 'Monthly' : 'Annual upfront'}</span>
              <span className={`chip ${v.safe ? 'border-status-good/40 text-status-good' : 'border-status-critical/60 text-status-critical'}`}>
                {v.safe ? 'Safe' : <><AlertTriangle className="h-3 w-3" /> Breach W{v.firstBreachWeek}</>}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-ink-300">
              low {usd(v.minBalance)} · W{v.minWeek}
              {!v.safe && <span className="text-status-critical"> · short {usd(v.maxShortfall)}</span>}
            </div>
            <div className="font-mono text-[11px] text-ink-400">12-mo cost {usd(v.annualizedCost)}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1 px-1 text-[11px] text-ink-400">
        <span className="flex items-center gap-1"><TrendingDown className="h-3.5 w-3.5" /> Savings forgone {usd(d.savingsForgone)}/yr to protect the reserve</span>
        {d.upgradeTrigger && (
          <span className="flex items-center gap-1 text-ink-300"><CalendarClock className="h-3.5 w-3.5 text-flame-400" /> {d.upgradeTrigger.condition}</span>
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label, chosen }: { color: string; label: string; chosen: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-ink-200">
      <span className="h-[3px] w-4 rounded-full" style={{ background: color }} />
      {label}
      {chosen && <span className="chip border-status-good/40 text-status-good">chosen</span>}
    </span>
  );
}

function EndLabel(props: { x?: number; y?: number; index?: number; last: number; text: string; color: string }) {
  if (props.index !== props.last || props.x === undefined || props.y === undefined) return null;
  return (
    <text x={props.x + 9} y={props.y + 4} fill="#c9cad1" fontSize={11} fontWeight={600}>
      {props.text}
    </text>
  );
}

function ChartTooltip({ active, payload, floor }: { active?: boolean; payload?: { payload: { label: string; annual?: number; monthly?: number; mFlows?: { label: string; amount: number }[]; aFlows?: { label: string; amount: number; kind: string }[] } }[]; floor: number }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const row = (name: string, color: string, v?: number) =>
    v === undefined ? null : (
      <div className="flex items-center justify-between gap-6">
        <span className="flex items-center gap-1.5 text-ink-300"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{name}</span>
        <span className={`font-mono ${v < floor ? 'text-status-critical' : 'text-ink-100'}`}>{usd(v)}</span>
      </div>
    );
  const saas = r.aFlows?.filter((f) => f.kind === 'SAAS_COMMITMENT') ?? [];
  const other = r.mFlows?.filter((f) => !f.label.includes('charge')) ?? [];
  return (
    <div className="min-w-[220px] rounded-lg border border-ink-600 bg-ink-850/95 px-3 py-2 text-[12px] shadow-xl">
      <div className="mb-1 font-semibold">{r.label === 'Today' ? 'Today (opening)' : `Week ${r.label.slice(1)} close`}</div>
      {row('Monthly', C.monthly, r.monthly)}
      {row('Annual', C.annual, r.annual)}
      <div className="mt-1 flex justify-between border-t border-ink-700 pt-1 text-ink-400">
        <span>Reserve floor</span>
        <span className="font-mono">{usd(floor)}</span>
      </div>
      {(other.length > 0 || saas.length > 0) && (
        <div className="mt-1 space-y-0.5 text-[11px] text-ink-400">
          {other.map((f) => <div key={f.label}>{f.label}: {f.amount < 0 ? '−' : '+'}{usd(Math.abs(f.amount))}</div>)}
          {saas.map((f) => <div key={f.label}>Annual: {f.label} −{usd(Math.abs(f.amount))}</div>)}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid h-[200px] place-items-center px-6 text-center text-sm text-ink-400">{text}</div>;
}
