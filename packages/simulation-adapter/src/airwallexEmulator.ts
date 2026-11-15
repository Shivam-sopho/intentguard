/**
 * Offline emulator of the Airwallex Issuing + simulation endpoints we use.
 * Engaged when sandbox credentials are missing or the sandbox is unreachable, and
 * ALWAYS labelled "EMULATOR" in telemetry and the UI - never presented as live.
 *
 * Mirrors documented Airwallex semantics: 202 on create, inclusive limits,
 * PER_TRANSACTION + cumulative intervals with `remaining`, INACTIVE -> CARD_INACTIVE,
 * MCC / currency allowlists, process_result + failure_reason on simulated auths,
 * lifecycle-based capture/reverse.
 */
import { randomUUID, randomInt } from 'node:crypto';
import { assertRequestIdFor, CardCreatePayload, evaluateAuthorization, LimitInterval, toMajor, toMinor } from '@intentguard/deterministic-engine';
import { redact, Telemetry } from './telemetry.js';
import type { Balance, Card, Cardholder, CardholderPayload, CardLimits, IssuingRail, IssuingSimulationApi, SimAuthRequest, SimulatedTransaction } from './types.js';

interface CardState {
  card: Card;
  pan: string;
  spent: Partial<Record<LimitInterval, number>>; // minor units
  approvedCount: number;
}

interface Lifecycle {
  id: string;
  cardId: string;
  amount: number;
  currency: string;
  mcc: string;
  merchant: string;
  state: 'AUTHORIZED' | 'CLEARED' | 'REVERSED';
}

export class EmulatedAirwallexRail implements IssuingRail {
  readonly mode = 'EMULATOR' as const;
  private cardholders = new Map<string, Cardholder>();
  private cards = new Map<string, CardState>();
  private lifecycles = new Map<string, Lifecycle>();
  private seenRequestIds = new Map<string, unknown>();
  readonly simulation: IssuingSimulationApi;

  constructor(
    private telemetry: Telemetry,
    private balances: Balance[] = [{ account_type: 'cash', currency: 'USD', available_amount: 58_000, pending_amount: 0, reserved_amount: 0, total_amount: 58_000 }],
  ) {
    this.simulation = {
      passCardholderReview: async (id) => {
        await this.call('POST', `/api/v1/simulation/issuing/cardholders/${id}/pass_review`, 'Simulate cardholder review pass', {}, () => {
          const ch = this.cardholders.get(id);
          if (ch) ch.status = 'READY';
          return 'OK';
        });
      },
      authorize: (req) => this.call('POST', '/api/v1/simulation/issuing/create', `Network auth ${req.transaction_amount} ${req.transaction_currency}`, req, () => this.authorize(req), 201),
      capture: (lifecycleId, body = {}) =>
        this.call('POST', `/api/v1/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/capture`, 'Capture (CLEARING)', body, () => this.capture(lifecycleId, body)),
      reverse: (lifecycleId, body = {}) =>
        this.call('POST', `/api/v1/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/reverse`, 'Reverse authorization', body, () => this.reverse(lifecycleId)),
      refund: (body) => this.call('POST', '/api/v1/simulation/issuing/refund', `Merchant refund ${body.transaction_amount} ${body.transaction_currency}`, body, () => this.refund(body)),
    };
  }

  private async call<T>(method: string, path: string, title: string, request: unknown, fn: () => T, status = 200): Promise<T> {
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 60 + randomInt(140)));
    try {
      const response = fn();
      this.telemetry.emitEvent({ channel: 'AIRWALLEX', mode: 'EMULATOR', title, level: 'success', method, path, status, ms: Date.now() - t0, request: request ? redact(request) : undefined, response: redact(response) });
      return response;
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      this.telemetry.emitEvent({ channel: 'AIRWALLEX', mode: 'EMULATOR', title, level: 'error', method, path, status: err.status ?? 400, ms: Date.now() - t0, request: redact(request), response: { code: err.code ?? 'validation_error', message: err.message } });
      throw e;
    }
  }

  getBalances() {
    return this.call('GET', '/api/v1/balances/current', 'Fetch wallet balances', undefined, () => this.balances);
  }

  createCardholder(payload: CardholderPayload) {
    return this.call('POST', '/api/v1/issuing/cardholders/create', 'Create cardholder', payload, () => {
      const ch: Cardholder = { cardholder_id: `ich_${randomUUID()}`, status: 'READY', type: payload.type, email: payload.email };
      this.cardholders.set(ch.cardholder_id, ch);
      return ch;
    }, 202);
  }

  getCardholder(id: string) {
    return this.call('GET', `/api/v1/issuing/cardholders/${id}`, 'Get cardholder', undefined, () => {
      const ch = this.cardholders.get(id);
      if (!ch) throw Object.assign(new Error('cardholder not found'), { status: 404, code: 'resource_not_found' });
      return ch;
    });
  }

  createCard(payload: CardCreatePayload) {
    return this.call('POST', '/api/v1/issuing/cards/create', 'Issue virtual card', payload, () => {
      assertRequestIdFor(payload.request_id, 'POST /api/v1/issuing/cards/create');
      const prior = this.seenRequestIds.get(payload.request_id);
      if (prior) return prior as Card; // idempotent replay returns the original card
      if (!payload.authorization_controls?.allowed_transaction_count) {
        throw Object.assign(new Error('authorization_controls.allowed_transaction_count is required'), { status: 400 });
      }
      if (!this.cardholders.has(payload.cardholder_id)) throw Object.assign(new Error('cardholder_id not found'), { status: 400 });
      const pan = `4${String(randomInt(10 ** 7)).padStart(7, '0')}${String(randomInt(10 ** 8)).padStart(8, '0')}`;
      const card: Card = {
        card_id: randomUUID(),
        card_status: 'ACTIVE', // virtual cards are activated on creation
        card_number: `${pan.slice(0, 6)}******${pan.slice(-4)}`,
        cardholder_id: payload.cardholder_id,
        brand: 'VISA',
        form_factor: 'VIRTUAL',
        nick_name: payload.nick_name,
        authorization_controls: payload.authorization_controls,
        created_at: new Date().toISOString(),
        request_id: payload.request_id,
      };
      this.cards.set(card.card_id, { card, pan, spent: {}, approvedCount: 0 });
      this.seenRequestIds.set(payload.request_id, card);
      return card;
    }, 202);
  }

  private cardState(id: string): CardState {
    const s = this.cards.get(id);
    if (!s) throw Object.assign(new Error(`card ${id} not found`), { status: 404, code: 'resource_not_found' });
    return s;
  }

  getCard(id: string) {
    return this.call('GET', `/api/v1/issuing/cards/${id}`, 'Get card', undefined, () => this.cardState(id).card);
  }

  getCardLimits(id: string) {
    return this.call('GET', `/api/v1/issuing/cards/${id}/limits`, 'Read card limits', undefined, (): CardLimits => {
      const s = this.cardState(id);
      const tl = s.card.authorization_controls.transaction_limits;
      return {
        currency: tl.currency,
        limits: tl.limits.map((l) => ({
          amount: l.amount,
          interval: l.interval,
          remaining: l.interval === 'PER_TRANSACTION' ? l.amount : toMajor(toMinor(l.amount) - (s.spent[l.interval] ?? 0)),
        })),
        cash_withdrawal_limits: [],
      };
    });
  }

  updateCard(id: string, patch: { card_status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED' }) {
    const title = patch.card_status === 'INACTIVE' ? 'Freeze card (INACTIVE)' : patch.card_status === 'ACTIVE' ? 'Unfreeze card (ACTIVE)' : 'Update card';
    return this.call('POST', `/api/v1/issuing/cards/${id}/update`, title, patch, () => {
      const s = this.cardState(id);
      if (s.card.card_status === 'CLOSED') throw Object.assign(new Error('card is CLOSED'), { status: 400 });
      if (patch.card_status) s.card = { ...s.card, card_status: patch.card_status };
      return s.card;
    });
  }

  private txnBase(s: CardState, req: { transaction_amount: number; transaction_currency: string; merchant_category_code?: string; merchant_info?: string }, lifecycleId: string) {
    return {
      card_id: s.card.card_id,
      card_transaction_id: randomUUID(),
      card_transaction_lifecycle_id: lifecycleId,
      transaction_amount: req.transaction_amount,
      transaction_currency: req.transaction_currency,
      billing_amount: req.transaction_amount,
      masked_card_number: s.card.card_number,
      merchant: { category_code: req.merchant_category_code, name: req.merchant_info, country: 'US' },
      auth_code: String(randomInt(1e6)).padStart(6, '0'),
      transacted_at: new Date().toISOString(),
    };
  }

  private authorize(req: SimAuthRequest): SimulatedTransaction {
    const s = this.cardState(req.card_id);
    const decision = evaluateAuthorization(
      s.card.authorization_controls,
      s.card.card_status,
      { spent: Object.fromEntries(Object.entries(s.spent).map(([k, v]) => [k, toMajor(v!)])), approvedCount: s.approvedCount },
      { amount: req.transaction_amount, currency: req.transaction_currency as 'USD', mcc: req.merchant_category_code },
    );
    const lifecycleId = randomUUID();
    if (!decision.approve) {
      return { process_result: 'DECLINED', failure_reason: decision.failure_reason, type: 'AUTHORIZATION', subtype: 'AUTHORIZATION', ...this.txnBase(s, req, lifecycleId) };
    }
    for (const l of s.card.authorization_controls.transaction_limits.limits) {
      if (l.interval !== 'PER_TRANSACTION') s.spent[l.interval] = (s.spent[l.interval] ?? 0) + toMinor(req.transaction_amount);
    }
    s.approvedCount++;
    this.lifecycles.set(lifecycleId, { id: lifecycleId, cardId: s.card.card_id, amount: req.transaction_amount, currency: req.transaction_currency, mcc: req.merchant_category_code, merchant: req.merchant_info, state: 'AUTHORIZED' });
    return { process_result: 'APPROVED', type: 'AUTHORIZATION', subtype: 'AUTHORIZATION', ...this.txnBase(s, req, lifecycleId) };
  }

  private capture(lifecycleId: string, body: { transaction_amount?: number }): SimulatedTransaction {
    const lc = this.lifecycles.get(lifecycleId);
    if (!lc || lc.state !== 'AUTHORIZED') throw Object.assign(new Error('lifecycle not capturable'), { status: 400 });
    lc.state = 'CLEARED';
    const amount = body.transaction_amount ?? lc.amount;
    const usd = this.balances.find((b) => b.currency === lc.currency);
    if (usd) {
      usd.available_amount = toMajor(toMinor(usd.available_amount) - toMinor(amount));
      usd.total_amount = toMajor(toMinor(usd.total_amount) - toMinor(amount));
    }
    const s = this.cardState(lc.cardId);
    return { process_result: 'APPROVED', type: 'CLEARING', subtype: 'CLEARING', ...this.txnBase(s, { transaction_amount: amount, transaction_currency: lc.currency, merchant_category_code: lc.mcc, merchant_info: lc.merchant }, lifecycleId) };
  }

  /** Refunds credit the wallet and are always restored to the card's active limits. */
  private refund(body: { card_id: string; transaction_amount: number; transaction_currency: string; card_transaction_lifecycle_id?: string; merchant_category_code?: string; merchant_info?: string }): SimulatedTransaction {
    const s = this.cardState(body.card_id);
    for (const l of s.card.authorization_controls.transaction_limits.limits) {
      if (l.interval !== 'PER_TRANSACTION') s.spent[l.interval] = Math.max(0, (s.spent[l.interval] ?? 0) - toMinor(body.transaction_amount));
    }
    const wallet = this.balances.find((b) => b.currency === body.transaction_currency);
    if (wallet) {
      wallet.available_amount = toMajor(toMinor(wallet.available_amount) + toMinor(body.transaction_amount));
      wallet.total_amount = toMajor(toMinor(wallet.total_amount) + toMinor(body.transaction_amount));
    }
    const lifecycleId = body.card_transaction_lifecycle_id ?? randomUUID();
    return { process_result: 'APPROVED', type: 'REFUND', subtype: 'REFUND', ...this.txnBase(s, { transaction_amount: body.transaction_amount, transaction_currency: body.transaction_currency, merchant_category_code: body.merchant_category_code, merchant_info: body.merchant_info }, lifecycleId) };
  }

  private reverse(lifecycleId: string): SimulatedTransaction {
    const lc = this.lifecycles.get(lifecycleId);
    if (!lc || lc.state !== 'AUTHORIZED') throw Object.assign(new Error('lifecycle not reversible'), { status: 400 });
    lc.state = 'REVERSED';
    const s = this.cardState(lc.cardId);
    s.approvedCount = Math.max(0, s.approvedCount - 1);
    for (const l of s.card.authorization_controls.transaction_limits.limits) {
      if (l.interval !== 'PER_TRANSACTION') s.spent[l.interval] = (s.spent[l.interval] ?? 0) - toMinor(lc.amount);
    }
    return { process_result: 'APPROVED', type: 'REVERSAL_AUTH', subtype: 'REVERSAL', ...this.txnBase(s, { transaction_amount: lc.amount, transaction_currency: lc.currency, merchant_category_code: lc.mcc, merchant_info: lc.merchant }, lifecycleId) };
  }
}
