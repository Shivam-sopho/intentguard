import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785 style for the value space we use): object keys sorted
 * lexicographically, no whitespace, numbers must be safe integers (we never hash floats -
 * amounts are hashed as fixed-point strings via canonicalAmount()).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new Error(`canonicalJson refuses non-integer number ${value}; hash amounts as fixed-point strings`);
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson cannot encode ${typeof value}`);
  }
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Base64(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('base64');
}
