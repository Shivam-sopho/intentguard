/**
 * Probe the Airwallex sandbox with the configured credentials: login, balances,
 * and (optionally) whether Issuing is enabled. Read-only.
 */
import 'dotenv/config';
import { LiveAirwallexRail, Telemetry } from '@intentguard/simulation-adapter';

async function main() {
  const clientId = process.env.AIRWALLEX_CLIENT_ID;
  const apiKey = process.env.AIRWALLEX_API_KEY;
  if (!clientId || !apiKey) {
    console.error('Set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY in .env first.');
    process.exit(1);
  }
  const telemetry = new Telemetry();
  telemetry.on('event', (e) => console.log(`${e.status ?? ''} ${e.method ?? ''} ${e.path ?? ''} ${e.title}`.trim()));
  const rail = new LiveAirwallexRail({ baseUrl: process.env.AIRWALLEX_BASE_URL || 'https://api.sandbox.airwallex.com', clientId, apiKey }, telemetry);
  const balances = await rail.getBalances();
  console.log('Balances:', balances.map((b) => `${b.currency} ${b.available_amount}`).join(', ') || '(none)');
  try {
    const r = await rail.http.request<{ items: unknown[] }>('GET', '/api/v1/issuing/cards?page_size=10', 'List cards (Issuing enabled?)');
    console.log(`Issuing reachable: ${r.items?.length ?? 0} card(s) on first page`);
  } catch (e) {
    console.log('Issuing check failed:', (e as Error).message);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
