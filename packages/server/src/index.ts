import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVendorStorefront, Telemetry } from '@intentguard/simulation-adapter';
import { Orchestrator } from './orchestrator.js';
import { contractToText } from './contractLoader.js';
import { llmLabel } from '@intentguard/cognitive-agent';

const PORT = Number(process.env.PORT || 8787);
const here = path.dirname(fileURLToPath(import.meta.url));

const telemetry = new Telemetry();
let orch: Orchestrator;
const storefront = createVendorStorefront({
  network: () => {
    if (!orch?.network) throw new Error('Rail not connected; run Act 1');
    return orch.network;
  },
  registryUrl: () => `http://localhost:${PORT}/registry/keys`,
  telemetry,
});
orch = new Orchestrator({ telemetry, port: PORT, configureMerchant: (next) => storefront.configure(next), resetMerchant: () => storefront.reset() });

const app = express();
app.use('/merchant', storefront.router);

// Stand-in for Visa's TAP public key directory ("GET /keys" with keyID).
app.get('/registry/keys', (req, res) => {
  const kid = String(req.query.keyID ?? '');
  if (kid !== orch.agentKey.keyid) return res.status(404).json({ error: 'unknown_key' });
  res.json(orch.agentKey.publicJwk);
});

app.use('/api', express.json({ limit: '12mb' }));

app.get('/api/state', (_req, res) => res.json({ state: orch.state, telemetry: telemetry.log }));

app.get('/api/events', (req: Request, res: Response) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('snapshot', { state: orch.state, telemetry: telemetry.log });
  const onEvent = (e: unknown) => send('telemetry', e);
  const onClear = () => send('clear', {});
  telemetry.on('event', onEvent);
  telemetry.on('clear', onClear);
  const off = orch.onState((s) => send('state', s));
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    telemetry.off('event', onEvent);
    telemetry.off('clear', onClear);
    off();
  });
});

const action = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    await fn(req);
    res.json({ ok: true, state: orch.state });
  } catch (e) {
    res.status(409).json({ ok: false, error: (e as Error).message, state: orch.state });
  }
};

app.post('/api/reset', action(async () => orch.reset()));
app.post('/api/act1', action((req) => orch.act1({ reserveFloor: req.body?.reserveFloor, forceEmulator: req.body?.forceEmulator })));
app.post('/api/act2', action(() => orch.act2()));
app.post('/api/approve', action(() => orch.approveAndProvision()));
app.post('/api/shock', action((req) => orch.triggerShock(req.body?.mode === 'CADENCE_FLIP' ? 'CADENCE_FLIP' : 'FEE')));
app.post('/api/resolve', action(() => orch.resolve()));
app.post('/api/probe/unsigned-bot', action(() => orch.probeUnsignedBot()));
app.post('/api/refund', action(() => orch.refund()));

// Upload the vendor's order form / terms (PDF, .txt or .md as base64 JSON).
app.post(
  '/api/contract',
  action(async (req) => {
    const { filename, mimeType, data } = req.body ?? {};
    if (typeof filename !== 'string' || typeof data !== 'string') throw new Error('filename and data are required');
    const { text, pages } = await contractToText(filename, String(mimeType ?? ''), data);
    orch.loadContract(text, { name: filename.slice(0, 120), kind: 'upload', pages, chars: text.length });
  }),
);
app.post('/api/contract/sample', action(async () => orch.loadContract('sample', { name: 'CloudScale order form (sample)', kind: 'sample', chars: 0 })));

app.get('/api/trigger.ics', (_req, res) => {
  const ics = orch.triggerIcs();
  if (!ics) return res.status(404).send('No scheduled trigger yet');
  res.set({ 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="intentguard-reevaluation.ics"' }).send(ics);
});

// Sample vendor order forms (PDF) for trying the upload flow.
app.use('/samples', express.static(path.resolve(here, '../../../samples'), { index: false }));

const uiDist = path.resolve(here, '../../command-center-ui/dist');
if (process.env.NODE_ENV === 'production' && existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get(/^\/(?!api|merchant|registry|samples).*/, (_req, res) => res.sendFile(path.join(uiDist, 'index.html')));
}

app.listen(PORT, () => {
  const live = process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY;
  console.log(`IntentGuard API on http://localhost:${PORT}`);
  console.log(`  Airwallex: ${process.env.AIRWALLEX_MODE === 'emulator' ? 'EMULATOR (AIRWALLEX_MODE=emulator)' : live ? 'sandbox credentials found (LIVE)' : 'no credentials -> EMULATOR'}`);
  console.log(`  Model:     ${llmLabel()}`);
});
