/**
 * Airwallex Issuing payload builders and a deterministic "shadow" evaluator that
 * predicts how the card controls should treat an authorization. The rail is the
 * authority; the shadow evaluation lets us detect if the rail and our policy disagree.
 *
 * Conventions (Airwallex builder guide):
 *  - amounts in major units
 *  - fresh UUIDv4 request_id per POST
 *  - per-transaction limits are inclusive (<=)
 *  - PER_TRANSACTION limits are not cumulative -> add a MONTHLY (or ALL_TIME) limit too
 *  - REST cardholder uses `type`; the Airwallex MCP tool uses `cardholder_type`
 */
import { assertMajorUnits, Currency, toMajor, toMinor } from './money.js';
import type { PurchaseIntent } from './intentHashSigner.js';
import { newRequestId } from './idempotency.js';

export type LimitInterval = 'PER_TRANSACTION' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'ALL_TIME';

export interface TransactionLimit {
  amount: number;
  interval: LimitInterval;
}

export interface AuthorizationControls {
  allowed_transaction_count: 'SINGLE' | 'MULTIPLE';
  allowed_currencies?: Currency[];
  allowed_merchant_categories?: string[];
  transaction_limits: { currency: Currency; limits: TransactionLimit[] };
  active_from?: string;
  active_to?: string;
}

export interface CardCreatePayload {
  request_id: string;
  cardholder_id: string;
  created_by: string;
  form_factor: 'VIRTUAL';
  is_personalized: boolean;
  program: { purpose: 'COMMERCIAL' };
  purpose: 'SUBSCRIPTIONS';
  nick_name: string;
  authorization_controls: AuthorizationControls;
  metadata: Record<string, string>;
}

export interface CardholderIdentity {
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  address: { line1: string; city: string; state?: string; postcode: string; country: string };
}

/** REST: POST /api/v1/issuing/cardholders/create uses `type`. */
export function buildCardholderRestPayload(id: CardholderIdentity) {
  return {
    type: 'INDIVIDUAL' as const,
    email: id.email,
    individual: {
      name: { first_name: id.firstName, last_name: id.lastName },
      date_of_birth: id.dateOfBirth,
      address: id.address,
      express_consent_obtained: 'yes',
    },
  };
}

/** Airwallex Developer MCP tool input uses `cardholder_type` instead of `type`. */
export function toMcpCardholderPayload(rest: ReturnType<typeof buildCardholderRestPayload>) {
  const { type, ...rest2 } = rest;
  return { cardholder_type: type, ...rest2 };
}

export function fromMcpCardholder(mcp: { cardholder_type: string } & Record<string, unknown>) {
  const { cardholder_type, ...rest } = mcp;
  return { type: cardholder_type, ...rest };
}

export interface CardPolicyOptions {
  createdBy: string;
  /** Validity window for the card in days (subscription cards: one billing period + grace). */
  activeDays: number;
  now?: Date;
}

/**
 * Card policy for a recurring SaaS intent:
 *   PER_TRANSACTION = approved charge (inclusive, so exactly $1,000.00 passes, $1,000.01 fails)
 *   MONTHLY         = approved charge (blocks split-charge attacks: $600 + $650)
 *   allowed_merchant_categories = [intent MCC], allowed_currencies = [intent currency]
 *   allowed_transaction_count   = MULTIPLE for MONTHLY cadence (the card must survive renewals),
 *                                 SINGLE for one-off purchases.
 */
export function buildCardCreatePayload(intent: PurchaseIntent, cardholderId: string, hash: string, opts: CardPolicyOptions): CardCreatePayload {
  const { amount, currency, cadence } = intent.billing;
  assertMajorUnits(amount, currency);
  const now = opts.now ?? new Date();
  const activeTo = new Date(now.getTime() + opts.activeDays * 86_400_000);
  const cumulative: LimitInterval = cadence === 'MONTHLY' ? 'MONTHLY' : 'ALL_TIME';
  return {
    request_id: newRequestId('POST /api/v1/issuing/cards/create'),
    cardholder_id: cardholderId,
    created_by: opts.createdBy,
    form_factor: 'VIRTUAL',
    is_personalized: false,
    program: { purpose: 'COMMERCIAL' },
    purpose: 'SUBSCRIPTIONS',
    nick_name: `IntentGuard ${intent.merchant.name} ${cadence}`.slice(0, 40),
    authorization_controls: {
      allowed_transaction_count: cadence === 'MONTHLY' ? 'MULTIPLE' : 'SINGLE',
      allowed_currencies: [currency],
      allowed_merchant_categories: [intent.merchant.mcc],
      transaction_limits: {
        currency,
        limits: [
          { amount, interval: 'PER_TRANSACTION' },
          { amount, interval: cumulative },
        ],
      },
      active_from: now.toISOString(),
      active_to: activeTo.toISOString(),
    },
    metadata: {
      intent_id: intent.intentId,
      intent_hash: hash,
      merchant_id: intent.merchant.id,
    },
  };
}

export interface CardUsage {
  /** Approved spend per interval so far, major units. */
  spent: Partial<Record<LimitInterval, number>>;
  approvedCount: number;
}

export interface AuthAttempt {
  amount: number;
  currency: Currency;
  mcc: string;
  at?: Date;
}

export type DeclineReason =
  | 'CARD_INACTIVE'
  | 'CARD_CLOSED'
  | 'LIMIT_EXCEEDED'
  | 'CURRENCY_NOT_ALLOWED'
  | 'MERCHANT_CATEGORY_NOT_ALLOWED'
  | 'TRANSACTION_BLOCKED';

export interface ShadowDecision {
  approve: boolean;
  failure_reason?: DeclineReason;
  rule: string;
  /** Per-limit headroom after this auth (major units), for display. */
  remaining: { interval: LimitInterval; limit: number; remaining: number }[];
}

/** Deterministic prediction of the issuer decision for an authorization. */
export function evaluateAuthorization(
  controls: AuthorizationControls,
  cardStatus: string,
  usage: CardUsage,
  auth: AuthAttempt,
): ShadowDecision {
  assertMajorUnits(auth.amount, auth.currency);
  const remaining = controls.transaction_limits.limits.map((l) => {
    const spent = l.interval === 'PER_TRANSACTION' ? 0 : usage.spent[l.interval] ?? 0;
    return { interval: l.interval, limit: l.amount, remaining: toMajor(toMinor(l.amount) - toMinor(spent)) };
  });
  const decline = (failure_reason: DeclineReason, rule: string): ShadowDecision => ({ approve: false, failure_reason, rule, remaining });

  if (cardStatus === 'CLOSED') return decline('CARD_CLOSED', 'card_status = CLOSED');
  if (cardStatus !== 'ACTIVE') return decline('CARD_INACTIVE', `card_status = ${cardStatus}`);
  const at = auth.at ?? new Date();
  if (controls.active_from && at < new Date(controls.active_from)) return decline('TRANSACTION_BLOCKED', 'before active_from');
  if (controls.active_to && at > new Date(controls.active_to)) return decline('TRANSACTION_BLOCKED', 'after active_to');
  if (controls.allowed_transaction_count === 'SINGLE' && usage.approvedCount >= 1) {
    return decline('TRANSACTION_BLOCKED', 'SINGLE-use card already used');
  }
  if (controls.allowed_currencies?.length && !controls.allowed_currencies.includes(auth.currency)) {
    return decline('CURRENCY_NOT_ALLOWED', `${auth.currency} not in [${controls.allowed_currencies.join(', ')}]`);
  }
  if (controls.allowed_merchant_categories?.length && !controls.allowed_merchant_categories.includes(auth.mcc)) {
    return decline('MERCHANT_CATEGORY_NOT_ALLOWED', `MCC ${auth.mcc} not in [${controls.allowed_merchant_categories.join(', ')}]`);
  }
  const amt = toMinor(auth.amount);
  for (const r of remaining) {
    // Inclusive: amount == remaining is allowed, one cent over is not.
    if (amt > toMinor(r.remaining)) {
      return decline('LIMIT_EXCEEDED', `${auth.amount.toFixed(2)} > ${r.remaining.toFixed(2)} remaining on ${r.interval} limit ${r.limit.toFixed(2)} (inclusive)`);
    }
  }
  return {
    approve: true,
    rule: 'within all controls',
    remaining: remaining.map((r) => ({ ...r, remaining: toMajor(toMinor(r.remaining) - amt) })),
  };
}
