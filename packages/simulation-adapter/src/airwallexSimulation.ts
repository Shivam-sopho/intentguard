/**
 * Card-network simulator: stands in for "merchant acquirer -> Visa -> Airwallex Issuing".
 * Wraps the sandbox-only /api/v1/simulation/issuing/* endpoints behind one interface
 * and maps every response with the builder-guide rules (failure_reason => FAILED,
 * CLEARING + APPROVED => accepted).
 */
import { mapSimulationResult, RailOutcome } from '@intentguard/deterministic-engine';
import type { IssuingRail, SimulatedTransaction } from './types.js';

export interface NetworkResult {
  outcome: RailOutcome;
  failure_reason?: string;
  raw: SimulatedTransaction;
}

export class IssuingNetworkSimulator {
  constructor(private rail: IssuingRail) {}

  get mode() {
    return this.rail.mode;
  }

  async authorize(cardId: string, amount: number, currency: string, mcc: string, merchantName: string): Promise<NetworkResult> {
    const raw = await this.rail.simulation.authorize({
      card_id: cardId,
      transaction_amount: amount,
      transaction_currency: currency,
      merchant_category_code: mcc,
      merchant_info: merchantName,
    });
    return { ...mapSimulationResult(raw), raw };
  }

  async capture(lifecycleId: string, amount?: number): Promise<NetworkResult> {
    const raw = await this.rail.simulation.capture(lifecycleId, amount === undefined ? {} : { transaction_amount: amount });
    return { ...mapSimulationResult(raw), raw };
  }

  async refund(cardId: string, amount: number, currency: string, mcc: string, merchantName: string, lifecycleId?: string): Promise<NetworkResult> {
    const raw = await this.rail.simulation.refund({
      card_id: cardId,
      transaction_amount: amount,
      transaction_currency: currency,
      card_transaction_lifecycle_id: lifecycleId,
      merchant_category_code: mcc,
      merchant_info: merchantName,
    });
    // A refund is a credit, so an APPROVED refund maps to "accepted" regardless of its type label.
    return { outcome: raw.failure_reason || raw.process_result === 'DECLINED' ? 'FAILED' : 'CLEARED', failure_reason: raw.failure_reason, raw };
  }

  async reverse(lifecycleId: string): Promise<NetworkResult> {
    const raw = await this.rail.simulation.reverse(lifecycleId);
    return { ...mapSimulationResult(raw), raw };
  }
}
