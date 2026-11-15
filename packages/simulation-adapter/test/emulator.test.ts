import { describe, expect, it } from 'vitest';
import { buildCardCreatePayload, buildCardholderRestPayload, CLOUDSCALE, PurchaseIntent } from '@intentguard/deterministic-engine';
import { EmulatedAirwallexRail, IssuingNetworkSimulator, Telemetry } from '../src/index.js';

function intent(cadence: 'MONTHLY' | 'ANNUAL', amount: number): PurchaseIntent {
  return {
    version: 'intentguard/1', intentId: 'i', merchant: CLOUDSCALE, sku: 'SKU', description: 'd', seats: 1,
    billing: { cadence, amount, currency: 'USD' },
    reserveCheck: { inputHash: 'h', reserveFloor: 40000, projectedMinBalance: 44000, minWeek: 7 },
    createdAt: '2026-11-15T00:00:00.000Z',
  };
}

async function setup(cadence: 'MONTHLY' | 'ANNUAL', amount: number) {
  const rail = new EmulatedAirwallexRail(new Telemetry());
  const ch = await rail.createCardholder(buildCardholderRestPayload({ email: 'a@b.co', firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', address: { line1: '1', city: 'S', postcode: '2000', country: 'AU' } }));
  const card = await rail.createCard(buildCardCreatePayload(intent(cadence, amount), ch.cardholder_id, 'hash', { createdBy: 't', activeDays: 35 }));
  return { rail, net: new IssuingNetworkSimulator(rail), card };
}

describe('Airwallex emulator semantics', () => {
  it('declines over-limit and frozen-card authorizations with Airwallex failure reasons', async () => {
    const { rail, net, card } = await setup('MONTHLY', 1000);
    expect((await net.authorize(card.card_id, 1250, 'USD', '5734', 'm')).failure_reason).toBe('LIMIT_EXCEEDED');
    await rail.updateCard(card.card_id, { card_status: 'INACTIVE' });
    expect((await net.authorize(card.card_id, 250, 'USD', '5734', 'm')).failure_reason).toBe('CARD_INACTIVE');
  });

  it('a SINGLE-use card is consumed by a reversed authorization (matches the live sandbox)', async () => {
    const { rail, net, card } = await setup('ANNUAL', 3000);
    const drifted = await net.authorize(card.card_id, 300, 'USD', '5734', 'm');
    expect(drifted.outcome).toBe('AUTHORIZED');
    await net.reverse(drifted.raw.card_transaction_lifecycle_id!);
    expect((await rail.getCard(card.card_id)).card_status).toBe('CLOSED');
    expect((await net.authorize(card.card_id, 3000, 'USD', '5734', 'm')).failure_reason).toBe('CARD_CLOSED');
  });

  it('refunds restore the cumulative limit', async () => {
    const { rail, net, card } = await setup('MONTHLY', 1000);
    const a = await net.authorize(card.card_id, 1000, 'USD', '5734', 'm');
    await net.capture(a.raw.card_transaction_lifecycle_id!);
    expect((await rail.getCardLimits(card.card_id)).limits.find((l) => l.interval === 'MONTHLY')?.remaining).toBe(0);
    const r = await net.refund(card.card_id, 1000, 'USD', '5734', 'm', a.raw.card_transaction_lifecycle_id);
    expect(r.outcome).toBe('CLEARED');
    expect((await rail.getCardLimits(card.card_id)).limits.find((l) => l.interval === 'MONTHLY')?.remaining).toBe(1000);
  });
});
