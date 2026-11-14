/**
 * The CloudScale demo scenario. All numbers are internally consistent and verified
 * by test/scenario.test.ts:
 *
 *   Opening USD balance $58,000.00, reserve floor $40,000.00
 *   Weeks 1-8 opex -$1,000/wk; week 7 payroll + payroll tax -$5,000; week 8 receivable +$18,000
 *
 *   Annual upfront ($9,600 in week 1): week-7 close $36,400.00 -> breach by $3,600.00
 *   Monthly ($1,000 in weeks 1 and 5):  week-7 close $44,000.00 -> safe
 *   Re-evaluate annual in week 8, after the $18,000 receivable clears.
 */
import type { BillingOption, ScheduledFlow } from './cashflowProjector.js';
import type { MerchantRef } from './intentHashSigner.js';

export const SEED_OPENING_BALANCE = 58_000;
export const DEFAULT_RESERVE_FLOOR = 40_000;
export const HORIZON_WEEKS = 8;

export const CLOUDSCALE: MerchantRef = {
  id: 'cloudscale-inc',
  name: 'CloudScale Inc',
  mcc: '5734', // Computer Software Stores
  country: 'US',
  domain: 'checkout.cloudscale.example',
};

export const CLOUDSCALE_SKU = 'CS-APM-ENT-10';

export function scheduledObligations(): ScheduledFlow[] {
  const flows: ScheduledFlow[] = [];
  for (let w = 1; w <= HORIZON_WEEKS; w++) {
    flows.push({ id: `opex-w${w}`, week: w, amount: -1_000, label: 'Operating expenses', kind: 'OPEX' });
  }
  flows.push({ id: 'payroll-w7', week: 7, amount: -5_000, label: 'Payroll + payroll tax', kind: 'PAYROLL' });
  flows.push({ id: 'ar-2291-w8', week: 8, amount: 18_000, label: 'Receivable AR-2291 (Northwind Corp)', kind: 'RECEIVABLE' });
  return flows;
}

/** Ground-truth options (used by the offline parser fallback and to sanity-check LLM extraction). */
export const REFERENCE_OPTIONS: BillingOption[] = [
  {
    id: 'ANNUAL_UPFRONT',
    label: 'Annual upfront',
    cadence: 'ANNUAL',
    chargeAmount: 9_600,
    currency: 'USD',
    annualizedCost: 9_600,
    refundable: false,
  },
  {
    id: 'MONTHLY',
    label: 'Monthly flexible',
    cadence: 'MONTHLY',
    chargeAmount: 1_000,
    currency: 'USD',
    annualizedCost: 12_000,
    refundable: true,
  },
];

export const VENDOR_QUOTE_DOCUMENT = `CLOUDSCALE INC. - ORDER FORM Q-2026-1187
Product: CloudScale Enterprise APM (SKU CS-APM-ENT-10), 10 seats
Customer: Acme Robotics Pty Ltd - Procurement
Merchant category: Computer software (MCC 5734)

PRICING OPTIONS (USD, exclusive of tax)
Option A - Annual Upfront: USD 9,600.00 billed immediately for a 12-month term.
  That is a 20% discount versus the monthly list price (USD 12,000.00 per year).
  Annual fees are non-refundable once invoiced.
Option B - Monthly Flexible: USD 1,000.00 per month, billed monthly in advance.
  Cancel any time with 30 days' written notice.

TERMS OF SERVICE (EXCERPT)
4.2 Renewal. Annual subscriptions renew automatically for successive 12-month terms
    at then-current list price unless cancelled 60 days before the renewal date.
4.5 Onboarding. CloudScale may charge a one-time Enterprise Onboarding Fee of up to
    USD 250.00 where professional onboarding services are provisioned.
4.7 Seat minimum. Enterprise plans require a minimum of 10 seats.
7.1 Price changes. Monthly prices may change on 30 days' notice.
`;
