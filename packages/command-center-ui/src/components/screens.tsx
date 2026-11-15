import { useEffect, useState } from 'react';
import {
  AlertOctagon,
  ArrowRight,
  BadgeCheck,
  Ban,
  BookOpen,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  CircleDollarSign,
  Eye,
  FileWarning,
  Gavel,
  Lock,
  Repeat,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Snowflake,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  Zap,
} from 'lucide-react';
import type { RunState, TelemetryEvent } from '../types';
import { usd } from '../useRun';
import { CashflowChart } from './CashflowChart';
import { ContractPanel } from './ContractPanel';
import { ContractUpload } from './ContractUpload';
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

const planWord = (id: string | null | undefined) => (id === 'MONTHLY' ? 'monthly' : 'yearly');
const cadenceWord = (c: string | undefined) => (c === 'MONTHLY' ? 'monthly' : 'yearly');
const perPeriod = (c: string | undefined) => (c === 'MONTHLY' ? 'a month' : 'a year');

function ErrorNote({ state }: { state: RunState }) {
  if (!state.error || state.busy) return null;
  return <div className="rounded-xl border border-status-critical/50 bg-status-critical/10 px-4 py-3 text-[13px] text-status-critical">{state.error}</div>;
}

function CalendarLink() {
  return (
    <a className="inline-flex items-center gap-1 text-[13px] text-flame-400 hover:underline" href="/api/trigger.ics" download>
      <CalendarPlus className="h-3.5 w-3.5" /> Add to calendar
    </a>
  );
}

/** Shown instead of a blank page when a step's data doesn't exist (e.g. a failed action). */
function NotReady({ p, step, title, back, backLabel }: { p: ScreenProps; step: number; title: string; back: number; backLabel: string }) {
  return (
    <Screen
      step={step}
      title={title}
      subtitle={p.state.error ? 'The previous step did not finish. Here is what went wrong:' : 'Finish the previous step first.'}
      actions={
        <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(back)}>
          {backLabel}
        </button>
      }
    >
      <ErrorNote state={p.state} />
    </Screen>
  );
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
        subtitle="Your team needs a software subscription. The agent will buy it for you, but it must never let your bank balance fall below a safety floor."
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
            <div className="mt-2 text-[18px] font-semibold">Buy the software your team needs</div>
            <div className="text-[14px] text-ink-300">You'll give the agent the vendor's order form in the next step.</div>
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
              ['Choose a plan', 'You upload the vendor’s order form. The agent reads it and checks which price your cash can afford.'],
              ['Issue the card', 'You approve the exact price; the agent gets a card that can pay only that.'],
              ['Stop the overcharge', 'The vendor tries to change the deal at payment. Watch it get blocked.'],
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
          Next: the vendor's offer <ArrowRight className="h-4 w-4" />
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
      <Screen step={2} title="Reading the contract…" subtitle="Claude reads the vendor's order form. Then plain code forecasts your cash for each price option.">
        <WorkingPanel label="Analyzing the contract and your cash" events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  if (!state.plan || !state.intent) {
    return (
      <Screen
        step={2}
        title="Upload the vendor's offer"
        subtitle="Give the agent the order form or terms. It reads the prices and fine print, then checks which way of paying your cash can afford."
        actions={
          <button className="btn-primary px-5 py-2.5 text-[15px]" disabled={p.busy || state.act < 1} onClick={() => run(p, 'act2')}>
            <Sparkles className="h-4 w-4" /> Read the contract & check my cash
          </button>
        }
      >
        <ErrorNote state={state} />
        <ContractUpload state={state} call={p.call} disabled={p.busy} />
        <Card>
          <div className="grid gap-4 text-[14px] text-ink-300 sm:grid-cols-3">
            <div><ScanSearch className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Claude reads the contract</span> and pulls out the prices and any risky terms.</div>
            <div><BadgeCheck className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Code double-checks it:</span> every price must appear word for word in the document.</div>
            <div><CalendarClock className="mb-2 h-5 w-5 text-flame-400" /><span className="font-medium text-ink-100">Code forecasts 8 weeks</span> of cash for each option. No AI does the maths.</div>
          </div>
        </Card>
      </Screen>
    );
  }

  const d = state.plan.decision;
  const g = state.guardrails!;
  const prices = state.catalog.prices;
  const annual = d.verdicts.find((v) => v.optionId === 'ANNUAL_UPFRONT');
  const monthly = d.verdicts.find((v) => v.optionId === 'MONTHLY');
  const fee = state.contract?.parsed.extraction.risk_clauses.find((r) => r.kind === 'ONBOARDING_FEE');
  const { amount, cadence } = state.intent.intent.billing;
  const merchant = state.catalog.merchant.name;
  const done = state.act >= 3;
  const chose = d.recommendedOptionId;
  const cheapestRejected = chose !== d.cheapestOptionId;
  const cheapestV = d.verdicts.find((v) => v.optionId === d.cheapestOptionId);
  const yearlySaving = prices.MONTHLY !== undefined && prices.ANNUAL !== undefined ? prices.MONTHLY * 12 - prices.ANNUAL : null;

  return (
    <Screen
      step={2}
      title={
        cheapestRejected ? (
          <>Pay <span className={chose === 'MONTHLY' ? 'text-series-monthly' : 'text-series-annual'}>{planWord(chose)}</span>, not {planWord(d.cheapestOptionId)}</>
        ) : (
          <>Pay <span className={chose === 'MONTHLY' ? 'text-series-monthly' : 'text-series-annual'}>{planWord(chose)}</span>: cheapest, and safe</>
        )
      }
      subtitle={
        cheapestRejected
          ? `The ${planWord(d.cheapestOptionId)} deal is ${usd(d.savingsForgone, 0)} cheaper, but it would leave you below your ${usd(g.reserveFloor, 0)} safety floor in week ${cheapestV?.firstBreachWeek}.`
          : `Every option keeps you above your ${usd(g.reserveFloor, 0)} floor, so the agent takes the cheapest one.`
      }
      actions={
        done ? (
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(3)}>
            Next: the card <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="hidden text-[12px] text-ink-400 sm:block">You approve exactly these terms. The agent can't spend a cent more.</span>
            <button className="btn-good px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'approve')}>
              <Gavel className="h-4 w-4" /> Approve {usd(amount)} {perPeriod(cadence)}
            </button>
          </>
        )
      }
    >
      <ErrorNote state={state} />
      <div className="text-[13px] text-ink-400">
        From <span className="text-ink-200">{state.contractSource.name}</span> · {merchant} · {state.catalog.product}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {annual && prices.ANNUAL !== undefined && (
          <OptionCard
            title="Pay yearly"
            price={`${usd(prices.ANNUAL, 0)} upfront`}
            note={yearlySaving && yearlySaving > 0 ? `Saves ${usd(yearlySaving, 0)} a year` : 'Billed once a year'}
            safe={annual.safe}
            verdict={annual.safe ? `Lowest cash ${usd(annual.minBalance, 0)}, above your floor` : `Week ${annual.firstBreachWeek}: cash falls below your floor (low point ${usd(annual.minBalance, 0)})`}
            chosen={chose === 'ANNUAL_UPFRONT'}
          />
        )}
        {monthly && prices.MONTHLY !== undefined && (
          <OptionCard
            title="Pay monthly"
            price={`${usd(prices.MONTHLY, 0)} / month`}
            note="Billed every month"
            safe={monthly.safe}
            verdict={monthly.safe ? `Lowest cash ${usd(monthly.minBalance, 0)}, above your floor` : `Week ${monthly.firstBreachWeek}: cash falls below your floor`}
            chosen={chose === 'MONTHLY'}
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
        {d.upgradeTrigger && state.triggers[0] && (
          <div className="flex gap-3 rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
            <CalendarClock className="h-5 w-5 shrink-0 text-flame-400" />
            <div className="text-[14px]">
              <div className="font-semibold">Reminder set for week {d.upgradeTrigger.week}</div>
              <div className="text-ink-300">Revisit the {planWord(d.cheapestOptionId)} deal once the {usd(18000, 0)} customer payment arrives.</div>
              <div className="mt-1"><CalendarLink /></div>
            </div>
          </div>
        )}
      </div>

      <NarrativeBlock title="Why the agent chose this" n={state.plan.narrative} />

      <Details label="See the contract and what Claude extracted">
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
      <Screen
        step={3}
        title={shock ? `Checking out at ${state.catalog.merchant.name}…` : 'Issuing your card…'}
        subtitle={shock ? 'The agent signs in with its Visa agent ID and pays for the approved cart.' : 'Your approval is being signed and a single-purpose Airwallex card is being created.'}
      >
        <WorkingPanel label={shock ? 'Checking out' : 'Creating the virtual card'} events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  const c = state.card;
  if (!c || !state.intent) return <NotReady p={p} step={3} title="No card yet" back={2} backLabel="Back to approval" />;
  const ctrl = c.card.authorization_controls;
  const per = c.limits.limits.find((l) => l.interval === 'PER_TRANSACTION');
  const cumulative = c.limits.limits.find((l) => l.interval !== 'PER_TRANSACTION');
  const { amount, cadence } = state.intent.intent.billing;
  const merchant = state.catalog.merchant.name;
  const other = cadence === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY';
  const canFlip = state.catalog.prices[other] !== undefined;
  const done = state.act >= 4;
  return (
    <Screen
      step={3}
      title="A card that can only pay what you approved"
      subtitle={`You signed off on ${usd(amount)} ${perPeriod(cadence)} to ${merchant}. The agent's new card can't be used for anything else.`}
      actions={
        done ? (
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.goTo(4)}>
            Next: what happened at checkout <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="hidden text-[12px] text-ink-400 md:block">Pick how {merchant} misbehaves at checkout:</span>
            {canFlip && (
              <button className="btn-ghost px-4 py-2.5 text-[14px]" disabled={p.busy} onClick={() => run(p, 'shock', { mode: 'CADENCE_FLIP' })}>
                <Repeat className="h-4 w-4" /> Switches me to {cadenceWord(other)}
              </button>
            )}
            <button className="btn-danger px-5 py-2.5 text-[15px]" disabled={p.busy} onClick={() => run(p, 'shock', { mode: 'FEE' })}>
              <Zap className="h-4 w-4" fill="currentColor" /> Adds a {usd(state.catalog.fee.amount, 0)} fee
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
            {cumulative && <Rule ok>Spend at most <b className="font-mono">{usd(cumulative.amount)}</b> {cumulative.interval === 'MONTHLY' ? 'per month' : 'in total'}</Rule>}
            {ctrl.allowed_transaction_count === 'SINGLE' && <Rule ok>Be used for one payment only</Rule>}
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
      <Screen step={4} title={`Holding ${state.catalog.merchant.name} to the approved price…`} subtitle="The agent checks the new cart against your approval before it unfreezes the card and pays.">
        <WorkingPanel label="Re-checking and paying" events={p.events} since={p.busySince} />
      </Screen>
    );
  }
  const inc = state.incident;
  if (!inc || !state.intent) return <NotReady p={p} step={4} title="Checkout hasn't run yet" back={3} backLabel="Back to the card" />;
  const { amount: approved, cadence } = state.intent.intent.billing;
  const merchant = state.catalog.merchant.name;
  const attempted = inc.attemptedAmount;
  const extraItem = inc.verification.unapprovedLineItems.find((li) => li.sku !== state.catalog.sku);
  const flipped = inc.mode === 'CADENCE_FLIP';
  const resolved = state.act >= 5;
  const diffWords = inc.verification.diffs
    .map((d) => (d.field === 'amount' ? 'a different amount' : d.field === 'cadence' ? `${cadenceWord(inc.attemptedCadence)} billing instead of ${cadenceWord(cadence)}` : d.field === 'line_items' ? 'an item you never agreed to' : null))
    .filter(Boolean)
    .join(', ');
  return (
    <Screen
      step={4}
      tone={resolved ? 'default' : 'critical'}
      title={<span className={resolved ? '' : 'text-status-critical'}>{flipped ? 'Plan switch blocked.' : 'Overcharge blocked.'} No money moved.</span>}
      subtitle={`${merchant} tried to charge ${usd(attempted)} (${cadenceWord(inc.attemptedCadence)}) instead of the ${usd(approved)} ${cadenceWord(cadence)} you approved. Here's how it was stopped.`}
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
        <Stat label="You approved" value={usd(approved)} tone="good" sub={`${cadenceWord(cadence)} plan`} />
        <Stat
          label={`${merchant} tried to charge`}
          value={usd(attempted)}
          tone="critical"
          sub={extraItem ? `+ ${usd(extraItem.amount)} “${extraItem.description}”` : flipped ? `${cadenceWord(inc.attemptedCadence)} plan instead` : undefined}
        />
      </div>

      <Card>
        <div className="text-[14px] font-semibold">Layers of protection, in order</div>
        <ol className="mt-4 space-y-4">
          {inc.railApproved ? (
            <Layer
              tone="warn"
              icon={<TriangleAlert className="h-4 w-4" />}
              title="Airwallex allowed the charge"
              body={`${usd(attempted)} was within the card's ${usd(approved)} limit, so the card network approved it. Limits alone can't catch a plan switch to a cheaper price. That's why the agent checks every charge too.`}
            />
          ) : (
            <Layer icon={<Ban className="h-4 w-4" />} title="Airwallex declined the charge" body={`The card's limit is ${usd(approved)}, so the bank network refused ${usd(attempted)} (${inc.failureReason}). This didn't depend on the AI at all.`} />
          )}
          <Layer icon={<Eye className="h-4 w-4" />} title="The agent spotted the mismatch" body={`The charge's fingerprint didn't match the one you approved: ${diffWords || 'different terms'}.`} />
          <Layer icon={<Snowflake className="h-4 w-4" />} title={inc.railApproved ? 'The agent froze the card and reversed the charge' : 'The agent froze the card'} body={inc.railApproved ? 'The authorization was voided before it could settle. Nothing can be charged until you decide.' : 'Nothing can be charged to it until you decide what to do.'} />
          <Layer icon={<AlertOctagon className="h-4 w-4" />} title="The vendor tried again, and failed" body={`It tried to charge ${usd(inc.retry?.amount ?? 0)} on its own. Declined${inc.retry?.failure_reason ? ` (${inc.retry.failure_reason})` : ''}: the card can't be charged any more.`} />
        </ol>
      </Card>

      {inc.docs && (
        <div className="flex gap-3 rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
          <BookOpen className="h-5 w-5 shrink-0 text-flame-400" />
          <div className="text-[14px]">
            <div className="font-semibold">What Airwallex's docs say about <span className="font-mono">{inc.docs.failure_reason}</span></div>
            <div className="text-ink-300">{inc.docs.description}</div>
            {inc.docs.next_steps && <div className="mt-1 text-ink-400">Next step: {inc.docs.next_steps}</div>}
            <div className="mt-1 text-[12px] text-ink-500">Looked up live by the agent via the Airwallex Docs MCP</div>
          </div>
        </div>
      )}

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

function Layer({ icon, title, body, tone = 'critical' }: { icon: React.ReactNode; title: string; body: string; tone?: 'critical' | 'warn' }) {
  return (
    <li className="flex gap-3">
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${tone === 'warn' ? 'bg-status-warn/15 text-status-warn' : 'bg-status-critical/15 text-status-critical'}`}>{icon}</span>
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
  if (!s || !state.intent) return <NotReady p={p} step={5} title="Not paid yet" back={4} backLabel="Back" />;
  const d = state.plan!.decision;
  const chosen = d.verdicts.find((v) => v.optionId === d.recommendedOptionId);
  const cheapestRejected = d.recommendedOptionId !== d.cheapestOptionId;
  const trig = state.triggers[0];
  const { amount, cadence } = state.intent.intent.billing;
  const merchant = state.catalog.merchant.name;
  const inc = state.incident;
  return (
    <Screen
      step={5}
      tone="good"
      title={<span className="text-status-good">Paid exactly {usd(amount)}. Your cash is safe.</span>}
      subtitle={`${merchant} backed down. The agent confirmed the cart matched your approval, unfroze the card and paid.`}
      actions={
        <>
          <button className="btn-ghost px-4 py-2.5" onClick={p.openDrawer}><SquareTerminal className="h-4 w-4" /> See every API call</button>
          <button className="btn-primary px-5 py-2.5 text-[15px]" onClick={() => p.call('reset').catch(() => undefined)}>
            <RotateCcw className="h-4 w-4" /> Run it again
          </button>
        </>
      }
    >
      <ErrorNote state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={`Paid to ${merchant}`} value={usd(amount)} tone="good" sub="settled (cleared)" />
        <Stat label="Unapproved spending" value="$0.00" tone="good" sub="the vendor's change never went through" />
        <Stat label="Lowest cash in 8 weeks" value={usd(chosen?.minBalance, 0)} sub={`floor ${usd(state.guardrails!.reserveFloor, 0)}`} />
      </div>

      <Card>
        <div className="text-[14px] font-semibold">What happened</div>
        <ol className="mt-3 space-y-2 text-[14px] text-ink-300">
          <Recap n={1}>You set a safety floor of {usd(state.guardrails!.reserveFloor, 0)} and gave the agent {merchant}'s order form.</Recap>
          <Recap n={2}>
            {cheapestRejected
              ? `The agent turned down the cheaper ${planWord(d.cheapestOptionId)} deal because it would break that floor in week ${d.verdicts.find((v) => v.optionId === d.cheapestOptionId)?.firstBreachWeek}.`
              : `Every option kept you above the floor, so the agent picked the cheapest: ${planWord(d.recommendedOptionId)}.`}
          </Recap>
          <Recap n={3}>You approved {usd(amount)} {perPeriod(cadence)}, and the agent got a card limited to exactly that.</Recap>
          <Recap n={4}>{merchant} tried to charge {usd(inc?.attemptedAmount)}. Blocked, card frozen.</Recap>
          <Recap n={5}>
            You held them to the original terms{state.reissue ? '. The single-use card had been used up by the reversed charge, so the agent issued a replacement for the same approval' : ''}, and {usd(amount)} was paid.
          </Recap>
        </ol>
      </Card>

      {trig && (
        <div className="flex gap-3 rounded-2xl border border-ink-700 bg-ink-900/80 p-4">
          <CalendarClock className="h-5 w-5 shrink-0 text-flame-400" />
          <div className="text-[14px]">
            <div className="font-semibold">Next: week {trig.week} check-in ({new Date(trig.dueDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })})</div>
            <div className="text-ink-300">{trig.condition}.</div>
            <div className="mt-1"><CalendarLink /></div>
          </div>
        </div>
      )}

      <NarrativeBlock title="Audit note" n={s.narrative} />

      <Card className="bg-transparent">
        <div className="flex flex-wrap items-center gap-3">
          <Undo2 className="h-5 w-5 text-ink-400" />
          <div className="flex-1 text-[14px]">
            <div className="font-semibold">Need to undo it?</div>
            <div className="text-ink-400">Simulate {merchant} refunding the {usd(amount)}. Airwallex restores the card's spending limit.</div>
          </div>
          {state.refund ? (
            <span className={`text-[14px] ${state.refund.outcome === 'FAILED' ? 'text-status-critical' : 'text-status-good'}`}>
              {state.refund.outcome === 'FAILED' ? `Refund failed: ${state.refund.failure_reason}` : `Refunded ${usd(state.refund.amount)} · limit back to ${usd(state.refund.limitsAfter.limits.find((l) => l.interval !== 'PER_TRANSACTION')?.remaining)}`}
            </span>
          ) : (
            <button className="btn-ghost" disabled={p.busy} onClick={() => run(p, 'refund')}>Simulate a refund</button>
          )}
        </div>
      </Card>
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
