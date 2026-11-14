/**
 * Live Airwallex sandbox client (https://api.sandbox.airwallex.com).
 * Auth: POST /api/v1/authentication/login with x-client-id + x-api-key -> 30-min bearer token.
 * Every request/response is streamed to telemetry (secrets redacted).
 */
import { assertRequestIdFor, CardCreatePayload } from '@intentguard/deterministic-engine';
import { redact, Telemetry } from './telemetry.js';
import type { Balance, Card, Cardholder, CardholderPayload, CardLimits, IssuingRail, IssuingSimulationApi, SimAuthRequest, SimulatedTransaction } from './types.js';

export interface AirwallexConfig {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  /** Optional: reuse an existing READY cardholder instead of creating one per run. */
  cardholderId?: string;
}

export class AirwallexApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class AirwallexHttp {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private cfg: AirwallexConfig,
    private telemetry: Telemetry,
  ) {}

  async login(): Promise<void> {
    const t0 = Date.now();
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/authentication/login`, {
      method: 'POST',
      headers: { 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
    this.telemetry.emitEvent({
      channel: 'AIRWALLEX',
      mode: 'LIVE',
      title: 'Authenticate',
      level: res.ok ? 'success' : 'error',
      method: 'POST',
      path: '/api/v1/authentication/login',
      status: res.status,
      ms: Date.now() - t0,
      request: { headers: { 'x-client-id': this.cfg.clientId.slice(0, 6) + '…', 'x-api-key': '[redacted]' } },
      response: { token: body.token ? '[redacted]' : undefined, expires_at: body.expires_at, message: body.message },
    });
    if (!res.ok || !body.token) throw new AirwallexApiError(`Airwallex login failed (${res.status})`, res.status, body);
    this.token = body.token;
    const exp = body.expires_at ? Date.parse(body.expires_at.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
    this.tokenExpiry = Number.isFinite(exp) ? exp : Date.now() + 29 * 60_000;
  }

  private async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiry - 60_000) await this.login();
  }

  async request<T>(method: 'GET' | 'POST', path: string, title: string, body?: Record<string, unknown>): Promise<T> {
    await this.ensureToken();
    if (body && typeof body.request_id === 'string') assertRequestIdFor(body.request_id, `${method} ${path}`);
    let attempt = 0;
    let reauthed = false;
    for (;;) {
      const t0 = Date.now();
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      this.telemetry.emitEvent({
        channel: 'AIRWALLEX',
        mode: 'LIVE',
        title,
        level: res.ok ? 'success' : res.status === 429 ? 'warn' : 'error',
        method,
        path,
        status: res.status,
        ms: Date.now() - t0,
        request: body ? redact(body) : undefined,
        response: redact(json),
      });
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        await this.login();
        continue;
      }
      // Sandbox: 20 req/s global, 10/s per endpoint. Back off and retry the SAME request_id.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        attempt++;
        continue;
      }
      if (!res.ok) {
        const msg = (json as { message?: string })?.message ?? text;
        throw new AirwallexApiError(`${method} ${path} -> ${res.status}: ${msg}`, res.status, json);
      }
      return json as T;
    }
  }
}

export class LiveAirwallexRail implements IssuingRail {
  readonly mode = 'LIVE' as const;
  readonly http: AirwallexHttp;
  readonly simulation: IssuingSimulationApi;

  constructor(
    readonly cfg: AirwallexConfig,
    telemetry: Telemetry,
  ) {
    this.http = new AirwallexHttp(cfg, telemetry);
    const http = this.http;
    this.simulation = {
      async passCardholderReview(id) {
        await http.request('POST', `/api/v1/simulation/issuing/cardholders/${id}/pass_review`, 'Simulate cardholder review pass', {});
      },
      authorize(req: SimAuthRequest) {
        return http.request<SimulatedTransaction>('POST', '/api/v1/simulation/issuing/create', `Network auth ${req.transaction_amount} ${req.transaction_currency}`, { ...req });
      },
      capture(lifecycleId, body = {}) {
        return http.request<SimulatedTransaction>('POST', `/api/v1/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/capture`, 'Capture (CLEARING)', body);
      },
      reverse(lifecycleId, body = {}) {
        return http.request<SimulatedTransaction>('POST', `/api/v1/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/reverse`, 'Reverse authorization', body);
      },
    };
  }

  getBalances() {
    return this.http.request<Balance[]>('GET', '/api/v1/balances/current', 'Fetch wallet balances');
  }

  createCardholder(payload: CardholderPayload) {
    return this.http.request<Cardholder>('POST', '/api/v1/issuing/cardholders/create', 'Create cardholder', payload as unknown as Record<string, unknown>);
  }

  getCardholder(id: string) {
    return this.http.request<Cardholder>('GET', `/api/v1/issuing/cardholders/${id}`, 'Get cardholder');
  }

  createCard(payload: CardCreatePayload) {
    return this.http.request<Card>('POST', '/api/v1/issuing/cards/create', 'Issue virtual card', payload as unknown as Record<string, unknown>);
  }

  getCard(id: string) {
    return this.http.request<Card>('GET', `/api/v1/issuing/cards/${id}`, 'Get card');
  }

  getCardLimits(id: string) {
    return this.http.request<CardLimits>('GET', `/api/v1/issuing/cards/${id}/limits`, 'Read card limits');
  }

  updateCard(id: string, patch: { card_status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED' }) {
    const title = patch.card_status === 'INACTIVE' ? 'Freeze card (INACTIVE)' : patch.card_status === 'ACTIVE' ? 'Unfreeze card (ACTIVE)' : 'Update card';
    return this.http.request<Card>('POST', `/api/v1/issuing/cards/${id}/update`, title, { ...patch });
  }
}
