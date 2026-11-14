import { describe, expect, it } from 'vitest';
import {
  buildPaymentContainer,
  generateAgentKey,
  NonceCache,
  signTapRequest,
  verifyTapRequest,
} from '../src/index.js';

const authority = 'checkout.cloudscale.example';
const now = 1_763_100_000;

function setup() {
  const key = generateAgentKey();
  const resolveKey = (kid: string) => (kid === key.keyid ? key.publicKey : null);
  return { key, resolveKey, nonces: new NonceCache() };
}

describe('Visa TAP (RFC 9421) signatures', () => {
  it('produces the TAP Signature-Input shape', () => {
    const { key } = setup();
    const s = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now });
    expect(s.headers['Signature-Input']).toMatch(/^sig2=\("@authority" "@path"\);created=\d+;expires=\d+;keyid="[^"]+";alg="ed25519";nonce="[^"]+";tag="agent-payer-auth"$/);
    expect(s.headers.Signature).toMatch(/^sig2=:[A-Za-z0-9+/=]+:$/);
    expect(s.signatureBase.split('\n')[0]).toBe(`"@authority": ${authority}`);
  });

  it('merchant verifies a valid payer-auth request with payment container', async () => {
    const { key, resolveKey, nonces } = setup();
    const s = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now });
    const container = buildPaymentContainer(key, s.params.nonce, { intentHash: 'h', bindingHash: 'b', amount: '1000.00', currency: 'USD' });
    const v = await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now, container });
    expect(v.ok).toBe(true);
  });

  it('rejects replayed nonces', async () => {
    const { key, resolveKey, nonces } = setup();
    const s = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now });
    await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now });
    const again = await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now + 1 });
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/replay/);
  });

  it('rejects a signature replayed against a different path', async () => {
    const { key, resolveKey, nonces } = setup();
    const s = signTapRequest({ key, authority, path: '/products/apm', tag: 'agent-payer-auth', nowSeconds: now });
    const v = await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });

  it('rejects browsing tag at checkout, expired signatures, and unknown keys', async () => {
    const { key, resolveKey, nonces } = setup();
    const browse = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-browser-auth', nowSeconds: now });
    expect((await verifyTapRequest({ authority, path: '/checkout', headers: browse.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now })).reason).toMatch(/tag/);
    const old = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now - 1000, ttlSeconds: 300 });
    expect((await verifyTapRequest({ authority, path: '/checkout', headers: old.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now })).reason).toMatch(/expire/);
    const other = generateAgentKey();
    const s = signTapRequest({ key: other, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now });
    expect((await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now })).reason).toMatch(/key-directory/);
  });

  it('rejects a payment container whose nonce does not match the message signature', async () => {
    const { key, resolveKey, nonces } = setup();
    const s = signTapRequest({ key, authority, path: '/checkout', tag: 'agent-payer-auth', nowSeconds: now });
    const container = buildPaymentContainer(key, 'different-nonce', { intentHash: 'h', bindingHash: 'b', amount: '1000.00', currency: 'USD' });
    const v = await verifyTapRequest({ authority, path: '/checkout', headers: s.headers, requiredTag: 'agent-payer-auth', resolveKey, nonces, nowSeconds: now, container });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/container-nonce/);
  });
});
