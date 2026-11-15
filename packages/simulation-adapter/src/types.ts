import type { AuthorizationControls, CardCreatePayload, buildCardholderRestPayload } from '@intentguard/deterministic-engine';
import type { RailMode } from './telemetry.js';

export interface Balance {
  account_type?: string;
  currency: string;
  available_amount: number;
  pending_amount?: number;
  reserved_amount?: number;
  total_amount: number;
}

export interface Cardholder {
  cardholder_id: string;
  status: string; // INCOMPLETE | PENDING | READY | DISABLED | DELETED
  type: string;
  email: string;
}

export interface Card {
  card_id: string;
  card_status: string; // PENDING | ACTIVE | INACTIVE | CLOSED | ...
  card_number: string; // masked
  cardholder_id: string;
  brand: string;
  form_factor: string;
  nick_name?: string;
  authorization_controls: AuthorizationControls;
  created_at: string;
  request_id?: string;
}

export interface CardLimits {
  currency: string;
  limits: { amount: number; interval: string; remaining: number }[];
  cash_withdrawal_limits: unknown[];
}

/** Shape of /api/v1/simulation/issuing/* responses (subset we rely on). */
export interface SimulatedTransaction {
  process_result: 'APPROVED' | 'DECLINED';
  failure_reason?: string;
  type: 'AUTHORIZATION' | 'CLEARING' | 'REVERSAL_AUTH' | 'REFUND' | string;
  subtype?: string;
  card_id?: string;
  card_transaction_id?: string;
  card_transaction_lifecycle_id?: string;
  transaction_amount: number;
  transaction_currency: string;
  billing_amount?: number;
  masked_card_number?: string;
  merchant?: { category_code?: string; name?: string; city?: string; country?: string };
  auth_code?: string;
  transacted_at?: string;
}

export interface SimAuthRequest {
  card_id: string;
  transaction_amount: number;
  transaction_currency: string;
  merchant_category_code: string;
  merchant_info: string;
}

export type CardholderPayload = ReturnType<typeof buildCardholderRestPayload>;

/** One interface, two implementations: live Airwallex sandbox and the offline emulator. */
export interface IssuingRail {
  readonly mode: RailMode;
  getBalances(): Promise<Balance[]>;
  createCardholder(payload: CardholderPayload): Promise<Cardholder>;
  getCardholder(id: string): Promise<Cardholder>;
  createCard(payload: CardCreatePayload): Promise<Card>;
  getCard(id: string): Promise<Card>;
  getCardLimits(id: string): Promise<CardLimits>;
  updateCard(id: string, patch: { card_status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED' }): Promise<Card>;
  /** Sandbox-only simulation endpoints, isolated here so core logic stays production-shaped. */
  simulation: IssuingSimulationApi;
}

export interface IssuingSimulationApi {
  passCardholderReview(cardholderId: string): Promise<void>;
  authorize(req: SimAuthRequest): Promise<SimulatedTransaction>;
  capture(lifecycleId: string, body?: { transaction_amount?: number; merchant_info?: string }): Promise<SimulatedTransaction>;
  reverse(lifecycleId: string, body?: { transaction_amount?: number }): Promise<SimulatedTransaction>;
  refund(body: { card_id: string; transaction_amount: number; transaction_currency: string; card_transaction_lifecycle_id?: string; merchant_category_code?: string; merchant_info?: string }): Promise<SimulatedTransaction>;
}
