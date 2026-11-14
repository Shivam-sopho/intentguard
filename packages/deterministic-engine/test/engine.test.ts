import { describe, expect, it } from 'vitest';
import {
  assertMajorUnits,
  buildCardCreatePayload,
  buildCardholderRestPayload,
  canonicalAmount,
  CLOUDSCALE,
  CLOUDSCALE_SKU,
  decideBillingPlan,
  DEFAULT_RESERVE_FLOOR,
  evaluateAuthorization,
  generateOperatorKey,
  HORIZON_WEEKS,
  intentHash,
  isUuidV4,
  mapIssuingTransaction,
  mapSimulationResult,
  ProcurementStateMachine,
  PurchaseIntent,
  REFERENCE_OPTIONS,
  scheduledObligations,
  SEED_OPENING_BALANCE,
  signApproval,
  toMcpCardholderPayload,
  toMinor,
  verifyApproval,
  verifyChargeAgainstIntent,
  assertRequestIdFor,
  newRequestId,
} from '../src/index.js';

const input = {
  openingBalance: SEED_OPENING_BALANCE,
  reserveFloor: DEFAULT_RESERVE_FLOOR,
  currency: 'USD' as const,
  horizonWeeks: HORIZON_WEEKS,
  scheduled: scheduledObligations(),
};

function makeIntent(): PurchaseIntent {
  return {
    version: 'intentguard/1',
    intentId: 'int-test',
    merchant: CLOUDSCALE,
    sku: CLOUDSCALE_SKU,
    description: 'CloudScale Enterprise APM - 10 seats',
    seats: 10,
    billing: { cadence: 'MONTHLY', amount: 1000, currency: 'USD' },
    reserveCheck: { inputHash: 'abc', reserveFloor: 40000, projectedMinBalance: 44000, minWeek: 7 },
    createdAt: '2026-11-14T00:00:00.000Z',
  };
}

describe('money', () => {
  it('accepts major units and rejects sub-cent precision', () => {
    expect(() => assertMajorUnits(120.5)).not.toThrow();
    expect(() => assertMajorUnits(1000)).not.toThrow();
    expect(() => assertMajorUnits(120.555)).toThrow(/decimal places/);
    expect(() => assertMajorUnits(-1)).toThrow();
    expect(() => assertMajorUnits(Number.NaN)).toThrow();
  });
  it('round-trips without float drift', () => {
    expect(toMinor(0.1) + toMinor(0.2)).toBe(toMinor(0.3));
    expect(canonicalAmount(1000)).toBe('1000.00');
    expect(canonicalAmount(120.5)).toBe('120.50');
  });
});

describe('cash-flow projector: Week-7 reserve breach', () => {
  const d = decideBillingPlan(input, REFERENCE_OPTIONS);

  it('annual upfront breaches the floor first in week 7 by $3,600', () => {
    const annual = d.projections.ANNUAL_UPFRONT;
    expect(annual.firstBreachWeek).toBe(7);
    expect(annual.weeks[6].closing).toBe(36_400);
    expect(annual.weeks[6].headroom).toBe(-3_600);
    expect(annual.maxShortfall).toBe(3_600);
    // weeks 1-6 stay above the floor
    expect(annual.weeks.slice(0, 6).every((w) => !w.breach)).toBe(true);
  });

  it('monthly stays safe at $44,000 in week 7', () => {
    const monthly = d.projections.MONTHLY;
    expect(monthly.breach).toBe(false);
    expect(monthly.weeks[6].closing).toBe(44_000);
    expect(monthly.minBalance).toBe(44_000);
  });

  it('selects monthly despite the 20% annual discount and records forgone savings', () => {
    expect(d.cheapestOptionId).toBe('ANNUAL_UPFRONT');
    expect(d.recommendedOptionId).toBe('MONTHLY');
    expect(d.savingsForgone).toBe(2_400);
  });

  it('computes the week-8 upgrade trigger from the receivable', () => {
    expect(d.upgradeTrigger?.week).toBe(8);
    expect(d.upgradeTrigger?.enabledBy.map((f) => f.id)).toEqual(['ar-2291-w8']);
    expect(d.upgradeTrigger?.projectedMinBalance).toBeGreaterThanOrEqual(DEFAULT_RESERVE_FLOOR);
  });

  it('treats the floor as inclusive', () => {
    const exact = decideBillingPlan({ ...input, reserveFloor: 36_400 }, REFERENCE_OPTIONS);
    expect(exact.projections.ANNUAL_UPFRONT.breach).toBe(false);
    expect(exact.recommendedOptionId).toBe('ANNUAL_UPFRONT');
    const oneCent = decideBillingPlan({ ...input, reserveFloor: 36_400.01 }, REFERENCE_OPTIONS);
    expect(oneCent.projections.ANNUAL_UPFRONT.breach).toBe(true);
  });

  it('recommends nothing when no option is safe', () => {
    const none = decideBillingPlan({ ...input, reserveFloor: 50_000 }, REFERENCE_OPTIONS);
    expect(none.recommendedOptionId).toBeNull();
  });

  it('input hash is stable and changes with inputs', () => {
    expect(decideBillingPlan(input, REFERENCE_OPTIONS).inputHash).toBe(d.inputHash);
    expect(decideBillingPlan({ ...input, openingBalance: 58_000.01 }, REFERENCE_OPTIONS).inputHash).not.toBe(d.inputHash);
  });
});

describe('intent hash', () => {
  it('is deterministic and key-order independent', () => {
    const a = makeIntent();
    const b = JSON.parse(JSON.stringify(a));
    const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as PurchaseIntent;
    expect(intentHash(reordered)).toBe(intentHash(a));
  });

  it('detects the $250 onboarding-fee drift', () => {
    const v = verifyChargeAgainstIntent(makeIntent(), {
      merchantId: 'cloudscale-inc',
      merchantName: 'CloudScale Inc',
      mcc: '5734',
      amount: 1250,
      currency: 'USD',
      cadence: 'MONTHLY',
      lineItems: [
        { sku: CLOUDSCALE_SKU, description: 'APM', amount: 1000 },
        { sku: 'CS-ONBOARD-ENT', description: 'Mandatory Enterprise Onboarding Fee', amount: 250 },
      ],
      source: 'AUTHORIZATION',
    });
    expect(v.match).toBe(false);
    expect(v.approvedBindingHash).not.toBe(v.observedBindingHash);
    expect(v.overage).toBe(250);
    expect(v.diffs.find((x) => x.field === 'amount')?.delta).toBe('+$250.00');
    expect(v.unapprovedLineItems.map((l) => l.sku)).toEqual(['CS-ONBOARD-ENT']);
  });

  it('matches the exact approved charge', () => {
    const v = verifyChargeAgainstIntent(makeIntent(), {
      merchantId: 'cloudscale-inc',
      merchantName: 'CloudScale Inc',
      mcc: '5734',
      amount: 1000,
      currency: 'USD',
      cadence: 'MONTHLY',
      lineItems: [{ sku: CLOUDSCALE_SKU, description: 'APM', amount: 1000 }],
      source: 'CART',
    });
    expect(v.match).toBe(true);
    expect(v.approvedBindingHash).toBe(v.observedBindingHash);
  });

  it('flags a cadence flip even at the same amount', () => {
    const v = verifyChargeAgainstIntent(makeIntent(), {
      merchantId: 'cloudscale-inc', merchantName: 'CloudScale Inc', mcc: '5734', amount: 1000, currency: 'USD',
      cadence: 'ANNUAL', lineItems: [{ sku: CLOUDSCALE_SKU, description: 'APM', amount: 1000 }], source: 'CART',
    });
    expect(v.match).toBe(false);
    expect(v.diffs.map((x) => x.field)).toContain('cadence');
  });

  it('approval signature is bound to the exact intent', () => {
    const key = generateOperatorKey();
    const intent = makeIntent();
    const rec = signApproval(intentHash(intent), 'ops@acme', key, 'test');
    expect(verifyApproval(rec, intent, key.publicKey)).toBe(true);
    const tampered = { ...intent, billing: { ...intent.billing, amount: 1250 } };
    expect(verifyApproval(rec, tampered, key.publicKey)).toBe(false);
  });
});

describe('card policy', () => {
  const intent = makeIntent();
  const payload = buildCardCreatePayload(intent, 'ch_1', intentHash(intent), { createdBy: 'IntentGuard Agent', activeDays: 35 });
  const c = payload.authorization_controls;

  it('builds a valid Airwallex cards/create payload', () => {
    expect(isUuidV4(payload.request_id)).toBe(true);
    expect(c.allowed_transaction_count).toBe('MULTIPLE');
    expect(c.allowed_currencies).toEqual(['USD']);
    expect(c.allowed_merchant_categories).toEqual(['5734']);
    expect(c.transaction_limits.limits).toEqual([
      { amount: 1000, interval: 'PER_TRANSACTION' },
      { amount: 1000, interval: 'MONTHLY' },
    ]);
    expect(payload.form_factor).toBe('VIRTUAL');
  });

  it('mints a fresh request_id per payload', () => {
    const p2 = buildCardCreatePayload(intent, 'ch_1', intentHash(intent), { createdBy: 'x', activeDays: 35 });
    expect(p2.request_id).not.toBe(payload.request_id);
  });

  it('limits are inclusive: $1,000.00 passes, $1,000.01 and $1,250 fail', () => {
    const usage = { spent: {}, approvedCount: 0 };
    expect(evaluateAuthorization(c, 'ACTIVE', usage, { amount: 1000, currency: 'USD', mcc: '5734' }).approve).toBe(true);
    const over = evaluateAuthorization(c, 'ACTIVE', usage, { amount: 1000.01, currency: 'USD', mcc: '5734' });
    expect(over.approve).toBe(false);
    expect(over.failure_reason).toBe('LIMIT_EXCEEDED');
    expect(evaluateAuthorization(c, 'ACTIVE', usage, { amount: 1250, currency: 'USD', mcc: '5734' }).failure_reason).toBe('LIMIT_EXCEEDED');
  });

  it('MONTHLY limit blocks split-charge attacks', () => {
    const usage = { spent: { MONTHLY: 600 }, approvedCount: 1 };
    const r = evaluateAuthorization(c, 'ACTIVE', usage, { amount: 650, currency: 'USD', mcc: '5734' });
    expect(r.failure_reason).toBe('LIMIT_EXCEEDED');
  });

  it('frozen card, wrong MCC and wrong currency are declined', () => {
    const usage = { spent: {}, approvedCount: 0 };
    expect(evaluateAuthorization(c, 'INACTIVE', usage, { amount: 250, currency: 'USD', mcc: '5734' }).failure_reason).toBe('CARD_INACTIVE');
    expect(evaluateAuthorization(c, 'ACTIVE', usage, { amount: 10, currency: 'USD', mcc: '7995' }).failure_reason).toBe('MERCHANT_CATEGORY_NOT_ALLOWED');
    expect(evaluateAuthorization(c, 'ACTIVE', usage, { amount: 10, currency: 'EUR', mcc: '5734' }).failure_reason).toBe('CURRENCY_NOT_ALLOWED');
  });

  it('maps REST type <-> MCP cardholder_type', () => {
    const rest = buildCardholderRestPayload({
      email: 'a@b.co', firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01',
      address: { line1: '1 St', city: 'Sydney', postcode: '2000', country: 'AU' },
    });
    expect(rest.type).toBe('INDIVIDUAL');
    const mcp = toMcpCardholderPayload(rest);
    expect(mcp.cardholder_type).toBe('INDIVIDUAL');
    expect('type' in mcp).toBe(false);
  });
});

describe('request_id ledger', () => {
  it('refuses to reuse an id for a different operation', () => {
    const id = newRequestId('POST /api/v1/issuing/cards/create');
    expect(() => assertRequestIdFor(id, 'POST /api/v1/issuing/cards/create')).not.toThrow();
    expect(() => assertRequestIdFor(id, 'POST /api/v1/issuing/cards/abc/update')).toThrow(/cannot be reused/);
  });
});

describe('rail mapping', () => {
  it('maps simulation responses per the builder guide', () => {
    expect(mapSimulationResult({ process_result: 'DECLINED', failure_reason: 'LIMIT_EXCEEDED', type: 'AUTHORIZATION' })).toEqual({ outcome: 'FAILED', failure_reason: 'LIMIT_EXCEEDED' });
    expect(mapSimulationResult({ process_result: 'APPROVED', type: 'AUTHORIZATION' }).outcome).toBe('AUTHORIZED');
    expect(mapSimulationResult({ process_result: 'APPROVED', type: 'CLEARING' }).outcome).toBe('CLEARED');
    expect(mapIssuingTransaction({ transaction_type: 'CLEARING', status: 'APPROVED' }).outcome).toBe('CLEARED');
    expect(mapIssuingTransaction({ transaction_type: 'AUTHORIZATION', status: 'FAILED', failure_reason: 'CARD_INACTIVE' }).outcome).toBe('FAILED');
  });
});

describe('state machine', () => {
  it('runs the happy path with guards and blocks illegal jumps', () => {
    const m = new ProcurementStateMachine();
    expect(() => m.transition('SETTLED')).toThrow();
    m.transition('GUARDRAILS_SET');
    expect(() => m.transition('PLAN_PROPOSED', { safePlanExists: false })).toThrow();
    m.transition('PLAN_PROPOSED', { safePlanExists: true });
    m.transition('AWAITING_APPROVAL');
    expect(() => m.transition('APPROVED', { approvalSignatureValid: false })).toThrow();
    m.transition('APPROVED', { approvalSignatureValid: true });
    m.transition('CARD_ISSUED', { cardId: 'c1', cardStatus: 'ACTIVE' });
    m.transition('CHECKOUT_IN_PROGRESS', { bindingMatch: true });
    expect(() => m.transition('QUARANTINED_FROZEN', { cardStatus: 'ACTIVE' })).toThrow(/frozen/);
    m.transition('QUARANTINED_FROZEN', { cardStatus: 'INACTIVE' });
    expect(() => m.transition('CARD_ISSUED', { reapprovalSignatureValid: true, bindingMatch: false, cardStatus: 'ACTIVE' })).toThrow();
    m.transition('CARD_ISSUED', { reapprovalSignatureValid: true, bindingMatch: true, cardStatus: 'ACTIVE' });
    m.transition('CHECKOUT_IN_PROGRESS', { bindingMatch: true });
    m.transition('AUTHORIZED', { railOutcome: 'AUTHORIZED', bindingMatch: true });
    expect(() => m.transition('SETTLED', { railOutcome: 'AUTHORIZED' })).toThrow();
    m.transition('SETTLED', { railOutcome: 'CLEARED' });
    expect(m.state).toBe('SETTLED');
  });
});
