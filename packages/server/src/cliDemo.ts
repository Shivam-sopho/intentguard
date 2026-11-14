/**
 * Headless end-to-end run of all five acts against a running server
 * (npm run dev:api in another terminal). Exits non-zero on any failure.
 */
const BASE = process.env.INTENTGUARD_URL || 'http://localhost:8787';

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; error?: string; state: any };
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.state;
}

const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

async function main() {
  await post('/api/reset');
  let s = await post('/api/act1', process.env.FORCE_EMULATOR ? { forceEmulator: true } : {});
  console.log(`ACT 1  rail=${s.rail.mode} opening=${fmt(s.guardrails.openingBalance)} floor=${fmt(s.guardrails.reserveFloor)} (${s.guardrails.balanceSource})`);

  s = await post('/api/act2');
  const d = s.plan.decision;
  for (const v of d.verdicts) console.log(`ACT 2  ${v.optionId.padEnd(15)} ${v.safe ? 'SAFE  ' : 'BREACH'} low ${fmt(v.minBalance)} wk${v.minWeek}${v.firstBreachWeek ? ` first breach wk${v.firstBreachWeek}` : ''}`);
  console.log(`ACT 2  chose ${d.recommendedOptionId}; trigger: ${d.upgradeTrigger?.condition}`);
  console.log(`ACT 2  [${s.plan.narrative.trace.engine}] ${s.plan.narrative.text}`);

  s = await post('/api/approve');
  console.log(`ACT 3  card ${s.card.card.card_number} ${s.card.card.card_status} limits ${JSON.stringify(s.card.limits.limits)}`);

  s = await post('/api/shock');
  console.log(`ACT 4  attempted ${fmt(s.checkout.order.charged_amount)} -> ${s.incident.failureReason}; card ${s.incident.cardStatusAfter}; fee retry -> ${s.incident.retry?.failure_reason}`);
  console.log(`ACT 4  [${s.incident.narrative.trace.engine}] ${s.incident.narrative.text}`);

  s = await post('/api/resolve');
  console.log(`ACT 5  ${s.machineState}: order ${s.settlement.order.order_id} captured ${fmt(s.settlement.order.capture.raw.transaction_amount)}; limits after ${JSON.stringify(s.settlement.limitsAfter.limits)}`);
  console.log(`ACT 5  [${s.settlement.narrative.trace.engine}] ${s.settlement.narrative.text}`);
  if (s.machineState !== 'SETTLED') throw new Error('did not settle');
  console.log('\nAll 5 acts completed.');
}

main().catch((e) => {
  console.error('DEMO FAILED:', e.message);
  process.exit(1);
});
