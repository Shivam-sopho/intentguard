/**
 * Visa Trusted Agent Protocol (TAP) - agent-side signer and merchant-side verifier.
 *
 * Implements the wire format published at github.com/visa/trusted-agent-protocol:
 * RFC 9421 HTTP Message Signatures over ("@authority" "@path") with parameters
 * created, expires, keyid, alg, nonce and tag ("agent-browser-auth" for browsing,
 * "agent-payer-auth" for checkout). Window <= 8 minutes; nonces are single-use.
 *
 * The agenticPaymentContainer object travels in the checkout body and carries the
 * same nonce, signed by the same key. `intentBinding` is an IntentGuard extension
 * field (not part of the TAP spec) that binds the checkout to the approved intent.
 *
 * This is a protocol-faithful implementation for a sandbox merchant we control.
 * Production TAP requires Visa onboarding and keys published in Visa's key directory.
 */
import { createPublicKey, generateKeyPairSync, KeyObject, randomBytes, sign, verify, JsonWebKey } from 'node:crypto';
import { canonicalJson, sha256Base64, sha256Hex } from './canonical.js';

export type TapTag = 'agent-browser-auth' | 'agent-payer-auth';
export const TAP_MAX_WINDOW_SECONDS = 8 * 60;
const COVERED = ['@authority', '@path'] as const;

export interface AgentKey {
  keyid: string;
  alg: 'ed25519';
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: JsonWebKey & { kid: string; use: string; alg: string };
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7638 JWK thumbprint for an OKP key: SHA-256 over {"crv","kty","x"}. */
function jwkThumbprint(jwk: JsonWebKey): string {
  const json = canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64url(Buffer.from(sha256Hex(json), 'hex'));
}

export function generateAgentKey(): AgentKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const keyid = jwkThumbprint(jwk);
  return { keyid, alg: 'ed25519', privateKey, publicKey, publicJwk: { ...jwk, kid: keyid, use: 'sig', alg: 'EdDSA' } };
}

export function publicKeyFromJwk(jwk: JsonWebKey): KeyObject {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

export interface SignatureParams {
  created: number;
  expires: number;
  keyid: string;
  alg: string;
  nonce: string;
  tag: TapTag;
}

/** Serialize @signature-params exactly as it appears in Signature-Input (RFC 9421 §2.3). */
export function serializeSignatureParams(p: SignatureParams, components: readonly string[] = COVERED): string {
  const inner = components.map((c) => `"${c}"`).join(' ');
  return `(${inner});created=${p.created};expires=${p.expires};keyid="${p.keyid}";alg="${p.alg}";nonce="${p.nonce}";tag="${p.tag}"`;
}

/** Build the RFC 9421 signature base for the derived components we cover. */
export function buildSignatureBase(authority: string, path: string, paramsValue: string, components: readonly string[] = COVERED): string {
  const lines: string[] = [];
  for (const c of components) {
    if (c === '@authority') lines.push(`"@authority": ${authority.toLowerCase()}`);
    else if (c === '@path') lines.push(`"@path": ${path}`);
    else throw new Error(`Unsupported covered component ${c}`);
  }
  lines.push(`"@signature-params": ${paramsValue}`);
  return lines.join('\n');
}

export interface SignedTapRequest {
  headers: { 'Signature-Input': string; Signature: string };
  params: SignatureParams;
  signatureBase: string;
}

export function signTapRequest(opts: {
  key: AgentKey;
  authority: string;
  path: string;
  tag: TapTag;
  nowSeconds?: number;
  ttlSeconds?: number;
  nonce?: string;
  label?: string;
}): SignedTapRequest {
  const created = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(opts.ttlSeconds ?? 300, TAP_MAX_WINDOW_SECONDS);
  const params: SignatureParams = {
    created,
    expires: created + ttl,
    keyid: opts.key.keyid,
    alg: opts.key.alg,
    nonce: opts.nonce ?? b64url(randomBytes(32)),
    tag: opts.tag,
  };
  const label = opts.label ?? 'sig2';
  const paramsValue = serializeSignatureParams(params);
  const signatureBase = buildSignatureBase(opts.authority, opts.path, paramsValue);
  const sig = sign(null, Buffer.from(signatureBase), opts.key.privateKey).toString('base64');
  return {
    headers: { 'Signature-Input': `${label}=${paramsValue}`, Signature: `${label}=:${sig}:` },
    params,
    signatureBase,
  };
}

// ---------------------------------------------------------------------------
// agenticPaymentContainer (TAP body object) + IntentGuard intent binding extension
// ---------------------------------------------------------------------------

export interface AgenticPaymentContainer {
  nonce: string;
  kid: string;
  alg: string;
  /** SHA-256 over PAN|expMM|expYY|CVV - card data never enters the model context. */
  paymentCredentialsHash?: string;
  /** IntentGuard extension: binds this checkout to the human-approved intent. */
  intentBinding: { intentHash: string; bindingHash: string; amount: string; currency: string };
  signature: string;
}

export function paymentCredentialsHash(pan: string, expMonth: string, expYear: string, cvv: string): string {
  return sha256Base64(`${pan}${expMonth.padStart(2, '0')}${expYear.slice(-2)}${cvv}`);
}

export function buildPaymentContainer(
  key: AgentKey,
  nonce: string,
  intentBinding: AgenticPaymentContainer['intentBinding'],
  credentialsHash?: string,
): AgenticPaymentContainer {
  const unsigned = { nonce, kid: key.keyid, alg: key.alg, paymentCredentialsHash: credentialsHash, intentBinding };
  const signature = sign(null, Buffer.from(canonicalJson(unsigned)), key.privateKey).toString('base64');
  return { ...unsigned, signature };
}

// ---------------------------------------------------------------------------
// Merchant-side verification
// ---------------------------------------------------------------------------

export interface ParsedSignatureInput {
  label: string;
  components: string[];
  params: Partial<SignatureParams> & Record<string, string | number>;
  paramsValue: string;
}

/** Minimal RFC 8941 parser for a single Signature-Input member: label=("a" "b");k=v;k="v" */
export function parseSignatureInput(header: string): ParsedSignatureInput {
  const m = /^\s*([A-Za-z0-9_*-]+)=\(([^)]*)\)(.*)$/.exec(header);
  if (!m) throw new Error('Malformed Signature-Input');
  const [, label, inner, rest] = m;
  const components = inner.trim() === '' ? [] : inner.trim().split(/\s+/).map((c) => c.replace(/^"|"$/g, ''));
  const params: Record<string, string | number> = {};
  for (const part of rest.split(';').filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    params[k] = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
  }
  return { label, components, params, paramsValue: `(${inner})${rest}` };
}

export function parseSignature(header: string, label: string): Buffer {
  const re = new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`);
  const m = re.exec(header);
  if (!m) throw new Error(`No signature for label ${label}`);
  return Buffer.from(m[1], 'base64');
}

export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private ttlSeconds = TAP_MAX_WINDOW_SECONDS) {}
  /** Returns false if the nonce was already used inside the window. */
  claim(nonce: string, nowSeconds: number): boolean {
    for (const [n, exp] of this.seen) if (exp <= nowSeconds) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowSeconds + this.ttlSeconds);
    return true;
  }
}

export type KeyResolver = (keyid: string) => Promise<KeyObject | null> | KeyObject | null;

export interface TapVerification {
  ok: boolean;
  reason: string;
  tag?: string;
  keyid?: string;
  nonce?: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  signatureBase?: string;
}

export async function verifyTapRequest(opts: {
  authority: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  requiredTag: TapTag;
  resolveKey: KeyResolver;
  nonces: NonceCache;
  nowSeconds?: number;
  container?: AgenticPaymentContainer;
}): Promise<TapVerification> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const checks: TapVerification['checks'] = [];
  const fail = (name: string, detail: string, extra: Partial<TapVerification> = {}): TapVerification => {
    checks.push({ name, ok: false, detail });
    return { ok: false, reason: `${name}: ${detail}`, checks, ...extra };
  };
  const pass = (name: string, detail?: string) => checks.push({ name, ok: true, detail });

  const h = (k: string) => {
    const v = opts.headers[k] ?? opts.headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const sigInput = h('Signature-Input');
  const sigHeader = h('Signature');
  if (!sigInput || !sigHeader) return fail('headers', 'Signature-Input and Signature headers required');
  pass('headers');

  let parsed: ParsedSignatureInput;
  try {
    parsed = parseSignatureInput(sigInput);
  } catch (e) {
    return fail('parse', (e as Error).message);
  }
  const p = parsed.params;
  for (const req of ['created', 'expires', 'keyid', 'alg', 'nonce', 'tag']) {
    if (p[req] === undefined || p[req] === '') return fail('required-params', `missing ${req}`);
  }
  pass('required-params');
  const meta = { tag: String(p.tag), keyid: String(p.keyid), nonce: String(p.nonce) };

  if (p.tag !== opts.requiredTag) return fail('tag', `expected ${opts.requiredTag}, got ${p.tag}`, meta);
  pass('tag', String(p.tag));

  for (const c of COVERED) if (!parsed.components.includes(c)) return fail('covered-components', `missing ${c}`, meta);
  pass('covered-components', parsed.components.join(' '));

  const created = Number(p.created);
  const expires = Number(p.expires);
  if (!(created <= now + 5)) return fail('created', 'created is in the future', meta);
  if (!(expires > now)) return fail('expires', 'signature expired', meta);
  if (expires - created > TAP_MAX_WINDOW_SECONDS) return fail('window', `window ${expires - created}s exceeds 480s`, meta);
  pass('time-window', `${expires - created}s`);

  if (String(p.alg).toLowerCase() !== 'ed25519') return fail('alg', `unsupported alg ${p.alg}`, meta);

  const key = await opts.resolveKey(String(p.keyid));
  if (!key) return fail('key-directory', `unknown keyid ${p.keyid}`, meta);
  pass('key-directory', String(p.keyid));

  const signatureBase = buildSignatureBase(opts.authority, opts.path, parsed.paramsValue, parsed.components);
  let sigBytes: Buffer;
  try {
    sigBytes = parseSignature(sigHeader, parsed.label);
  } catch (e) {
    return fail('signature', (e as Error).message, meta);
  }
  if (!verify(null, Buffer.from(signatureBase), key, sigBytes)) {
    return fail('signature', 'Ed25519 verification failed', { ...meta, signatureBase });
  }
  pass('signature', 'Ed25519 over RFC 9421 signature base');

  if (!opts.nonces.claim(String(p.nonce), now)) return fail('replay', 'nonce already used', meta);
  pass('replay', 'nonce fresh');

  if (opts.container) {
    const c = opts.container;
    if (c.nonce !== p.nonce) return fail('container-nonce', 'agenticPaymentContainer nonce mismatch', meta);
    const { signature, ...unsigned } = c;
    const okC = c.kid === p.keyid && verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(signature, 'base64'));
    if (!okC) return fail('container-signature', 'agenticPaymentContainer signature invalid', meta);
    pass('payment-container', 'nonce + signature bound to message signature');
  }

  return { ok: true, reason: 'verified', checks, signatureBase, ...meta };
}
