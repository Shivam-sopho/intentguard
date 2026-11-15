import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunState, TelemetryEvent } from './types';

export function useRun() {
  const [state, setState] = useState<RunState | null>(null);
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setState(d.state);
      setEvents(d.telemetry);
      setConnected(true);
    });
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('telemetry', (e) => setEvents((prev) => [...prev.slice(-400), JSON.parse((e as MessageEvent).data)]));
    es.addEventListener('clear', () => setEvents([]));
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => es.close();
  }, []);

  const call = useCallback(async (path: string, body: unknown = {}) => {
    setLastError(null);
    const res = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!json.ok) {
      setLastError(json.error);
      throw new Error(json.error);
    }
    setState(json.state);
    return json.state as RunState;
  }, []);

  const demoAbort = useRef(false);
  const [demoRunning, setDemoRunning] = useState(false);

  const runFullDemo = useCallback(
    async (opts: { reserveFloor?: number; pauseMs?: number } = {}) => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const p = opts.pauseMs ?? 3500;
      demoAbort.current = false;
      setDemoRunning(true);
      try {
        await call('reset');
        const steps: [string, unknown][] = [
          ['act1', { reserveFloor: opts.reserveFloor }],
          ['act2', {}],
          ['approve', {}],
          ['shock', {}],
          ['resolve', {}],
        ];
        for (const [path, body] of steps) {
          if (demoAbort.current) break;
          await call(path, body);
          await pause(path === 'shock' ? p * 2 : p);
        }
      } catch {
        /* error surfaced via lastError */
      } finally {
        setDemoRunning(false);
      }
    },
    [call],
  );

  return { state, events, connected, lastError, call, runFullDemo, demoRunning, stopDemo: () => (demoAbort.current = true) };
}

export const usd = (n: number | undefined | null, digits = 2) =>
  n === undefined || n === null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

export const usdK = (n: number) => `$${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`;
