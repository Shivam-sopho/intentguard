/**
 * Probabilistic layer, job (a): turn an unstructured vendor order form + ToS into typed
 * billing options and risk clauses.
 *
 * The model's output is UNTRUSTED. Deterministic checks run afterwards:
 *   - every charge amount must literally appear in the source document,
 *   - every source_quote must be a verbatim substring of the document,
 *   - annualized cost is recomputed in code (the model's figure is only cross-checked).
 */
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BillingOption } from '@intentguard/deterministic-engine';
import { toMajor, toMinor } from '@intentguard/deterministic-engine';
import { CLAUDE_MODEL, claudeAvailable, FALLBACK_PARAMS, getClaude, LlmTrace } from './claude.js';

const OptionSchema = z.object({
  id: z.string().describe('Stable id, e.g. ANNUAL_UPFRONT or MONTHLY'),
  label: z.string(),
  cadence: z.enum(['MONTHLY', 'ANNUAL']),
  charge_amount: z.number().describe('Amount charged per billing event, in major units (1000 = $1,000.00)'),
  annualized_cost: z.number().describe('Total cost for 12 months in major units'),
  refundable: z.boolean(),
  source_quote: z.string().describe('Verbatim text from the document stating this price'),
});

const RiskSchema = z.object({
  clause_ref: z.string(),
  kind: z.enum(['AUTO_RENEWAL', 'ONBOARDING_FEE', 'SEAT_MINIMUM', 'PRICE_CHANGE', 'CANCELLATION', 'NON_REFUNDABLE', 'OTHER']),
  summary: z.string().describe('One sentence, plain English, why procurement should care'),
  max_amount: z.number().nullable().describe('Maximum extra charge in major units if stated, else null'),
  source_quote: z.string().describe('Verbatim text from the document'),
});

export const ContractExtractionSchema = z.object({
  vendor_name: z.string(),
  product: z.string(),
  sku: z.string(),
  seats: z.number().int(),
  merchant_category_code: z.string(),
  currency: z.string(),
  options: z.array(OptionSchema),
  risk_clauses: z.array(RiskSchema),
});

export type ContractExtraction = z.infer<typeof ContractExtractionSchema>;

export interface GroundingIssue {
  path: string;
  problem: string;
}

export interface ParsedContract {
  extraction: ContractExtraction;
  options: BillingOption[];
  grounding: { ok: boolean; issues: GroundingIssue[] };
  trace: LlmTrace;
}

const SYSTEM = `You are the contract-reading component of a corporate procurement agent.
Extract the billing options and risk clauses from the vendor document exactly as written.
Rules:
- Amounts are major units (USD 9,600.00 -> 9600). Never invent or compute prices that are not stated.
- annualized_cost: for a monthly price, 12 x the monthly charge; for an annual upfront price, that price.
- source_quote fields must be copied verbatim from the document (a short exact phrase containing the figure).
- Flag every clause that can add cost or lock the buyer in (fees, auto-renewal, seat minimums, price changes, non-refundable terms).
You do not decide which option to buy; downstream deterministic code does.`;

function normalizeNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

function squash(s: string) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function groundExtraction(doc: string, x: ContractExtraction): { ok: boolean; issues: GroundingIssue[]; options: BillingOption[] } {
  const issues: GroundingIssue[] = [];
  const numbers = normalizeNumbers(doc);
  const flat = squash(doc);
  const options: BillingOption[] = [];

  x.options.forEach((o, i) => {
    if (!numbers.has(o.charge_amount)) issues.push({ path: `options[${i}].charge_amount`, problem: `${o.charge_amount} does not appear in the document` });
    if (!flat.includes(squash(o.source_quote))) issues.push({ path: `options[${i}].source_quote`, problem: 'quote is not verbatim from the document' });
    let annualized: number;
    try {
      annualized = o.cadence === 'MONTHLY' ? toMajor(toMinor(o.charge_amount) * 12) : o.charge_amount;
    } catch (e) {
      issues.push({ path: `options[${i}].charge_amount`, problem: (e as Error).message });
      return;
    }
    if (toMinor(annualized) !== toMinor(o.annualized_cost)) {
      issues.push({ path: `options[${i}].annualized_cost`, problem: `model said ${o.annualized_cost}, code computes ${annualized} (code value used)` });
    }
    options.push({
      id: o.cadence === 'ANNUAL' ? 'ANNUAL_UPFRONT' : 'MONTHLY',
      label: o.cadence === 'ANNUAL' ? 'Annual upfront' : 'Monthly flexible',
      cadence: o.cadence,
      chargeAmount: o.charge_amount,
      currency: 'USD',
      annualizedCost: annualized,
      refundable: o.refundable,
    });
  });
  x.risk_clauses.forEach((r, i) => {
    if (!flat.includes(squash(r.source_quote))) issues.push({ path: `risk_clauses[${i}].source_quote`, problem: 'quote is not verbatim from the document' });
  });
  // Only price-affecting problems block the plan; an annualized mismatch is corrected by code.
  const blocking = issues.filter((i) => !i.path.endsWith('annualized_cost'));
  return { ok: blocking.length === 0, issues, options };
}

/** Deterministic regex parser used when Claude is not configured (clearly labelled offline). */
export function offlineParse(doc: string): ContractExtraction {
  const num = (s: string) => Number(s.replace(/,/g, ''));
  const annual = /Option A - Annual Upfront: USD ([\d,]+\.\d{2})/.exec(doc);
  const monthly = /Option B - Monthly Flexible: USD ([\d,]+\.\d{2}) per month/.exec(doc);
  const fee = /Onboarding Fee of up to\s+USD ([\d,]+\.\d{2})/.exec(doc);
  if (!annual || !monthly) throw new Error('offline parser could not find pricing options');
  return {
    vendor_name: 'CloudScale Inc',
    product: 'CloudScale Enterprise APM',
    sku: /SKU ([A-Z0-9-]+)/.exec(doc)?.[1] ?? 'UNKNOWN',
    seats: Number(/(\d+) seats/.exec(doc)?.[1] ?? 0),
    merchant_category_code: /MCC (\d{4})/.exec(doc)?.[1] ?? '',
    currency: 'USD',
    options: [
      { id: 'ANNUAL_UPFRONT', label: 'Annual upfront', cadence: 'ANNUAL', charge_amount: num(annual[1]), annualized_cost: num(annual[1]), refundable: false, source_quote: annual[0] },
      { id: 'MONTHLY', label: 'Monthly flexible', cadence: 'MONTHLY', charge_amount: num(monthly[1]), annualized_cost: num(monthly[1]) * 12, refundable: true, source_quote: monthly[0] },
    ],
    risk_clauses: [
      { clause_ref: '4.2', kind: 'AUTO_RENEWAL', summary: 'Annual plans auto-renew unless cancelled 60 days before renewal.', max_amount: null, source_quote: '4.2 Renewal.' },
      { clause_ref: '4.5', kind: 'ONBOARDING_FEE', summary: 'Vendor reserves the right to add a one-time onboarding fee.', max_amount: fee ? num(fee[1]) : null, source_quote: '4.5 Onboarding.' },
      { clause_ref: '4.7', kind: 'SEAT_MINIMUM', summary: 'Enterprise plan requires at least 10 seats.', max_amount: null, source_quote: '4.7 Seat minimum.' },
      { clause_ref: 'A', kind: 'NON_REFUNDABLE', summary: 'Annual fees are non-refundable once invoiced.', max_amount: null, source_quote: 'Annual fees are non-refundable once invoiced.' },
    ],
  };
}

export async function parseVendorContract(doc: string): Promise<ParsedContract> {
  const t0 = Date.now();
  let extraction: ContractExtraction;
  let trace: LlmTrace;
  if (claudeAvailable()) {
    try {
      const res = await getClaude().beta.messages.parse({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        ...FALLBACK_PARAMS,
        output_config: { effort: 'low', format: betaZodOutputFormat(ContractExtractionSchema) },
        system: SYSTEM,
        messages: [{ role: 'user', content: `<vendor_document>\n${doc}\n</vendor_document>\nExtract the structured contract terms.` }],
      });
      if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`no structured output (stop_reason=${res.stop_reason})`);
      extraction = res.parsed_output;
      trace = { engine: 'claude', model: res.model, ms: Date.now() - t0, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, stop_reason: res.stop_reason };
    } catch (e) {
      extraction = offlineParse(doc);
      trace = { engine: 'offline', ms: Date.now() - t0, error: `Claude call failed, used offline parser: ${(e as Error).message}` };
    }
  } else {
    extraction = offlineParse(doc);
    trace = { engine: 'offline', ms: Date.now() - t0 };
  }
  const g = groundExtraction(doc, extraction);
  return { extraction, options: g.options, grounding: { ok: g.ok, issues: g.issues }, trace };
}
