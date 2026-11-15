/**
 * Mock SaaS merchant with a Visa TAP verifier at its edge.
 *
 * The storefront serves whatever order form is loaded (the CloudScale sample or a
 * contract the operator uploaded) and prices carts from a catalog that is configured
 * from that same order form.
 *
 *  GET  /merchant/quote        agent-browser-auth  -> the order form / terms document
 *  POST /merchant/cart         agent-browser-auth  -> priced cart for a billing cadence
 *  POST /merchant/checkout     agent-payer-auth + agenticPaymentContainer -> network authorization
 *  POST /merchant/orders/:id/retry-extra           -> merchant retries the extra amount separately
 *  POST /merchant/orders/:id/fulfill               -> capture (CLEARING)
 *  POST /merchant/_chaos       demo control: FEE (append an unapproved fee at authorization)
 *                              or CADENCE_FLIP (bill the other cadence's price instead)
 *
 * Requests without a valid TAP signature are treated as untrusted bots (HTTP 403).
 */
import { Router, Request, json } from 'express';
import { randomUUID } from 'node:crypto';
import {
  AgenticPaymentContainer,
  BillingCadence,
  CLOUDSCALE,
  CLOUDSCALE_SKU,
  MerchantRef,
  NonceCache,
  publicKeyFromJwk,
  TapTag,
  toMajor,
  toMinor,
  VENDOR_QUOTE_DOCUMENT,
  verifyTapRequest,
  type LineItem,
} from '@intentguard/deterministic-engine';
import type { IssuingNetworkSimulator, NetworkResult } from './airwallexSimulation.js';
import type { Telemetry } from './telemetry.js';

export type ChaosMode = 'NONE' | 'FEE' | 'CADENCE_FLIP';

export interface Catalog {
  merchant: MerchantRef;
  sku: string;
  product: string;
  /** Price per billing event for each cadence the order form offers. */
  prices: Partial<Record<BillingCadence, number>>;
  /** The fee the vendor's billing system may try to slip in. */
  fee: LineItem;
}

export const DEFAULT_CATALOG: Catalog = {
  merchant: CLOUDSCALE,
  sku: CLOUDSCALE_SKU,
  product: 'CloudScale Enterprise APM - 10 seats',
  prices: { MONTHLY: 1_000, ANNUAL: 9_600 },
  fee: { sku: 'CS-ONBOARD-ENT', description: 'Mandatory Enterprise Onboarding Fee', amount: 250 },
};

export interface Cart {
  cart_id: string;
  merchant_id: string;
  merchant_name: string;
  mcc: string;
  cadence: BillingCadence;
  currency: 'USD';
  line_items: LineItem[];
  total: number;
}

export interface Order {
  order_id: string;
  cart_id: string;
  status: 'PAYMENT_DECLINED' | 'AUTHORIZED' | 'CAPTURED';
  charged_line_items: LineItem[];
  charged_amount: number;
  charged_cadence: BillingCadence;
  card_id: string;
  authorization: NetworkResult;
  capture?: NetworkResult;
}

export interface StorefrontState {
  chaos: ChaosMode;
  quoteDocument: string;
  catalog: Catalog;
  carts: Map<string, Cart>;
  orders: Map<string, Order>;
  blockedBots: number;
}

export function createVendorStorefront(opts: { network: () => IssuingNetworkSimulator; registryUrl: () => string; telemetry: Telemetry }) {
  const state: StorefrontState = {
    chaos: 'NONE',
    quoteDocument: VENDOR_QUOTE_DOCUMENT,
    catalog: DEFAULT_CATALOG,
    carts: new Map(),
    orders: new Map(),
    blockedBots: 0,
  };
  const nonces = new NonceCache();
  const router = Router();
  router.use(json());

  async function resolveKey(keyid: string) {
    const res = await fetch(`${opts.registryUrl()}?keyID=${encodeURIComponent(keyid)}`);
    if (!res.ok) return null;
    return publicKeyFromJwk(await res.json());
  }

  async function verify(req: Request, tag: TapTag, container?: AgenticPaymentContainer) {
    const path = req.baseUrl + req.path;
    const v = await verifyTapRequest({
      authority: req.headers.host ?? '',
      path,
      headers: req.headers as Record<string, string>,
      requiredTag: tag,
      resolveKey,
      nonces,
      container,
    });
    opts.telemetry.emitEvent({
      channel: 'VISA_TAP',
      title: v.ok ? `Merchant verified TAP ${tag}` : `Merchant rejected request: ${v.reason}`,
      level: v.ok ? 'success' : 'error',
      method: req.method,
      path,
      status: v.ok ? 200 : 403,
      request: { 'Signature-Input': req.headers['signature-input'], Signature: req.headers['signature'] ? String(req.headers['signature']).slice(0, 28) + '…' : undefined },
      response: { checks: v.checks, keyid: v.keyid },
    });
    if (!v.ok) state.blockedBots++;
    return v;
  }

  const lineFor = (cadence: BillingCadence): LineItem | null => {
    const price = state.catalog.prices[cadence];
    if (price === undefined) return null;
    return { sku: state.catalog.sku, description: `${state.catalog.product} (${cadence.toLowerCase()})`, amount: price };
  };

  router.get('/quote', async (req, res) => {
    const v = await verify(req, 'agent-browser-auth');
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    res.type('text/plain').send(state.quoteDocument);
  });

  router.post('/cart', async (req, res) => {
    const v = await verify(req, 'agent-browser-auth');
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    const cadence: BillingCadence = req.body?.cadence === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const line = lineFor(cadence);
    if (!line) return res.status(400).json({ error: 'cadence_not_offered', cadence });
    const m = state.catalog.merchant;
    const cart: Cart = { cart_id: `cart_${randomUUID().slice(0, 8)}`, merchant_id: m.id, merchant_name: m.name, mcc: m.mcc, cadence, currency: 'USD', line_items: [line], total: line.amount };
    state.carts.set(cart.cart_id, cart);
    opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `Cart priced ${cart.total.toFixed(2)} USD (${cadence.toLowerCase()})`, level: 'info', method: 'POST', path: '/merchant/cart', status: 201, response: cart });
    res.status(201).json(cart);
  });

  router.post('/checkout', async (req, res) => {
    const { cart_id, card_id, agenticPaymentContainer } = req.body ?? {};
    const v = await verify(req, 'agent-payer-auth', agenticPaymentContainer);
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    const cart = state.carts.get(cart_id);
    if (!cart) return res.status(404).json({ error: 'cart_not_found' });

    // The merchant's billing system decides what it actually authorizes.
    let charged: LineItem[] = [...cart.line_items];
    let chargedCadence = cart.cadence;
    if (state.chaos === 'FEE') {
      charged.push({ ...state.catalog.fee });
      opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `⚠ Merchant billing appended ${state.catalog.fee.description} (+$${state.catalog.fee.amount.toFixed(2)})`, level: 'warn' });
    } else if (state.chaos === 'CADENCE_FLIP') {
      const other: BillingCadence = cart.cadence === 'MONTHLY' ? 'ANNUAL' : 'MONTHLY';
      const line = lineFor(other);
      if (line) {
        charged = [line];
        chargedCadence = other;
        opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `⚠ Merchant billing switched the plan to ${other.toLowerCase()} ($${line.amount.toFixed(2)})`, level: 'warn' });
      }
    }
    const amount = toMajor(charged.reduce((a, li) => a + toMinor(li.amount), 0));

    const authorization = await opts.network().authorize(card_id, amount, cart.currency, cart.mcc, cart.merchant_name);
    const order: Order = {
      order_id: `ord_${randomUUID().slice(0, 8)}`,
      cart_id,
      status: authorization.outcome === 'AUTHORIZED' ? 'AUTHORIZED' : 'PAYMENT_DECLINED',
      charged_line_items: charged,
      charged_amount: amount,
      charged_cadence: chargedCadence,
      card_id,
      authorization,
    };
    state.orders.set(order.order_id, order);
    res.status(order.status === 'AUTHORIZED' ? 201 : 402).json(order);
  });

  /** A merchant retry outside the agent's control: charge the extra amount on its own. */
  router.post('/orders/:id/retry-extra', async (req, res) => {
    const order = state.orders.get(req.params.id);
    const cart = order ? state.carts.get(order.cart_id) : undefined;
    if (!order || !cart) return res.status(404).json({ error: 'order_not_found' });
    const extra = toMajor(Math.max(toMinor(order.charged_amount) - toMinor(cart.total), toMinor(state.catalog.fee.amount)));
    opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `Merchant retries the extra $${extra.toFixed(2)} as a separate charge`, level: 'warn' });
    const authorization = await opts.network().authorize(order.card_id, extra, 'USD', cart.mcc, cart.merchant_name);
    res.status(authorization.outcome === 'AUTHORIZED' ? 201 : 402).json({ authorization, amount: extra });
  });

  router.post('/orders/:id/fulfill', async (req, res) => {
    const order = state.orders.get(req.params.id);
    if (!order || order.status !== 'AUTHORIZED') return res.status(409).json({ error: 'order_not_capturable' });
    const lifecycleId = order.authorization.raw.card_transaction_lifecycle_id;
    if (!lifecycleId) return res.status(409).json({ error: 'missing_lifecycle_id' });
    order.capture = await opts.network().capture(lifecycleId);
    if (order.capture.outcome === 'CLEARED') order.status = 'CAPTURED';
    res.json(order);
  });

  router.post('/_chaos', (req, res) => {
    const mode = req.body?.mode as ChaosMode | undefined;
    state.chaos = mode === 'FEE' || mode === 'CADENCE_FLIP' ? mode : 'NONE';
    opts.telemetry.emitEvent({
      channel: 'MERCHANT',
      title:
        state.chaos === 'FEE'
          ? `Vendor billing rule: append ${state.catalog.fee.description} at authorization`
          : state.chaos === 'CADENCE_FLIP'
            ? 'Vendor billing rule: bill the other plan at authorization'
            : 'Vendor bills exactly the approved cart',
      level: state.chaos === 'NONE' ? 'info' : 'warn',
    });
    res.json({ chaos: state.chaos });
  });

  return {
    router,
    state,
    configure(next: { quoteDocument?: string; catalog?: Catalog }) {
      if (next.quoteDocument !== undefined) state.quoteDocument = next.quoteDocument;
      if (next.catalog) state.catalog = next.catalog;
    },
    reset() {
      state.chaos = 'NONE';
      state.carts.clear();
      state.orders.clear();
      state.blockedBots = 0;
    },
  };
}
