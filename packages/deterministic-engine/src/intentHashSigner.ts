/**
 * Cryptographic intent binding.
 *
 *  - PurchaseIntent: the exact terms a human approved (merchant, MCC, SKU, cadence, amount).
 *  - intentHash:    SHA-256 over the canonical JSON of the whole intent.
 *  - bindingHash:   SHA-256 over the payment-relevant projection (merchant, MCC, amount,
 *                   currency, cadence). Any observed charge is projected the same way;
 *                   a different bindingHash means the merchant drifted from the approved terms.
 *  - Approval:      Ed25519 signature by the operator key over the intentHash.
 */
import { generateKeyPairSync, sign, verify, KeyObject, randomUUID } from 'node:crypto';
import { canonicalAmount, Currency, formatMoney, toMajor, toMinor } from './money.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { BillingCadence } from './cashflowProjector.js';

export interface MerchantRef {
  id: string;
  name: string;
  mcc: string;
  country: string;
  domain: string;
}

export interface PurchaseIntent {
  version: 'intentguard/1';
  intentId: string;
  merchant: MerchantRef;
  sku: string;
  description: string;
  seats: number;
  billing: { cadence: BillingCadence; amount: number; currency: Currency };
  reserveCheck: { inputHash: string; reserveFloor: number; projectedMinBalance: number; minWeek: number };
  createdAt: string;
}

export interface LineItem {
  sku: string;
  description: string;
  amount: number;
}

/** What the merchant actually tried to charge (from cart, receipt or card authorization). */
export interface ObservedCharge {
  merchantId: string;
  merchantName: string;
  mcc: string;
  amount: number;
  currency: Currency;
  cadence: BillingCadence;
  lineItems: LineItem[];
  source: 'CART' | 'AUTHORIZATION' | 'RECEIPT';
}

function canonicalIntent(intent: PurchaseIntent) {
  return {
    ...intent,
    billing: { ...intent.billing, amount: canonicalAmount(intent.billing.amount, intent.billing.currency) },
    reserveCheck: {
      ...intent.reserveCheck,
      reserveFloor: canonicalAmount(intent.reserveCheck.reserveFloor, intent.billing.currency),
      projectedMinBalance: canonicalAmount(intent.reserveCheck.projectedMinBalance, intent.billing.currency),
    },
  };
}

export function intentHash(intent: PurchaseIntent): string {
  return sha256Hex(canonicalJson(canonicalIntent(intent)));
}

interface BindingProjection {
  merchant_id: string;
  mcc: string;
  amount: string;
  currency: Currency;
  cadence: BillingCadence;
}

function bindingFromIntent(intent: PurchaseIntent): BindingProjection {
  return {
    merchant_id: intent.merchant.id,
    mcc: intent.merchant.mcc,
    amount: canonicalAmount(intent.billing.amount, intent.billing.currency),
    currency: intent.billing.currency,
    cadence: intent.billing.cadence,
  };
}

function bindingFromObserved(o: ObservedCharge): BindingProjection {
  return {
    merchant_id: o.merchantId,
    mcc: o.mcc,
    amount: canonicalAmount(o.amount, o.currency),
    currency: o.currency,
    cadence: o.cadence,
  };
}

export function bindingHash(p: BindingProjection): string {
  return sha256Hex(canonicalJson(p));
}

export function intentBindingHash(intent: PurchaseIntent): string {
  return bindingHash(bindingFromIntent(intent));
}

export interface IntentDiff {
  field: keyof BindingProjection | 'line_items';
  approved: string;
  observed: string;
  delta?: string;
}

export interface IntentVerification {
  match: boolean;
  approvedBindingHash: string;
  observedBindingHash: string;
  diffs: IntentDiff[];
  unapprovedLineItems: LineItem[];
  overage: number;
  summary: string;
}

export function verifyChargeAgainstIntent(intent: PurchaseIntent, observed: ObservedCharge): IntentVerification {
  const a = bindingFromIntent(intent);
  const b = bindingFromObserved(observed);
  const approvedBindingHash = bindingHash(a);
  const observedBindingHash = bindingHash(b);
  const diffs: IntentDiff[] = [];
  for (const key of Object.keys(a) as (keyof BindingProjection)[]) {
    if (a[key] !== b[key]) {
      const d: IntentDiff = { field: key, approved: String(a[key]), observed: String(b[key]) };
      if (key === 'amount' && a.currency === b.currency) {
        const deltaMinor = toMinor(observed.amount, observed.currency) - toMinor(intent.billing.amount, intent.billing.currency);
        d.delta = `${deltaMinor >= 0 ? '+' : '-'}${formatMoney(toMajor(Math.abs(deltaMinor), observed.currency), observed.currency)}`;
      }
      diffs.push(d);
    }
  }
  const unapprovedLineItems = observed.lineItems.filter((li) => li.sku !== intent.sku);
  if (unapprovedLineItems.length > 0) {
    diffs.push({
      field: 'line_items',
      approved: intent.sku,
      observed: observed.lineItems.map((li) => li.sku).join(', '),
    });
  }
  const overageMinor = Math.max(0, toMinor(observed.amount, observed.currency) - toMinor(intent.billing.amount, intent.billing.currency));
  const match = approvedBindingHash === observedBindingHash && unapprovedLineItems.length === 0;
  return {
    match,
    approvedBindingHash,
    observedBindingHash,
    diffs,
    unapprovedLineItems,
    overage: toMajor(overageMinor, observed.currency),
    summary: match
      ? `Observed ${observed.source.toLowerCase()} matches approved intent (${a.amount} ${a.currency} ${a.cadence}).`
      : `Intent drift on ${observed.source.toLowerCase()}: ${diffs.map((d) => `${d.field} ${d.approved} -> ${d.observed}${d.delta ? ` (${d.delta})` : ''}`).join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// Human approval bound to the exact intent hash
// ---------------------------------------------------------------------------

export interface OperatorKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateOperatorKey(): OperatorKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyId: `operator-${randomUUID().slice(0, 8)}`, privateKey, publicKey };
}

export interface ApprovalRecord {
  intentHash: string;
  approver: string;
  approvedAt: string;
  keyId: string;
  signature: string; // base64 Ed25519 over "intentguard-approval/1:" + intentHash
  scope: string;
}

const APPROVAL_PREFIX = 'intentguard-approval/1:';

export function signApproval(hash: string, approver: string, key: OperatorKey, scope: string, now = new Date()): ApprovalRecord {
  const signature = sign(null, Buffer.from(APPROVAL_PREFIX + hash), key.privateKey).toString('base64');
  return { intentHash: hash, approver, approvedAt: now.toISOString(), keyId: key.keyId, signature, scope };
}

export function verifyApproval(record: ApprovalRecord, intent: PurchaseIntent, publicKey: KeyObject): boolean {
  if (record.intentHash !== intentHash(intent)) return false;
  return verify(null, Buffer.from(APPROVAL_PREFIX + record.intentHash), publicKey, Buffer.from(record.signature, 'base64'));
}
