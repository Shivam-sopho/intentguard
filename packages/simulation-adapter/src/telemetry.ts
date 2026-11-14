import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type RailMode = 'LIVE' | 'EMULATOR';
export type Channel = 'AIRWALLEX' | 'MERCHANT' | 'VISA_TAP' | 'CLAUDE' | 'ENGINE' | 'OPERATOR';

export interface TelemetryEvent {
  id: string;
  ts: string;
  channel: Channel;
  title: string;
  level: 'info' | 'success' | 'warn' | 'error';
  mode?: RailMode;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  request?: unknown;
  response?: unknown;
  detail?: unknown;
}

export class Telemetry extends EventEmitter {
  readonly log: TelemetryEvent[] = [];

  emitEvent(e: Omit<TelemetryEvent, 'id' | 'ts'>): TelemetryEvent {
    const full: TelemetryEvent = { id: randomUUID(), ts: new Date().toISOString(), ...e };
    this.log.push(full);
    if (this.log.length > 500) this.log.shift();
    this.emit('event', full);
    return full;
  }

  clear() {
    this.log.length = 0;
    this.emit('clear');
  }
}

/** Redact PAN/CVV/tokens before anything reaches the telemetry stream or the model. */
export function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (k, v) => {
      if (typeof v !== 'string') return v;
      if (/^(card_number|cvv|token|x-api-key|authorization)$/i.test(k)) {
        return k === 'card_number' && v.length >= 4 ? `•••• ${v.slice(-4)}` : '[redacted]';
      }
      return v;
    }),
  );
}
