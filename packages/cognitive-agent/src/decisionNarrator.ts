/**
 * Probabilistic layer, jobs (b) and (c): explain deterministic decisions to humans.
 * Claude receives the engine's computed facts and may only restate them. A grounding
 * check verifies that every dollar figure in the narrative appears in the facts.
 */
import { formatMoney } from '@intentguard/deterministic-engine';
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude, llmBackend, LlmTrace } from './claude.js';
import { runClaudeCode } from './claudeCode.js';

export interface Narrative {
  text: string;
  trace: LlmTrace;
  grounded: boolean;
  ungroundedFigures: string[];
}

function moneyFigures(text: string): string[] {
  return [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)].map((m) => m[0].replace(/\s/g, ''));
}

function normalize(fig: string): number {
  return Number(fig.replace(/[$,]/g, ''));
}

/** Every $ figure in the narrative must be one of the facts' numbers. */
export function checkGrounding(text: string, facts: unknown): { grounded: boolean; ungrounded: string[] } {
  const allowed = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') allowed.add(Math.abs(v));
    else if (typeof v === 'string') for (const m of v.matchAll(/\d[\d,]*(?:\.\d+)?/g)) allowed.add(Number(m[0].replace(/,/g, '')));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(facts);
  const ungrounded = moneyFigures(text).filter((f) => !allowed.has(normalize(f)));
  return { grounded: ungrounded.length === 0, ungrounded };
}

async function narrate(system: string, facts: unknown, instruction: string, fallback: () => string): Promise<Narrative> {
  const t0 = Date.now();
  const backend = llmBackend();
  const prompt = `<engine_facts>\n${JSON.stringify(facts, null, 2)}\n</engine_facts>\n${instruction}`;
  if (backend !== 'offline') {
    try {
      let text: string;
      let trace: LlmTrace;
      if (backend === 'api') {
        const res = await getClaude().beta.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 4000,
          ...FALLBACK_PARAMS,
          output_config: { effort: 'low' },
          system,
          messages: [{ role: 'user', content: prompt }],
        });
        if (res.stop_reason === 'refusal') throw new Error('refusal');
        text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
        trace = { engine: 'claude', via: 'api', model: res.model, ms: Date.now() - t0, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, stop_reason: res.stop_reason };
      } else {
        const res = await runClaudeCode({ system, prompt });
        text = res.text.trim();
        trace = { engine: 'claude', via: 'claude-code', model: res.model, ms: res.ms };
      }
      if (!text) throw new Error('empty response');
      const g = checkGrounding(text, facts);
      return { text, grounded: g.grounded, ungroundedFigures: g.ungrounded, trace };
    } catch (e) {
      const text = fallback();
      return { text, grounded: true, ungroundedFigures: [], trace: { engine: 'offline', ms: Date.now() - t0, error: (e as Error).message } };
    }
  }
  return { text: fallback(), grounded: true, ungroundedFigures: [], trace: { engine: 'offline', ms: Date.now() - t0 } };
}

const STYLE = `Write for a CFO reading a dashboard. Plain prose, no headings, no bullet lists, no markdown.
Use ONLY the numbers in <engine_facts>; never compute, round differently, or introduce new figures.
Format money like $36,400.00. Be concrete and brief.`;

export interface PlanFacts {
  opening_balance: number;
  reserve_floor: number;
  cheapest_option: { label: string; charge: number; annualized_cost: number };
  cheapest_first_breach_week: number | null;
  cheapest_week_balance: number | null;
  cheapest_shortfall: number;
  chosen_option: { label: string; charge: number; annualized_cost: number } | null;
  chosen_min_balance: number | null;
  chosen_min_week: number | null;
  savings_forgone: number;
  discount_percent: number;
  upgrade_trigger: { week: number; condition: string } | null;
  cheapest_is_chosen: boolean;
  risk_clauses: { clause_ref: string; kind: string; summary: string; max_amount: number | null }[];
}

export function explainPlan(f: PlanFacts): Promise<Narrative> {
  return narrate(
    `You explain treasury-safe procurement decisions that deterministic code has already made. ${STYLE}`,
    f,
    f.cheapest_is_chosen
      ? 'In 2-3 sentences: say the cheapest option is also safe and was chosen, give its lowest balance against the reserve floor, and name the single contract clause that most threatens the approved price. Do not discuss rejected options.'
      : 'In 3-4 sentences: explain why the engine rejected the cheaper option despite its discount, what was chosen, when the cheaper option will be reconsidered, and name the single contract clause that most threatens the approved price.',
    () => {
      const feeClause = f.risk_clauses.find((r) => r.kind === 'ONBOARDING_FEE');
      if (f.cheapest_is_chosen && f.chosen_option) {
        return (
          `${f.chosen_option.label} at ${formatMoney(f.chosen_option.charge)} is the cheapest option and keeps the lowest balance at ${formatMoney(f.chosen_min_balance ?? 0)} in week ${f.chosen_min_week}, above the ${formatMoney(f.reserve_floor)} reserve floor. ` +
          (feeClause ? `Watch clause ${feeClause.clause_ref}: ${feeClause.summary}` : '')
        );
      }
      const fee = f.risk_clauses.find((r) => r.kind === 'ONBOARDING_FEE');
      return (
        `${f.cheapest_option.label} saves ${f.discount_percent}% (${formatMoney(f.savings_forgone)} a year), but paying ${formatMoney(f.cheapest_option.charge)} upfront drops cash to ${formatMoney(f.cheapest_week_balance ?? 0)} in week ${f.cheapest_first_breach_week}, ${formatMoney(f.cheapest_shortfall)} below the ${formatMoney(f.reserve_floor)} reserve floor. ` +
        (f.chosen_option
          ? `The engine chose ${f.chosen_option.label} at ${formatMoney(f.chosen_option.charge)}, which keeps the lowest balance at ${formatMoney(f.chosen_min_balance ?? 0)} in week ${f.chosen_min_week}. `
          : 'No billing option keeps the reserve intact, so the purchase is escalated. ') +
        (f.upgrade_trigger ? `${f.upgrade_trigger.condition}. ` : '') +
        (fee ? `Watch clause ${fee.clause_ref}: the vendor may add an onboarding fee of up to ${formatMoney(fee.max_amount ?? 0)}, which the card controls will block unless re-approved.` : '')
      );
    },
  );
}

export interface IncidentFacts {
  merchant: string;
  change_type: 'unapproved fee added' | 'billing plan switched';
  approved_cadence: string;
  attempted_cadence: string;
  rail_outcome: 'declined by card limit' | 'approved by card network, then reversed by the agent before settlement';
  funds_moved: false;
  approved_amount: number;
  attempted_amount: number;
  overage: number;
  unapproved_items: { sku: string; description: string; amount: number }[];
  rail_failure_reason: string;
  approved_binding_hash: string;
  observed_binding_hash: string;
  card_status_after: string;
  retry_failure_reason: string | null;
  /** What Airwallex's own documentation says about the decline code (looked up via the Docs MCP). */
  airwallex_docs: { failure_reason: string; description: string; next_steps: string } | null;
  contract_clause: { clause_ref: string; summary: string; max_amount: number | null } | null;
}

export function writeIncidentReport(f: IncidentFacts): Promise<Narrative> {
  return narrate(
    `You write incident summaries for a finance operations team after an agentic checkout was blocked. ${STYLE}`,
    f,
    'In 3-5 sentences: what the merchant attempted, which control stopped it and how, what the agent did to contain it, confirm that no money moved, and what the operator must decide now. Only mention a contract clause if contract_clause is provided.',
    () =>
      (f.change_type === 'billing plan switched'
        ? `${f.merchant} tried to charge ${formatMoney(f.attempted_amount)} on a ${f.attempted_cadence.toLowerCase()} plan instead of the approved ${formatMoney(f.approved_amount)} ${f.approved_cadence.toLowerCase()} plan. `
        : `${f.merchant} attempted to authorize ${formatMoney(f.attempted_amount)} against a card approved for ${formatMoney(f.approved_amount)}, adding ${f.unapproved_items.map((i) => `"${i.description}" (${formatMoney(i.amount)})`).join(', ')}. `) +
      `The charge was ${f.rail_outcome}, and the agent's intent check found the charge hash ${f.observed_binding_hash.slice(0, 12)}… did not match the approved ${f.approved_binding_hash.slice(0, 12)}…. ` +
      `The agent froze the card (${f.card_status_after})${f.retry_failure_reason ? `, and a follow-up attempt to charge the fee separately was declined with ${f.retry_failure_reason}` : ''}. No money moved. ` +
      `${f.contract_clause ? `The fee traces to clause ${f.contract_clause.clause_ref}. ` : ''}The operator must either hold the vendor to the approved ${formatMoney(f.approved_amount)} or sign a new intent that includes the fee.`,
  );
}

export interface SettlementFacts {
  merchant: string;
  settled_amount: number;
  order_id: string;
  reserve_floor: number;
  projected_min_balance: number;
  projected_min_week: number;
  unauthorized_spend: number;
  next_review: string | null;
}

export function writeSettlementSummary(f: SettlementFacts): Promise<Narrative> {
  return narrate(
    `You write closing audit notes for agentic purchases. ${STYLE}`,
    f,
    'In 2-3 sentences: confirm what settled, the reserve position, and the next scheduled review.',
    () =>
      `${f.merchant} order ${f.order_id} settled for exactly ${formatMoney(f.settled_amount)} with ${formatMoney(f.unauthorized_spend)} of unauthorized spend. ` +
      `The projected low point remains ${formatMoney(f.projected_min_balance)} in week ${f.projected_min_week}, above the ${formatMoney(f.reserve_floor)} reserve floor. ` +
      (f.next_review ? `${f.next_review}.` : ''),
  );
}
