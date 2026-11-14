/**
 * Rolling weekly cash-flow projector + reserve-floor policy.
 *
 * Pure, deterministic code: the LLM never computes balances or decides whether a
 * plan breaches the reserve. All arithmetic is in integer cents.
 */
import { canonicalAmount, Currency, signedToMinor, toMajor, toMinor } from './money.js';
import { canonicalJson, sha256Hex } from './canonical.js';

export type FlowKind = 'OPEX' | 'PAYROLL' | 'TAX' | 'RECEIVABLE' | 'SAAS_COMMITMENT' | 'OTHER';

export interface ScheduledFlow {
  id: string;
  /** 1-based week index inside the horizon. */
  week: number;
  /** Signed major units: outflows negative, inflows positive. */
  amount: number;
  label: string;
  kind: FlowKind;
}

export type BillingCadence = 'MONTHLY' | 'ANNUAL';

export interface BillingOption {
  id: string;
  label: string;
  cadence: BillingCadence;
  /** Amount charged per billing event, major units. */
  chargeAmount: number;
  currency: Currency;
  /** Total cost over 12 months, major units. */
  annualizedCost: number;
  refundable: boolean;
}

export interface ProjectionInput {
  openingBalance: number;
  reserveFloor: number;
  currency: Currency;
  horizonWeeks: number;
  scheduled: ScheduledFlow[];
}

export interface WeekRow {
  week: number;
  opening: number;
  flows: ScheduledFlow[];
  net: number;
  closing: number;
  headroom: number;
  breach: boolean;
}

export interface Projection {
  optionId: string | null;
  weeks: WeekRow[];
  minBalance: number;
  minWeek: number;
  firstBreachWeek: number | null;
  maxShortfall: number;
  breach: boolean;
}

/** Billing day offsets -> 1-based week. Day 0 is today, so it lands in week 1. */
export function dayToWeek(day: number): number {
  return Math.floor(day / 7) + 1;
}

/**
 * Expand a billing option into scheduled outflows inside the horizon.
 * MONTHLY bills on day 0, 30, 60...; ANNUAL bills once on day 0 (upfront).
 */
export function chargesForOption(option: BillingOption, horizonWeeks: number, startDay = 0): ScheduledFlow[] {
  const flows: ScheduledFlow[] = [];
  const step = option.cadence === 'MONTHLY' ? 30 : 365;
  for (let day = startDay, n = 1; dayToWeek(day) <= horizonWeeks; day += step, n++) {
    flows.push({
      id: `${option.id}-charge-${n}`,
      week: dayToWeek(day),
      amount: -option.chargeAmount,
      label: `${option.label} charge #${n}`,
      kind: 'SAAS_COMMITMENT',
    });
  }
  return flows;
}

export function projectCashflow(input: ProjectionInput, extra: ScheduledFlow[] = [], optionId: string | null = null): Projection {
  const { currency } = input;
  const floor = toMinor(input.reserveFloor, currency);
  let balance = toMinor(input.openingBalance, currency);
  const all = [...input.scheduled, ...extra];
  for (const f of all) {
    if (!Number.isInteger(f.week) || f.week < 1 || f.week > input.horizonWeeks) {
      throw new Error(`Flow ${f.id} has week ${f.week} outside 1..${input.horizonWeeks}`);
    }
  }

  const weeks: WeekRow[] = [];
  let minMinor = Number.POSITIVE_INFINITY;
  let minWeek = 0;
  let firstBreachWeek: number | null = null;
  let maxShortfallMinor = 0;

  for (let w = 1; w <= input.horizonWeeks; w++) {
    const flows = all.filter((f) => f.week === w);
    const netMinor = flows.reduce((acc, f) => acc + signedToMinor(f.amount, currency), 0);
    const openingMinor = balance;
    balance += netMinor;
    const breach = balance < floor; // floor is inclusive: closing == floor is compliant
    if (breach && firstBreachWeek === null) firstBreachWeek = w;
    if (breach) maxShortfallMinor = Math.max(maxShortfallMinor, floor - balance);
    if (balance < minMinor) {
      minMinor = balance;
      minWeek = w;
    }
    weeks.push({
      week: w,
      opening: toMajor(openingMinor, currency),
      flows,
      net: toMajor(netMinor, currency),
      closing: toMajor(balance, currency),
      headroom: toMajor(balance - floor, currency),
      breach,
    });
  }

  return {
    optionId,
    weeks,
    minBalance: toMajor(minMinor, currency),
    minWeek,
    firstBreachWeek,
    maxShortfall: toMajor(maxShortfallMinor, currency),
    breach: firstBreachWeek !== null,
  };
}

export interface OptionVerdict {
  optionId: string;
  safe: boolean;
  firstBreachWeek: number | null;
  minBalance: number;
  minWeek: number;
  maxShortfall: number;
  annualizedCost: number;
}

export interface UpgradeTrigger {
  /** Week at which the cheaper (rejected) option first becomes reserve-safe. */
  week: number;
  targetOptionId: string;
  /** Lowest closing balance in the horizon if the switch happens that week. */
  projectedMinBalance: number;
  enabledBy: ScheduledFlow[];
  condition: string;
}

export interface PlanDecision {
  inputHash: string;
  baseline: Projection;
  projections: Record<string, Projection>;
  verdicts: OptionVerdict[];
  recommendedOptionId: string | null;
  cheapestOptionId: string;
  /** Annualized savings given up by not taking the cheapest option (0 if cheapest is safe). */
  savingsForgone: number;
  upgradeTrigger: UpgradeTrigger | null;
  rule: string;
}

/**
 * Deterministic selection rule:
 *   1. Project every option over the horizon.
 *   2. Discard any option whose closing balance drops below the floor in any week.
 *   3. Among the remaining options choose the lowest annualized cost.
 *   4. If the cheapest option was discarded, find the earliest week it becomes safe
 *      (a re-evaluation trigger), assuming the chosen option is billed until then.
 *   5. If no option is safe, recommend nothing (the agent must escalate).
 */
export function decideBillingPlan(input: ProjectionInput, options: BillingOption[]): PlanDecision {
  if (options.length === 0) throw new Error('No billing options to evaluate');
  const baseline = projectCashflow(input, [], null);
  const projections: Record<string, Projection> = {};
  const verdicts: OptionVerdict[] = options.map((o) => {
    const p = projectCashflow(input, chargesForOption(o, input.horizonWeeks), o.id);
    projections[o.id] = p;
    return {
      optionId: o.id,
      safe: !p.breach,
      firstBreachWeek: p.firstBreachWeek,
      minBalance: p.minBalance,
      minWeek: p.minWeek,
      maxShortfall: p.maxShortfall,
      annualizedCost: o.annualizedCost,
    };
  });

  const byCost = [...options].sort((a, b) => toMinor(a.annualizedCost) - toMinor(b.annualizedCost) || a.id.localeCompare(b.id));
  const cheapest = byCost[0];
  const recommended = byCost.find((o) => verdicts.find((v) => v.optionId === o.id)!.safe) ?? null;

  let upgradeTrigger: UpgradeTrigger | null = null;
  if (recommended && recommended.id !== cheapest.id) {
    for (let w = 2; w <= input.horizonWeeks; w++) {
      const startDay = (w - 1) * 7;
      const before = chargesForOption(recommended, input.horizonWeeks).filter((f) => f.week < w);
      const switched = chargesForOption(cheapest, input.horizonWeeks, startDay).map((f) => ({ ...f, id: `${f.id}-upgrade` }));
      const p = projectCashflow(input, [...before, ...switched], `${cheapest.id}@week${w}`);
      if (!p.breach) {
        const enabledBy = input.scheduled.filter((f) => f.week <= w && f.amount > 0 && f.kind === 'RECEIVABLE');
        upgradeTrigger = {
          week: w,
          targetOptionId: cheapest.id,
          projectedMinBalance: p.minBalance,
          enabledBy,
          condition:
            enabledBy.length > 0
              ? `Re-evaluate ${cheapest.label} in week ${w} once ${enabledBy.map((f) => f.label).join(', ')} has cleared`
              : `Re-evaluate ${cheapest.label} in week ${w}`,
        };
        break;
      }
    }
  }

  const savingsForgone =
    recommended && recommended.id !== cheapest.id
      ? toMajor(toMinor(recommended.annualizedCost) - toMinor(cheapest.annualizedCost))
      : 0;

  const inputHash = sha256Hex(
    canonicalJson({
      opening: canonicalAmount(input.openingBalance, input.currency),
      floor: canonicalAmount(input.reserveFloor, input.currency),
      currency: input.currency,
      horizon: input.horizonWeeks,
      scheduled: input.scheduled.map((f) => ({ id: f.id, week: f.week, amount: (f.amount < 0 ? '-' : '') + canonicalAmount(Math.abs(f.amount), input.currency) })),
      options: options.map((o) => ({ id: o.id, cadence: o.cadence, charge: canonicalAmount(o.chargeAmount, o.currency) })),
    }),
  );

  return {
    inputHash,
    baseline,
    projections,
    verdicts,
    recommendedOptionId: recommended?.id ?? null,
    cheapestOptionId: cheapest.id,
    savingsForgone,
    upgradeTrigger,
    rule: 'Lowest annualized cost among options that keep every weekly closing balance >= reserve floor (inclusive).',
  };
}
