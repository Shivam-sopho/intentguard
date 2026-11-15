/**
 * IntentGuard orchestrator: runs the 5-act flow. It sequences calls; every money,
 * policy and state decision is delegated to @intentguard/deterministic-engine.
 */
import { randomUUID } from 'node:crypto';
import {
  ApprovalRecord,
  buildCardCreatePayload,
  buildCardholderRestPayload,
  buildPaymentContainer,
  CardCreatePayload,
  CLOUDSCALE,
  CLOUDSCALE_SKU,
  decideBillingPlan,
  evaluateAuthorization,
  formatMoney,
  generateAgentKey,
  generateOperatorKey,
  HORIZON_WEEKS,
  intentBindingHash,
  intentHash,
  IntentVerification,
  ObservedCharge,
  PlanDecision,
  ProcurementStateMachine,
  PurchaseIntent,
  scheduledObligations,
  SEED_OPENING_BALANCE,
  signApproval,
  signTapRequest,
  TapTag,
  toMcpCardholderPayload,
  verifyApproval,
  verifyChargeAgainstIntent,
  type ScheduledFlow,
  type ShadowDecision,
} from '@intentguard/deterministic-engine';
import {
  explainPlan,
  Narrative,
  ParsedContract,
  parseVendorContract,
  writeIncidentReport,
  writeSettlementSummary,
  claudeAvailable,
  llmLabel,
  LlmTrace,
} from '@intentguard/cognitive-agent';
import {
  Card,
  CardLimits,
  Cart,
  EmulatedAirwallexRail,
  IssuingNetworkSimulator,
  IssuingRail,
  LiveAirwallexRail,
  Order,
  Telemetry,
  type RailMode,
} from '@intentguard/simulation-adapter';

export interface RunState {
  runId: string;
  act: number;
  machineState: string;
  history: { from: string; to: string; at: string; reason?: string }[];
  busy: string | null;
  error: string | null;
  rail: { mode: RailMode | null; note: string };
  llm: { engine: 'claude' | 'offline'; model: string };
  guardrails?: {
    openingBalance: number;
    balanceSource: string;
    reserveFloor: number;
    currency: 'USD';
    horizonWeeks: number;
    scheduled: ScheduledFlow[];
    liveBalances?: unknown;
  };
  contract?: { document: string; parsed: ParsedContract };
  plan?: { decision: PlanDecision; narrative: Narrative };
  intent?: { intent: PurchaseIntent; intentHash: string; bindingHash: string };
  approval?: ApprovalRecord & { verified: boolean };
  card?: { card: Card; limits: CardLimits; cardholderId: string; createPayload: CardCreatePayload; mcpCardholderShape: unknown };
  tap?: { keyid: string; jwk: unknown; lastSignatureInput?: string; lastSignatureBase?: string; lastTag?: TapTag; verifications: number };
  checkout?: { cart: Cart; cartCheck: IntentVerification; order?: Order; chargeCheck?: IntentVerification; shadow?: ShadowDecision; railAgreesWithPolicy?: boolean };
  incident?: { verification: IntentVerification; attemptedAmount: number; failureReason: string; frozenAt: string; cardStatusAfter: string; retry?: { outcome: string; failure_reason?: string }; narrative: Narrative; limitsAfterFreeze: CardLimits };
  reapproval?: ApprovalRecord & { verified: boolean };
  settlement?: { order: Order; narrative: Narrative; limitsAfter: CardLimits; settledAt: string; cardStatus: string };
  triggers: { id: string; week: number; condition: string; action: string; status: 'SCHEDULED' }[];
  blockedBotProbe?: { status: number; reason: string };
}

export interface OrchestratorDeps {
  telemetry: Telemetry;
  port: number;
  merchantState: () => { chaosFee: boolean };
  resetMerchant: () => void;
}

function readAirwallexConfig() {
  const clientId = process.env.AIRWALLEX_CLIENT_ID;
  const apiKey = process.env.AIRWALLEX_API_KEY;
  if (!clientId || !apiKey) return null;
  return {
    baseUrl: process.env.AIRWALLEX_BASE_URL || 'https://api.sandbox.airwallex.com',
    clientId,
    apiKey,
    cardholderId: process.env.AIRWALLEX_CARDHOLDER_ID || undefined,
  };
}

export class Orchestrator {
  state!: RunState;
  rail!: IssuingRail;
  network!: IssuingNetworkSimulator;
  private machine!: ProcurementStateMachine;
  readonly agentKey = generateAgentKey();
  readonly operatorKey = generateOperatorKey();
  private listeners = new Set<(s: RunState) => void>();
  private cachedCardholderId: string | null = null;

  constructor(private deps: OrchestratorDeps) {
    this.reset();
  }

  get merchantBase() {
    return `http://localhost:${this.deps.port}/merchant`;
  }

  get authority() {
    return `localhost:${this.deps.port}`;
  }

  onState(fn: (s: RunState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish() {
    this.state.machineState = this.machine.state;
    this.state.history = this.machine.history;
    for (const fn of this.listeners) fn(this.state);
  }

  private t(channel: Parameters<Telemetry['emitEvent']>[0]['channel'], title: string, level: 'info' | 'success' | 'warn' | 'error' = 'info', detail?: unknown) {
    this.deps.telemetry.emitEvent({ channel, title, level, detail });
  }

  private llmEvent(what: string, trace: LlmTrace, detail?: unknown) {
    this.deps.telemetry.emitEvent({
      channel: 'CLAUDE',
      title: trace.engine === 'claude' ? `${what} (${trace.model}${trace.via === 'claude-code' ? ' via Claude Code' : ''}, ${(trace.ms / 1000).toFixed(1)} s)` : `${what} (offline template${trace.error ? ` - ${trace.error}` : ''})`,
      level: trace.engine === 'claude' ? 'success' : 'warn',
      detail: { trace, ...((detail as object) ?? {}) },
    });
  }

  private transition(to: Parameters<ProcurementStateMachine['transition']>[0], e: Parameters<ProcurementStateMachine['transition']>[1] = {}) {
    const rec = this.machine.transition(to, e);
    this.t('ENGINE', `State ${rec.from} → ${rec.to}`, 'info', e);
    this.publish();
  }

  reset() {
    this.machine = new ProcurementStateMachine();
    this.deps.resetMerchant();
    this.deps.telemetry.clear();
    this.state = {
      runId: randomUUID(),
      act: 0,
      machineState: this.machine.state,
      history: [],
      busy: null,
      error: null,
      rail: { mode: null, note: 'not connected' },
      llm: { engine: claudeAvailable() ? 'claude' : 'offline', model: llmLabel() },
      tap: { keyid: this.agentKey.keyid, jwk: this.agentKey.publicJwk, verifications: 0 },
      triggers: [],
    };
    this.publish();
  }

  /** Serialize acts so double clicks cannot interleave money movements. */
  private async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.state.busy) throw new Error(`Busy: ${this.state.busy}`);
    this.state.busy = label;
    this.state.error = null;
    this.publish();
    try {
      return await fn();
    } catch (e) {
      this.state.error = (e as Error).message;
      this.t('ENGINE', `Error: ${(e as Error).message}`, 'error');
      throw e;
    } finally {
      this.state.busy = null;
      this.publish();
    }
  }

  // -------------------------------------------------------------------------
  // TAP-signed calls to the merchant
  // -------------------------------------------------------------------------

  private async merchantFetch(path: string, tag: TapTag, init: { method: 'GET' | 'POST'; body?: unknown; container?: (nonce: string) => unknown }) {
    const fullPath = `/merchant${path}`;
    const signed = signTapRequest({ key: this.agentKey, authority: this.authority, path: fullPath, tag });
    const body = init.body !== undefined || init.container ? { ...(init.body as object), ...(init.container ? { agenticPaymentContainer: init.container(signed.params.nonce) } : {}) } : undefined;
    this.state.tap = { ...this.state.tap!, lastSignatureInput: signed.headers['Signature-Input'], lastSignatureBase: signed.signatureBase, lastTag: tag, verifications: this.state.tap!.verifications + 1 };
    this.deps.telemetry.emitEvent({
      channel: 'VISA_TAP',
      title: `Agent signed ${init.method} ${fullPath} (${tag})`,
      level: 'info',
      method: init.method,
      path: fullPath,
      request: { 'Signature-Input': signed.headers['Signature-Input'], signature_base: signed.signatureBase, body },
    });
    const res = await fetch(`${this.merchantBase}${path}`, {
      method: init.method,
      headers: { ...signed.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* text body */
    }
    return { status: res.status, body: json };
  }

  // -------------------------------------------------------------------------
  // ACT 1 - Goal & guardrails
  // -------------------------------------------------------------------------

  async act1(opts: { reserveFloor?: number; forceEmulator?: boolean } = {}) {
    return this.run('Act 1: connecting rail and setting guardrails', async () => {
      if (this.state.act >= 1) this.reset();
      const cfg = readAirwallexConfig();
      let openingBalance = SEED_OPENING_BALANCE;
      let balanceSource = 'Scenario seed (emulator wallet)';
      let liveBalances: unknown;

      if (cfg && !opts.forceEmulator) {
        const live = new LiveAirwallexRail(cfg, this.deps.telemetry);
        try {
          const balances = await live.getBalances();
          liveBalances = balances;
          this.rail = live;
          this.state.rail = { mode: 'LIVE', note: `Airwallex sandbox ${cfg.baseUrl}` };
          const usd = balances.find((b) => b.currency === 'USD');
          if (usd && usd.available_amount > 0) {
            openingBalance = usd.available_amount;
            balanceSource = 'Live Airwallex USD wallet (GET /api/v1/balances/current)';
          } else {
            balanceSource = 'Scenario seed - sandbox USD wallet is unfunded';
          }
        } catch (e) {
          this.t('AIRWALLEX', `Sandbox unreachable, falling back to emulator: ${(e as Error).message}`, 'warn');
          this.rail = new EmulatedAirwallexRail(this.deps.telemetry);
          this.state.rail = { mode: 'EMULATOR', note: `Fallback: ${(e as Error).message}` };
          await this.rail.getBalances();
        }
      } else {
        this.rail = new EmulatedAirwallexRail(this.deps.telemetry);
        this.state.rail = { mode: 'EMULATOR', note: cfg ? 'Emulator forced by operator' : 'No AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY configured' };
        await this.rail.getBalances();
      }
      this.network = new IssuingNetworkSimulator(this.rail);

      // Default guardrail keeps the scenario's $18,000 headroom relative to the opening balance.
      const reserveFloor = opts.reserveFloor ?? Math.round(openingBalance - 18_000);
      this.state.guardrails = { openingBalance, balanceSource, reserveFloor, currency: 'USD', horizonWeeks: HORIZON_WEEKS, scheduled: scheduledObligations(), liveBalances };
      this.t('OPERATOR', `Goal: buy CloudScale Enterprise APM (10 seats). Guardrail: never below ${formatMoney(reserveFloor)} in the next ${HORIZON_WEEKS} weeks`, 'info');
      this.transition('GUARDRAILS_SET', { reason: `floor ${reserveFloor}` });
      this.state.act = 1;
      this.publish();
      return this.state;
    });
  }

  // -------------------------------------------------------------------------
  // ACT 2 - Read the contract, project cash, choose the plan
  // -------------------------------------------------------------------------

  async act2() {
    return this.run('Act 2: reading contract and projecting cash', async () => {
      if (this.state.act !== 1 || !this.state.guardrails) throw new Error('Run Act 1 first');
      const quote = await this.merchantFetch('/quote', 'agent-browser-auth', { method: 'GET' });
      if (quote.status !== 200) throw new Error(`Merchant refused quote request (${quote.status})`);
      const document = String(quote.body);

      this.t('CLAUDE', "Claude is reading the vendor's quote…");
      const parsed = await parseVendorContract(document);
      this.llmEvent('Claude extracted pricing + risk clauses', parsed.trace, { extraction: parsed.extraction });
      this.t('ENGINE', parsed.grounding.ok ? 'Grounding check passed: every price and quote found verbatim in the document' : `Grounding check FAILED: ${parsed.grounding.issues.map((i) => i.problem).join('; ')}`, parsed.grounding.ok ? 'success' : 'error', parsed.grounding);
      this.state.contract = { document, parsed };
      if (!parsed.grounding.ok || parsed.options.length < 1) throw new Error('Contract extraction failed deterministic grounding; refusing to plan on it');

      const g = this.state.guardrails;
      const decision = decideBillingPlan({ openingBalance: g.openingBalance, reserveFloor: g.reserveFloor, currency: 'USD', horizonWeeks: g.horizonWeeks, scheduled: g.scheduled }, parsed.options);
      for (const v of decision.verdicts) {
        this.t('ENGINE', v.safe ? `${v.optionId}: safe, low point ${formatMoney(v.minBalance)} in week ${v.minWeek}` : `${v.optionId}: BREACH in week ${v.firstBreachWeek}, short ${formatMoney(v.maxShortfall)}`, v.safe ? 'success' : 'error', v);
      }
      if (!decision.recommendedOptionId) {
        this.transition('ESCALATED', { safePlanExists: false, reason: 'no reserve-safe option' });
        throw new Error('No billing option keeps the reserve floor; escalated to treasury');
      }

      const opt = (id: string) => parsed.options.find((o) => o.id === id)!;
      const cheapest = opt(decision.cheapestOptionId);
      const chosen = opt(decision.recommendedOptionId);
      const cv = decision.verdicts.find((v) => v.optionId === cheapest.id)!;
      const chosenV = decision.verdicts.find((v) => v.optionId === chosen.id)!;
      const breachRow = cv.firstBreachWeek ? decision.projections[cheapest.id].weeks[cv.firstBreachWeek - 1] : null;
      const discount = chosen.annualizedCost > 0 ? Math.round(((chosen.annualizedCost - cheapest.annualizedCost) / chosen.annualizedCost) * 100) : 0;
      this.t('CLAUDE', 'Claude is explaining the decision…');
      const narrative = await explainPlan({
        opening_balance: g.openingBalance,
        reserve_floor: g.reserveFloor,
        cheapest_option: { label: cheapest.label, charge: cheapest.chargeAmount, annualized_cost: cheapest.annualizedCost },
        cheapest_first_breach_week: cv.firstBreachWeek,
        cheapest_week_balance: breachRow?.closing ?? null,
        cheapest_shortfall: breachRow ? -breachRow.headroom : 0,
        chosen_option: { label: chosen.label, charge: chosen.chargeAmount, annualized_cost: chosen.annualizedCost },
        chosen_min_balance: chosenV.minBalance,
        chosen_min_week: chosenV.minWeek,
        savings_forgone: decision.savingsForgone,
        discount_percent: discount,
        upgrade_trigger: decision.upgradeTrigger ? { week: decision.upgradeTrigger.week, condition: decision.upgradeTrigger.condition } : null,
        risk_clauses: parsed.extraction.risk_clauses.map(({ clause_ref, kind, summary, max_amount }) => ({ clause_ref, kind, summary, max_amount })),
      });
      this.llmEvent('Claude explained the reserve trade-off', narrative.trace, { grounded: narrative.grounded, ungrounded: narrative.ungroundedFigures });
      this.state.plan = { decision, narrative };

      if (decision.upgradeTrigger) {
        this.state.triggers.push({
          id: `trg_${randomUUID().slice(0, 8)}`,
          week: decision.upgradeTrigger.week,
          condition: decision.upgradeTrigger.condition,
          action: `Re-run projection for ${cheapest.label}; if safe, request approval to switch`,
          status: 'SCHEDULED',
        });
        this.t('ENGINE', `Scheduled week-${decision.upgradeTrigger.week} re-evaluation trigger`, 'info', decision.upgradeTrigger);
      }

      this.transition('PLAN_PROPOSED', { safePlanExists: true, reason: `recommend ${chosen.id}` });

      const intent: PurchaseIntent = {
        version: 'intentguard/1',
        intentId: `int_${randomUUID().slice(0, 12)}`,
        merchant: CLOUDSCALE,
        sku: parsed.extraction.sku || CLOUDSCALE_SKU,
        description: `${parsed.extraction.product} - ${parsed.extraction.seats} seats`,
        seats: parsed.extraction.seats,
        billing: { cadence: chosen.cadence, amount: chosen.chargeAmount, currency: 'USD' },
        reserveCheck: { inputHash: decision.inputHash, reserveFloor: g.reserveFloor, projectedMinBalance: chosenV.minBalance, minWeek: chosenV.minWeek },
        createdAt: new Date().toISOString(),
      };
      const hash = intentHash(intent);
      this.state.intent = { intent, intentHash: hash, bindingHash: intentBindingHash(intent) };
      this.t('ENGINE', `Intent hash SHA-256 ${hash.slice(0, 16)}… (${formatMoney(intent.billing.amount)} ${intent.billing.cadence})`, 'info', { intent, intentHash: hash });
      this.transition('AWAITING_APPROVAL', { reason: 'human approval required' });
      this.state.act = 2;
      this.publish();
      return this.state;
    });
  }

  // -------------------------------------------------------------------------
  // ACT 3a - Approve + provision card
  // -------------------------------------------------------------------------

  private async ensureCardholder(): Promise<string> {
    const cfgId = readAirwallexConfig()?.cardholderId;
    if (this.rail.mode === 'LIVE' && (cfgId || this.cachedCardholderId)) {
      const id = (cfgId || this.cachedCardholderId)!;
      const ch = await this.rail.getCardholder(id);
      if (ch.status === 'READY') return id;
    }
    const rest = buildCardholderRestPayload({
      email: `procurement.agent+${Date.now()}@example.com`,
      firstName: 'Procurement',
      lastName: 'Agent',
      dateOfBirth: '1990-01-01',
      address: { line1: '200 George Street', city: 'Sydney', state: 'NSW', postcode: '2000', country: 'AU' },
    });
    let ch = await this.rail.createCardholder(rest);
    if (ch.status !== 'READY') {
      await this.rail.simulation.passCardholderReview(ch.cardholder_id).catch(() => undefined);
      for (let i = 0; i < 8 && ch.status !== 'READY'; i++) {
        await new Promise((r) => setTimeout(r, 750));
        ch = await this.rail.getCardholder(ch.cardholder_id);
      }
    }
    if (ch.status !== 'READY') throw new Error(`Cardholder ${ch.cardholder_id} is ${ch.status}, not READY`);
    this.cachedCardholderId = ch.cardholder_id;
    return ch.cardholder_id;
  }

  async approveAndProvision(approver = 'ops@acme-robotics') {
    return this.run('Act 3: approval + card provisioning', async () => {
      if (this.state.act !== 2 || !this.state.intent) throw new Error('Run Act 2 first');
      const { intent, intentHash: hash } = this.state.intent;
      const approval = signApproval(hash, approver, this.operatorKey, `${formatMoney(intent.billing.amount)} ${intent.billing.cadence} to ${intent.merchant.name}`);
      const verified = verifyApproval(approval, intent, this.operatorKey.publicKey);
      this.state.approval = { ...approval, verified };
      this.t('OPERATOR', `Approved intent ${hash.slice(0, 16)}… (Ed25519 signature ${verified ? 'valid' : 'INVALID'})`, verified ? 'success' : 'error', approval);
      this.transition('APPROVED', { approvalSignatureValid: verified });

      const cardholderId = await this.ensureCardholder();
      const payload = buildCardCreatePayload(intent, cardholderId, hash, { createdBy: 'IntentGuard Procurement Agent', activeDays: 35 });
      this.t('ENGINE', 'Built card policy: inclusive PER_TRANSACTION + MONTHLY limit, MCC + currency allowlist', 'info', payload.authorization_controls);
      let card = await this.rail.createCard(payload);
      for (let i = 0; i < 10 && card.card_status === 'PENDING'; i++) {
        await new Promise((r) => setTimeout(r, 800));
        card = await this.rail.getCard(card.card_id);
      }
      const limits = await this.rail.getCardLimits(card.card_id);
      this.state.card = {
        card,
        limits,
        cardholderId,
        createPayload: payload,
        mcpCardholderShape: toMcpCardholderPayload(buildCardholderRestPayload({ email: 'procurement.agent@example.com', firstName: 'Procurement', lastName: 'Agent', dateOfBirth: '1990-01-01', address: { line1: '200 George Street', city: 'Sydney', postcode: '2000', country: 'AU' } })),
      };
      const per = limits.limits.find((l) => l.interval === 'PER_TRANSACTION');
      this.t('AIRWALLEX', `Card ${card.card_number} ${card.card_status}; per-transaction ceiling ${per ? formatMoney(per.amount) : 'n/a'} (inclusive)`, 'success', limits);
      this.transition('CARD_ISSUED', { cardId: card.card_id, cardStatus: card.card_status });
      this.state.act = 3;
      this.publish();
      return this.state;
    });
  }

  // -------------------------------------------------------------------------
  // ACT 3b + 4 - Checkout with mid-checkout shock, rail rejection, freeze
  // -------------------------------------------------------------------------

  private observedFromOrder(order: Order, cart: Cart): ObservedCharge {
    return {
      merchantId: cart.merchant_id,
      merchantName: cart.merchant_name,
      mcc: cart.mcc,
      amount: order.charged_amount,
      currency: 'USD',
      cadence: cart.cadence,
      lineItems: order.charged_line_items,
      source: 'AUTHORIZATION',
    };
  }

  private async checkout(withShock: boolean) {
    const { intent, intentHash: hash, bindingHash } = this.state.intent!;
    const card = this.state.card!.card;

    const cartRes = await this.merchantFetch('/cart', 'agent-browser-auth', { method: 'POST', body: { sku: intent.sku, cadence: intent.billing.cadence, seats: intent.seats } });
    if (cartRes.status !== 201) throw new Error(`Cart creation failed (${cartRes.status})`);
    const cart = cartRes.body as Cart;
    const cartCheck = verifyChargeAgainstIntent(intent, { merchantId: cart.merchant_id, merchantName: cart.merchant_name, mcc: cart.mcc, amount: cart.total, currency: 'USD', cadence: cart.cadence, lineItems: cart.line_items, source: 'CART' });
    this.t('ENGINE', cartCheck.match ? `Cart hash matches intent (${bindingHash.slice(0, 12)}…)` : `Cart drift: ${cartCheck.summary}`, cartCheck.match ? 'success' : 'error', cartCheck);
    this.state.checkout = { cart, cartCheck };
    if (!cartCheck.match) throw new Error('Cart does not match approved intent; agent will not submit payment');
    this.transition('CHECKOUT_IN_PROGRESS', { bindingMatch: true });

    // Shadow policy evaluation of what the merchant is about to attempt is not possible
    // in advance (the merchant decides the auth amount); we evaluate after we observe it.
    const pay = await this.merchantFetch('/checkout', 'agent-payer-auth', {
      method: 'POST',
      body: { cart_id: cart.cart_id, card_id: card.card_id },
      container: (nonce) => buildPaymentContainer(this.agentKey, nonce, { intentHash: hash, bindingHash, amount: intent.billing.amount.toFixed(2), currency: intent.billing.currency }),
    });
    if (pay.status === 403) throw new Error(`Merchant rejected TAP credentials: ${JSON.stringify(pay.body)}`);
    const order = pay.body as Order;
    const chargeCheck = verifyChargeAgainstIntent(intent, this.observedFromOrder(order, cart));
    const shadow = evaluateAuthorization(card.authorization_controls, 'ACTIVE', { spent: {}, approvedCount: 0 }, { amount: order.charged_amount, currency: 'USD', mcc: cart.mcc });
    const railApproved = order.authorization.outcome === 'AUTHORIZED';
    const railAgreesWithPolicy = railApproved === shadow.approve;
    this.state.checkout = { cart, cartCheck, order, chargeCheck, shadow, railAgreesWithPolicy };
    this.t(
      'AIRWALLEX',
      railApproved
        ? `Authorization APPROVED for ${formatMoney(order.charged_amount)} (lifecycle ${order.authorization.raw.card_transaction_lifecycle_id?.slice(0, 8)}…)`
        : `Authorization DECLINED at the rail: ${order.authorization.failure_reason} → FAILED`,
      railApproved ? 'success' : 'error',
      { outcome: order.authorization.outcome, failure_reason: order.authorization.failure_reason, shadow },
    );
    if (!railAgreesWithPolicy) {
      this.t('ENGINE', `Rail decision differs from deterministic policy prediction (${shadow.approve ? 'expected approve' : `expected ${shadow.failure_reason}`})`, 'warn', shadow);
    }
    void withShock;
    return { cart, order, chargeCheck };
  }

  async triggerShock() {
    return this.run('Act 3: checkout with vendor fee shock', async () => {
      if (this.state.act !== 3 || !this.state.card) throw new Error('Approve and provision first');
      await fetch(`${this.merchantBase}/_chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
      const { order, chargeCheck } = await this.checkout(true);

      if (chargeCheck.match && order.authorization.outcome === 'AUTHORIZED') {
        throw new Error('Shock did not produce drift (merchant chaos inactive?)');
      }
      // ACT 4 - containment
      this.state.act = 4;
      this.t('ENGINE', `Intent hash mismatch: approved ${chargeCheck.approvedBindingHash.slice(0, 12)}… vs attempted ${chargeCheck.observedBindingHash.slice(0, 12)}…`, 'error', chargeCheck);
      const cardId = this.state.card.card.card_id;
      const frozen = await this.rail.updateCard(cardId, { card_status: 'INACTIVE' });
      this.state.card.card = frozen;
      this.transition('QUARANTINED_FROZEN', { cardStatus: frozen.card_status, reason: chargeCheck.summary });

      // If the rail had (unexpectedly) approved the drifted auth, void it before clearing.
      if (order.authorization.outcome === 'AUTHORIZED' && order.authorization.raw.card_transaction_lifecycle_id) {
        await this.network.reverse(order.authorization.raw.card_transaction_lifecycle_id);
        this.t('ENGINE', 'Drifted authorization reversed before clearing', 'warn');
      }

      // The merchant tries to sneak the fee through as a separate charge.
      const retryRes = await fetch(`${this.merchantBase}/orders/${order.order_id}/retry-fee`, { method: 'POST' });
      const retry = ((await retryRes.json()) as { authorization: { outcome: string; failure_reason?: string } }).authorization;
      this.t('AIRWALLEX', retry.outcome === 'FAILED' ? `Separate $250 fee charge DECLINED: ${retry.failure_reason}` : 'Separate fee charge was not declined', retry.outcome === 'FAILED' ? 'success' : 'error', retry);

      const limitsAfterFreeze = await this.rail.getCardLimits(cardId);
      const fee = this.state.contract?.parsed.extraction.risk_clauses.find((r) => r.kind === 'ONBOARDING_FEE') ?? null;
      this.t('CLAUDE', 'Claude is writing the incident report…');
      const narrative = await writeIncidentReport({
        merchant: CLOUDSCALE.name,
        approved_amount: this.state.intent!.intent.billing.amount,
        attempted_amount: order.charged_amount,
        overage: chargeCheck.overage,
        unapproved_items: chargeCheck.unapprovedLineItems,
        rail_failure_reason: order.authorization.failure_reason ?? 'APPROVED (reversed by agent)',
        approved_binding_hash: chargeCheck.approvedBindingHash,
        observed_binding_hash: chargeCheck.observedBindingHash,
        card_status_after: frozen.card_status,
        retry_failure_reason: retry.failure_reason ?? null,
        contract_clause: fee ? { clause_ref: fee.clause_ref, summary: fee.summary, max_amount: fee.max_amount } : null,
      });
      this.llmEvent('Claude wrote the incident report', narrative.trace, { grounded: narrative.grounded });
      this.state.incident = {
        verification: chargeCheck,
        attemptedAmount: order.charged_amount,
        failureReason: order.authorization.failure_reason ?? 'APPROVED_THEN_REVERSED',
        frozenAt: new Date().toISOString(),
        cardStatusAfter: frozen.card_status,
        retry,
        narrative,
        limitsAfterFreeze,
      };
      this.publish();
      return this.state;
    });
  }

  // -------------------------------------------------------------------------
  // ACT 5 - Re-approval, unfreeze, verified settlement
  // -------------------------------------------------------------------------

  async resolve(approver = 'ops@acme-robotics') {
    return this.run('Act 5: enforcing approved contract and settling', async () => {
      if (this.state.act !== 4 || !this.state.intent || !this.state.card) throw new Error('Trigger the shock first');
      const { intent, intentHash: hash } = this.state.intent;

      // Operator holds the vendor to the ORIGINAL terms: re-sign the same intent hash.
      const re = signApproval(hash, approver, this.operatorKey, `Re-approval after quarantine: hold vendor to ${formatMoney(intent.billing.amount)}; fee rejected`);
      const reVerified = verifyApproval(re, intent, this.operatorKey.publicKey);
      this.state.reapproval = { ...re, verified: reVerified };
      this.t('OPERATOR', `Re-approved original intent ${hash.slice(0, 16)}…; onboarding fee rejected`, 'success', re);

      await fetch(`${this.merchantBase}/_chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });

      // Cart must match the intent again before the card is released.
      const cartRes = await this.merchantFetch('/cart', 'agent-browser-auth', { method: 'POST', body: { sku: intent.sku, cadence: intent.billing.cadence, seats: intent.seats } });
      const cart = cartRes.body as Cart;
      const cartCheck = verifyChargeAgainstIntent(intent, { merchantId: cart.merchant_id, merchantName: cart.merchant_name, mcc: cart.mcc, amount: cart.total, currency: 'USD', cadence: cart.cadence, lineItems: cart.line_items, source: 'CART' });
      if (!cartCheck.match) throw new Error(`Cart still drifts: ${cartCheck.summary}`);

      const unfrozen = await this.rail.updateCard(this.state.card.card.card_id, { card_status: 'ACTIVE' });
      this.state.card.card = unfrozen;
      this.transition('CARD_ISSUED', { reapprovalSignatureValid: reVerified, bindingMatch: cartCheck.match, cardStatus: unfrozen.card_status, reason: 're-approved, cart matches intent' });

      const { order, chargeCheck } = await this.checkout(false);
      if (order.authorization.outcome !== 'AUTHORIZED' || !chargeCheck.match) {
        throw new Error(`Settlement authorization failed: ${order.authorization.failure_reason ?? chargeCheck.summary}`);
      }
      this.transition('AUTHORIZED', { railOutcome: 'AUTHORIZED', bindingMatch: chargeCheck.match });

      const fulfilled = await fetch(`${this.merchantBase}/orders/${order.order_id}/fulfill`, { method: 'POST' });
      const settledOrder = (await fulfilled.json()) as Order;
      const capture = settledOrder.capture;
      this.t('AIRWALLEX', capture?.outcome === 'CLEARED' ? `CLEARING + APPROVED: ${formatMoney(capture.raw.transaction_amount)} settled` : `Capture failed: ${capture?.failure_reason}`, capture?.outcome === 'CLEARED' ? 'success' : 'error', capture);
      if (capture?.outcome !== 'CLEARED') throw new Error('Capture did not clear');
      this.transition('SETTLED', { railOutcome: 'CLEARED' });

      const limitsAfter = await this.rail.getCardLimits(unfrozen.card_id);
      const decision = this.state.plan!.decision;
      const chosen = decision.verdicts.find((v) => v.optionId === decision.recommendedOptionId)!;
      const trig = this.state.triggers[0];
      this.t('CLAUDE', 'Claude is writing the audit note…');
      const narrative = await writeSettlementSummary({
        merchant: CLOUDSCALE.name,
        settled_amount: capture.raw.transaction_amount,
        order_id: settledOrder.order_id,
        reserve_floor: this.state.guardrails!.reserveFloor,
        projected_min_balance: chosen.minBalance,
        projected_min_week: chosen.minWeek,
        unauthorized_spend: 0,
        next_review: trig ? trig.condition : null,
      });
      this.llmEvent('Claude wrote the settlement note', narrative.trace);
      this.state.settlement = { order: settledOrder, narrative, limitsAfter, settledAt: new Date().toISOString(), cardStatus: unfrozen.card_status };
      this.state.act = 5;
      this.publish();
      return this.state;
    });
  }

  /** Demonstrates why TAP matters: an unsigned bot is blocked by the merchant edge. */
  async probeUnsignedBot() {
    const res = await fetch(`${this.merchantBase}/quote`);
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    this.state.blockedBotProbe = { status: res.status, reason: body.reason ?? '' };
    this.publish();
    return this.state.blockedBotProbe;
  }
}
