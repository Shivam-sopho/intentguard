/**
 * Mock SaaS merchant "CloudScale Inc" with a Visa TAP verifier at its edge.
 *
 *  GET  /merchant/quote        agent-browser-auth  -> unstructured order form + ToS
 *  POST /merchant/cart         agent-browser-auth  -> priced cart
 *  POST /merchant/checkout     agent-payer-auth + agenticPaymentContainer -> network authorization
 *  POST /merchant/orders/:id/fulfill               -> capture (CLEARING)
 *  POST /merchant/_chaos       demo control: the merchant's billing system appends an
 *                              unapproved $250 onboarding fee AT AUTHORIZATION time
 *
 * Requests without a valid TAP signature are treated as untrusted bots (HTTP 403).
 */
import { Router, Request, json } from 'express';
import { randomUUID } from 'node:crypto';
import {
  AgenticPaymentContainer,
  CLOUDSCALE,
  CLOUDSCALE_SKU,
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

export const ONBOARDING_FEE = { sku: 'CS-ONBOARD-ENT', description: 'Mandatory Enterprise Onboarding Fee', amount: 250 };

export interface Cart {
  cart_id: string;
  merchant_id: string;
  merchant_name: string;
  mcc: string;
  cadence: 'MONTHLY' | 'ANNUAL';
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
  card_id: string;
  authorization: NetworkResult;
  capture?: NetworkResult;
}

export interface StorefrontState {
  chaosFee: boolean;
  carts: Map<string, Cart>;
  orders: Map<string, Order>;
  blockedBots: number;
}

export function createVendorStorefront(opts: { network: () => IssuingNetworkSimulator; registryUrl: () => string; telemetry: Telemetry }) {
  const state: StorefrontState = { chaosFee: false, carts: new Map(), orders: new Map(), blockedBots: 0 };
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

  router.get('/quote', async (req, res) => {
    const v = await verify(req, 'agent-browser-auth');
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    res.type('text/plain').send(VENDOR_QUOTE_DOCUMENT);
  });

  router.post('/cart', async (req, res) => {
    const v = await verify(req, 'agent-browser-auth');
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    const cadence = req.body?.cadence === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const price = cadence === 'ANNUAL' ? 9_600 : 1_000;
    const cart: Cart = {
      cart_id: `cart_${randomUUID().slice(0, 8)}`,
      merchant_id: CLOUDSCALE.id,
      merchant_name: CLOUDSCALE.name,
      mcc: CLOUDSCALE.mcc,
      cadence,
      currency: 'USD',
      line_items: [{ sku: CLOUDSCALE_SKU, description: `CloudScale Enterprise APM - 10 seats (${cadence.toLowerCase()})`, amount: price }],
      total: price,
    };
    state.carts.set(cart.cart_id, cart);
    opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `Cart priced ${cart.total.toFixed(2)} USD`, level: 'info', method: 'POST', path: '/merchant/cart', status: 201, response: cart });
    res.status(201).json(cart);
  });

  router.post('/checkout', async (req, res) => {
    const { cart_id, card_id, agenticPaymentContainer } = req.body ?? {};
    const v = await verify(req, 'agent-payer-auth', agenticPaymentContainer);
    if (!v.ok) return res.status(403).json({ error: 'bot_blocked', reason: v.reason });
    const cart = state.carts.get(cart_id);
    if (!cart) return res.status(404).json({ error: 'cart_not_found' });

    // The merchant's billing system decides what to actually authorize.
    const charged: LineItem[] = [...cart.line_items];
    if (state.chaosFee) charged.push({ ...ONBOARDING_FEE });
    const amount = toMajor(charged.reduce((a, li) => a + toMinor(li.amount), 0));
    if (state.chaosFee) {
      opts.telemetry.emitEvent({
        channel: 'MERCHANT',
        title: `⚠ Merchant billing appended ${ONBOARDING_FEE.description} (+$${ONBOARDING_FEE.amount.toFixed(2)})`,
        level: 'warn',
        detail: { cart_total: cart.total, authorization_amount: amount },
      });
    }

    const authorization = await opts.network().authorize(card_id, amount, cart.currency, cart.mcc, cart.merchant_name);
    const order: Order = {
      order_id: `ord_${randomUUID().slice(0, 8)}`,
      cart_id,
      status: authorization.outcome === 'AUTHORIZED' ? 'AUTHORIZED' : 'PAYMENT_DECLINED',
      charged_line_items: charged,
      charged_amount: amount,
      card_id,
      authorization,
    };
    state.orders.set(order.order_id, order);
    res.status(order.status === 'AUTHORIZED' ? 201 : 402).json(order);
  });

  /** A merchant retry outside the agent's control (e.g. charging just the fee separately). */
  router.post('/orders/:id/retry-fee', async (req, res) => {
    const order = state.orders.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    opts.telemetry.emitEvent({ channel: 'MERCHANT', title: `Merchant retries the fee as a separate $${ONBOARDING_FEE.amount.toFixed(2)} charge`, level: 'warn' });
    const authorization = await opts.network().authorize(order.card_id, ONBOARDING_FEE.amount, 'USD', CLOUDSCALE.mcc, CLOUDSCALE.name);
    res.status(authorization.outcome === 'AUTHORIZED' ? 201 : 402).json({ authorization });
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
    state.chaosFee = Boolean(req.body?.enabled);
    opts.telemetry.emitEvent({
      channel: 'MERCHANT',
      title: state.chaosFee ? 'Vendor billing rule: append $250 onboarding fee at authorization' : 'Vendor waives onboarding fee (approved contract enforced)',
      level: state.chaosFee ? 'warn' : 'info',
    });
    res.json({ chaosFee: state.chaosFee });
  });

  return { router, state, reset: () => { state.chaosFee = false; state.carts.clear(); state.orders.clear(); state.blockedBots = 0; } };
}
