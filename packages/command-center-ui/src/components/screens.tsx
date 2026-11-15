import { useEffect, useState } from 'react';
import {
  AlertOctagon,
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Eye,
  FileWarning,
  Gavel,
  Lock,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Snowflake,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { RunState, TelemetryEvent } from '../types';
import { usd } from '../useRun';
import { CashflowChart } from './CashflowChart';
import { ContractPanel } from './ContractPanel';
import { VirtualCardWidget } from './VirtualCardWidget';
import { VisaTapPassport } from './VisaTapPassport';
import { Card, Details, NarrativeBlock, Screen, Stat, WorkingPanel } from './ui';

export interface ScreenProps {
  state: RunState;
  call: (path: string, body?: unknown) => Promise<unknown>;
  busy: boolean;
  working: boolean;
  events: TelemetryEvent[];
  busySince: string | null;
  goTo: (n: number) => void;
  openDrawer: () => void;
}

const run = (p: ScreenProps, path: string, body?: unknown) => p.call(path, body).catch(() => undefined);

function ErrorNote({ state }: { state: RunState }) {
  if (!state.error || state.busy) return null;
  return <div className="rounded-xl border border-status-critical/50 bg-status-critical/10 px-4 py-3 text-[13px] text-status-critical">{state.error}</div>;
}

// ---------------------------------------------------------------------------
// Step 1 - Set the rules
// ---------------------------------------------------------------------------

export function RulesScreen(p: ScreenProps) {
  const { state } = p;
  const g = state.guardrails;
  const [floor, setFloor] = useState('');
  const started = state.act >= 1 && g;

  if (p.working) {
    return (
      <Screen step={1} title="Connecting to your account…" subtitle="The agent is reading your balance and upcoming bills.">
        <WorkingPanel label="Reading your Airwallex balance" events={p.events} since={p.busySince} />
      </Screen>
    );
  }

  if (!started) {
    return (
      <Screen
        step={1}
        title="Buy software without risking your cash"
        subtitle="You want a 10-seat CloudScale subscription. The agent will shop for it, but it must never let your bank balance fall below a safety floor."
        actions={
          <button className="btn-primary px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'act1', floor ? { reserveFloor: Number(floor) } : {})}>
            Connect & set the rules <ArrowRight className="h-4 w-4" />
          </button>
        }
      >
        <ErrorNote state={state} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <div className="flex items-center gap-2 text-[13px] text-ink-400"><CircleDollarSign className="h-4 w-4" /> The goal</div>
            <div className="mt-2 text-[18px] font-semibold">CloudScale Enterprise APM</div>
            <div className="text-[14px] text-ink-300">10 seats, from CloudScale Inc</div>
          </Card>
          <Card>
            <div className="flex items-center gap-2 text-[13px] text-ink-400"><ShieldCheck className="h-4 w-4" /> The safety rule</div>
            <div className="mt-2 text-[14px] text-ink-300">Keep at least this much in the bank for the next 8 weeks:</div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-ink-400">$</span>
              <input
                className="w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 font-mono text-[16px]"
                placeholder="Recommended (balance − $18,000)"
                value={floor}
                onChange={(e) => setFloor(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
          </Card>
        </div>
        <Card className="bg-transparent">
          <div className="text-[14px] font-semibold">What happens next</div>
          <ol className="mt-3 grid gap-3 text-[13px] text-ink-300 sm:grid-cols-4">
            {[
              ['Choose a plan', 'Reads the vendor’s prices and checks which one your cash can afford.'],
              ['Issue the card', 'You approve the exact price; the agent gets a card that can pay only that.'],
              ['Stop the overcharge', 'The vendor tries to sneak in a fee. Watch it get blocked.'],
              ['Pay safely', 'You decide, and exactly the approved amount is paid.'],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-700 font-mono text-[10px]">{i + 2}</span>
                <span><span className="font-medium text-ink-100">{t}.</span> {d}</span>
              </li>
            ))}
          </ol>
        </Card>
      </Screen>
    );
  }

  const bills = g.scheduled.filter((f) => f.kind !== 'OPEX');
  return (
    <Screen
      step={1}
      title="Your rules are set"
      subtitle="The agent knows how much you have, what's coming in and out, and the line it must never cross."
      actions={
        <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(2)}>
          Next: look at the vendor's offer <ArrowRight className="h-4 w-4" />
        </button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Money in the bank today" value={usd(g.openingBalance, 0)} sub={g.balanceSource} />
        <Stat label="Safety floor (never go below)" value={usd(g.reserveFloor, 0)} sub={`for the next ${g.horizonWeeks} weeks`} />
      </div>
      <Card>
        <div className="text-[14px] font-semibold">Known money in and out</div>
        <ul className="mt-3 divide-y divide-ink-700/70 text-[14px]">
          <li className="flex justify-between py-2"><span className="text-ink-300">Every week · running costs</span><span className="font-mono">−$1,000</span></li>
          {bills.map((f) => (
            <li key={f.id} className="flex justify-between py-2">
              <span className="text-ink-300">Week {f.week} · {f.label}</span>
              <span className={`font-mono ${f.amount > 0 ? 'text-status-good' : ''}`}>{f.amount > 0 ? '+' : '−'}{usd(Math.abs(f.amount), 0)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Step 2 - Choose a plan
// ---------------------------------------------------------------------------

export function PlanScreen(p: ScreenProps) {
  const { state } = p;
  if (p.working) {
    return (
      <Screen step={2} title="Reading the offer…" subtitle="Claude reads the vendor's quote. Then plain code forecasts your cash for each price option.">
        <WorkingPanel label="Analyzing the vendor's quote and your cash" events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  if (!state.plan || !state.intent) {
    return (
      <Screen
        step={2}
        title="Which way of paying can you afford?"
        subtitle="CloudScale offers two prices. The cheapest isn't always safe: paying a lot upfront can leave you short later."
        actions={
          <button className="btn-primary px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'act2')}>
            <Sparkles className="h-4 w-4" /> Read the offer & check my cash
          </button>
        }
      >
        <ErrorNote state={state} />
        <Card>
          <div className="grid gap-4 text-[14px] text-ink-300 sm:grid-cols-3">
            <div><ScanSearch className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Claude reads the quote</span> and pulls out the prices and any risky terms.</div>
            <div><BadgeCheck className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Code double-checks it:</span> every price must appear word for word in the quote.</div>
            <div><CalendarClock className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Code forecasts 8 weeks</span> of cash for each option. No AI does the maths.</div>
          </div>
        </Card>
      </Screen>
    );
  }

  const d = state.plan.decision;
  const g = state.guardrails!;
  const annual = d.verdicts.find((v) => v.optionId === 'ANNUAL_UPFRONT');
  const monthly = d.verdicts.find((v) => v.optionId === 'MONTHLY');
  const fee = state.contract?.parsed.extraction.risk_clauses.find((r) => r.kind === 'ONBOARDING_FEE');
  const amount = state.intent.intent.billing.amount;
  const done = state.act >= 3;

  return (
    <Screen
      step={2}
      title={<>Pay <span className="text-series-monthly">monthly</span>, not yearly</>}
      subtitle={`The yearly deal is ${usd(d.savingsForgone, 0)} cheaper, but paying it all now would leave you below your ${usd(g.reserveFloor, 0)} safety floor in week ${annual?.firstBreachWeek}.`}
      actions={
        done ? (
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(3)}>
            Next: the card <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="hidden text-[12px] text-ink-400 sm:block">You approve exactly these terms. The agent can't spend a cent more.</span>
            <button className="btn-good px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'approve')}>
              <Gavel className="h-4 w-4" /> Approve {usd(amount)} / month
            </button>
          </>
        )
      }
    >
      <ErrorNote state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        {annual && (
          <OptionCard
            title="Pay yearly"
            price={`${usd(9600, 0)} today`}
            note={`Saves ${usd(d.savingsForgone, 0)} a year`}
            safe={annual.safe}
            verdict={annual.safe ? `Lowest cash ${usd(annual.minBalance, 0)}` : `Week ${annual.firstBreachWeek}: cash falls to ${usd(annual.minBalance, 0)}, ${usd(annual.maxShortfall, 0)} below your floor`}
            chosen={d.recommendedOptionId === 'ANNUAL_UPFRONT'}
          />
        )}
        {monthly && (
          <OptionCard
            title="Pay monthly"
            price={`${usd(1000, 0)} / month`}
            note="Cancel any time"
            safe={monthly.safe}
            verdict={monthly.safe ? `Lowest cash ${usd(monthly.minBalance, 0)}, safely above your floor` : `Breaks the floor in week ${monthly.firstBreachWeek}`}
            chosen={d.recommendedOptionId === 'MONTHLY'}
          />
        )}
      </div>

      <Card className="p-0">
        <div className="px-5 pt-4 text-[14px] font-semibold">Your cash over the next 8 weeks</div>
        <CashflowChart state={state} compact />
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {fee && (
          <div className="flex gap-3 rounded-2xl border border-status-warn/40 bg-status-warn/10 p-4">
            <FileWarning className="h-5 w-5 shrink-0 text-status-warn" />
            <div className="text-[14px]">
              <div className="font-semibold">Watch out: clause {fee.clause_ref}</div>
              <div className="text-ink-300">{fee.summary}{fee.max_amount ? ` (up to ${usd(fee.max_amount)})` : ''}</div>
            </div>
          </div>
        )}
        {d.upgradeTrigger && (
          <div className="flex gap-3 rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
            <CalendarClock className="h-5 w-5 shrink-0 text-flame-400" />
            <div className="text-[14px]">
              <div className="font-semibold">Reminder set for week {d.upgradeTrigger.week}</div>
              <div className="text-ink-300">Revisit the yearly deal once the {usd(18000, 0)} customer payment arrives.</div>
            </div>
          </div>
        )}
      </div>

      <NarrativeBlock title="Why the agent chose this" n={state.plan.narrative} />

      <Details label="See the vendor's quote and what Claude extracted">
        <ContractPanel state={state} />
      </Details>
    </Screen>
  );
}

function OptionCard(props: { title: string; price: string; note: string; safe: boolean; verdict: string; chosen: boolean }) {
  return (
    <div className={`relative rounded-2xl border p-5 ${props.safe ? 'border-status-good/50 bg-status-good/[0.06]' : 'border-status-critical/40 bg-status-critical/[0.06]'}`}>
      {props.chosen && <span className="absolute right-4 top-4 rounded-full bg-status-good px-2 py-0.5 text-[11px] font-bold text-ink-950">CHOSEN</span>}
      <div className="text-[13px] text-ink-400">{props.title}</div>
      <div className="mt-1 font-mono text-[24px] font-semibold">{props.price}</div>
      <div className="text-[13px] text-ink-400">{props.note}</div>
      <div className={`mt-4 flex items-start gap-2 text-[14px] ${props.safe ? 'text-status-good' : 'text-status-critical'}`}>
        {props.safe ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
        <span>{props.verdict}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 - Issue the card
// ---------------------------------------------------------------------------

export function CardScreen(p: ScreenProps) {
  const { state } = p;
  if (p.working) {
    const shock = state.busy?.includes('shock');
    return (
      <Screen step={3} title={shock ? 'Checking out at CloudScale…' : 'Issuing your card…'} subtitle={shock ? 'The agent signs in with its Visa agent ID and pays for the approved cart.' : 'Your approval is being signed and a single-purpose Airwallex card is being created.'}>
        <WorkingPanel label={shock ? 'Checking out' : 'Creating the virtual card'} events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  const c = state.card;
  if (!c || !state.intent) return null;
  const ctrl = c.card.authorization_controls;
  const per = c.limits.limits.find((l) => l.interval === 'PER_TRANSACTION');
  const monthly = c.limits.limits.find((l) => l.interval === 'MONTHLY');
  const done = state.act >= 4;
  return (
    <Screen
      step={3}
      title="A card that can only pay what you approved"
      subtitle={`You signed off on ${usd(state.intent.intent.billing.amount)} a month to CloudScale. The agent's new card can't be used for anything else.`}
      actions={
        done ? (
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(4)}>
            Next: what happened at checkout <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="hidden text-[12px] text-ink-400 sm:block">In this demo, the vendor will try to add a $250 fee at payment.</span>
            <button className="btn-danger px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'shock')}>
              <Zap className="h-4 w-4" fill="currentColor" /> Go to checkout
            </button>
          </>
        )
      }
    >
      <ErrorNote state={state} />
      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,330px)_1fr]">
        <VirtualCardWidget state={state} hideLimits />
        <Card>
          <div className="flex items-center gap-2 text-[14px] font-semibold"><Lock className="h-4 w-4 text-flame-400" /> What this card can do</div>
          <ul className="mt-3 space-y-2.5 text-[14px]">
            <Rule ok>Pay up to <b className="font-mono">{usd(per?.amount)}</b> per charge</Rule>
            <Rule ok>Spend at most <b className="font-mono">{usd(monthly?.amount)}</b> per month</Rule>
            <Rule ok>Only at software stores (category {ctrl.allowed_merchant_categories?.join(', ')})</Rule>
            <Rule ok>Only in {ctrl.allowed_currencies?.join(', ')}</Rule>
            {ctrl.active_to && <Rule ok>Stops working on {new Date(ctrl.active_to).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Rule>}
            <Rule>A charge of {usd((per?.amount ?? 0) + 0.01)} or more is declined by Airwallex itself</Rule>
          </ul>
        </Card>
      </div>
      {state.approval && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 px-4 py-3 text-[13px] text-ink-300">
          <BadgeCheck className="h-4 w-4 text-status-good" /> Approved by <span className="text-ink-100">{state.approval.approver}</span>
          <span className="text-ink-500">· digitally signed, tied to these exact terms</span>
        </div>
      )}
      <Details label="Technical details: intent fingerprint and Visa agent ID">
        <VisaTapPassport state={state} onProbe={() => p.call('probe/unsigned-bot').catch(() => undefined)} />
      </Details>
    </Screen>
  );
}

function Rule({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-ink-200">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-good" /> : <Ban className="mt-0.5 h-4 w-4 shrink-0 text-status-critical" />}
      <span>{children}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 4 - Stop the overcharge
// ---------------------------------------------------------------------------

export function BlockedScreen(p: ScreenProps) {
  const { state } = p;
  if (p.working) {
    return (
      <Screen step={4} title="Holding the vendor to $1,000…" subtitle="The agent checks the new cart against your approval before it unfreezes the card and pays.">
        <WorkingPanel label="Re-checking and paying" events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  const inc = state.incident;
  if (!inc || !state.intent) return null;
  const attempted = inc.attemptedAmount;
  const approved = state.intent.intent.billing.amount;
  const fee = inc.verification.unapprovedLineItems[0];
  const resolved = state.act >= 5;
  return (
    <Screen
      step={4}
      tone={resolved ? 'default' : 'critical'}
      title={<span className={resolved ? '' : 'text-status-critical'}>Overcharge blocked. No money moved.</span>}
      subtitle={`CloudScale tried to charge ${usd(attempted)} instead of the ${usd(approved)} you approved. Here's how it was stopped.`}
      actions={
        resolved ? (
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(5)}>
            Next: the result <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="hidden text-[12px] text-ink-400 sm:block">Your call: the card stays frozen until you decide.</span>
            <button className="btn-good px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'resolve')}>
              <Gavel className="h-4 w-4" /> Hold them to {usd(approved)}
            </button>
          </>
        )
      }
    >
      <ErrorNote state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="You approved" value={usd(approved)} tone="good" />
        <Stat label="CloudScale tried to charge" value={usd(attempted)} tone="critical" sub={fee ? `+ ${usd(fee.amount)} “${fee.description}”` : undefined} />
      </div>

      <Card>
        <div className="text-[14px] font-semibold">Four layers of protection, in order</div>
        <ol className="mt-4 space-y-4">
          <Layer icon={<Ban className="h-4 w-4" />} title="Airwallex declined the charge" body={`The card's limit is ${usd(approved)}, so the bank network refused ${usd(attempted)} (${inc.failureReason}). This didn't depend on the AI at all.`} />
          <Layer icon={<Eye className="h-4 w-4" />} title="The agent spotted the mismatch" body="The charge's fingerprint didn't match the one you approved: different amount, plus an item you never agreed to." />
          <Layer icon={<Snowflake className="h-4 w-4" />} title="The agent froze the card" body="Nothing can be charged to it until you decide what to do." />
          <Layer icon={<AlertOctagon className="h-4 w-4" />} title="The vendor tried again, and failed" body={`It tried to charge the ${usd(fee?.amount ?? 250)} fee on its own. Declined: the card is frozen${inc.retry?.failure_reason ? ` (${inc.retry.failure_reason})` : ''}.`} />
        </ol>
      </Card>

      <NarrativeBlock title="Incident report" n={inc.narrative} />

      <Details label="Technical details: fingerprints and the full API trail">
        <div className="space-y-2 font-mono text-[12px] text-ink-300">
          <div>approved fingerprint&nbsp; {inc.verification.approvedBindingHash}</div>
          <div className="text-status-critical">charged fingerprint&nbsp;&nbsp; {inc.verification.observedBindingHash}</div>
          <button className="btn-ghost mt-2 font-sans" onClick={p.openDrawer}><SquareTerminal className="h-4 w-4" /> Open every API call</button>
        </div>
      </Details>
    </Screen>
  );
}

function Layer({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-status-critical/15 text-status-critical">{icon}</span>
      <div>
        <div className="text-[14px] font-semibold">{title}</div>
        <div className="text-[13px] leading-relaxed text-ink-300">{body}</div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 5 - Pay safely
// ---------------------------------------------------------------------------

export function PaidScreen(p: ScreenProps) {
  const { state } = p;
  const s = state.settlement;
  if (!s || !state.intent) return null;
  const d = state.plan!.decision;
  const chosen = d.verdicts.find((v) => v.optionId === d.recommendedOptionId);
  const trig = state.triggers[0];
  return (
    <Screen
      step={5}
      tone="good"
      title={<span className="text-status-good">Paid exactly {usd(state.intent.intent.billing.amount)}. Your cash is safe.</span>}
      subtitle="CloudScale dropped the fee. The agent confirmed the cart matched your approval, unfroze the card and paid."
      actions={
        <>
          <button className="btn-ghost px-4 py-2.5" onClick={p.openDrawer}><SquareTerminal className="h-4 w-4" /> See every API call</button>
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.call('reset').catch(() => undefined)}>
            <RotateCcw className="h-4 w-4" /> Run it again
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Paid to CloudScale" value={usd(state.intent.intent.billing.amount)} tone="good" sub="settled (cleared)" />
        <Stat label="Unapproved spending" value="$0.00" tone="good" sub="the $250 fee never went through" />
        <Stat label="Lowest cash in 8 weeks" value={usd(chosen?.minBalance, 0)} sub={`floor ${usd(state.guardrails!.reserveFloor, 0)}`} />
      </div>

      <Card>
        <div className="text-[14px] font-semibold">What happened</div>
        <ol className="mt-3 space-y-2 text-[14px] text-ink-300">
          <Recap n={1}>You set a safety floor of {usd(state.guardrails!.reserveFloor, 0)}.</Recap>
          <Recap n={2}>The agent turned down the cheaper yearly deal because it would break that floor in week 7.</Recap>
          <Recap n={3}>You approved {usd(state.intent.intent.billing.amount)}/month, and the agent got a card limited to exactly that.</Recap>
          <Recap n={4}>CloudScale tried to charge {usd(state.incident?.attemptedAmount)}. Blocked, card frozen.</Recap>
          <Recap n={5}>You held them to the original price, and {usd(state.intent.intent.billing.amount)} was paid.</Recap>
        </ol>
      </Card>

      {trig && (
        <div className="flex gap-3 rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
          <CalendarClock className="h-5 w-5 shrink-0 text-flame-400" />
          <div className="text-[14px]">
            <div className="font-semibold">Next: week {trig.week} check-in</div>
            <div className="text-ink-300">{trig.condition}.</div>
          </div>
        </div>
      )}

      <NarrativeBlock title="Audit note" n={s.narrative} />
    </Screen>
  );
}

function Recap({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-status-good/20 font-mono text-[10px] text-status-good">{n}</span>
      <span>{children}</span>
    </li>
  );
}

/** Keeps the page scrolled to the top when the step changes. */
export function useScrollTop(dep: unknown) {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [dep]);
}
