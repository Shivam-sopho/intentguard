import { randomUUID } from 'node:crypto';

/**
 * request_id discipline (Airwallex): a fresh UUIDv4 per operation; reuse it ONLY to
 * retry the same operation. Reusing it for a different operation within 7 days returns
 * duplicate_request_id. The ledger records which operation each id belongs to and
 * throws if code ever tries to reuse an id for a different operation.
 */
const ledger = new Map<string, string>();

export function newRequestId(operation: string): string {
  const id = randomUUID();
  ledger.set(id, operation);
  return id;
}

/** Assert that a request_id is being (re)used for the operation it was minted for. */
export function assertRequestIdFor(requestId: string, operation: string): void {
  const owner = ledger.get(requestId);
  if (owner === undefined) {
    ledger.set(requestId, operation);
    return;
  }
  if (owner !== operation) {
    throw new Error(`request_id ${requestId} was minted for "${owner}" and cannot be reused for "${operation}"`);
  }
}

export function isUuidV4(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
