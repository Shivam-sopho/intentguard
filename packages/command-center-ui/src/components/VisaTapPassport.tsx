import { useState } from 'react';
import { Fingerprint, KeyRound, ShieldX } from 'lucide-react';
import type { RunState } from '../types';

export function VisaTapPassport({ state, onProbe }: { state: RunState | null; onProbe: () => void }) {
  const [showBase, setShowBase] = useState(false);
  const tap = state?.tap;
  const intent = state?.intent;
  return (
    <div className="space-y-2.5 p-3 text-[12px]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-flame-400" />
          <span className="font-semibold">Trusted Agent Protocol credential</span>
        </div>
        <span className="chip border-ink-600 text-ink-300">RFC 9421 · Ed25519</span>
      </div>
      <Row k="keyid (JWK thumbprint)" v={tap?.keyid ?? '—'} />
      <Row k="intent hash (SHA-256)" v={intent?.intentHash ?? 'pending approval'} accent={Boolean(intent)} />
      <Row k="binding hash" v={intent?.bindingHash ?? '—'} />
      {tap?.lastSignatureInput ? (
        <div className="rounded-md border border-ink-700 bg-ink-950 p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-400">
            <span>Signature-Input · {tap.lastTag}</span>
            <button className="text-ink-300 hover:text-ink-100" onClick={() => setShowBase((s) => !s)}>{showBase ? 'hide' : 'show'} signature base</button>
          </div>
          <code className="block break-all font-mono text-[10.5px] leading-snug text-sky-300">{tap.lastSignatureInput}</code>
          {showBase && <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-ink-300">{tap.lastSignatureBase}</pre>}
        </div>
      ) : (
        <div className="text-ink-400">Every merchant request is signed: <span className="font-mono">agent-browser-auth</span> to browse, <span className="font-mono">agent-payer-auth</span> + agenticPaymentContainer to pay.</div>
      )}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="flex items-center gap-1 text-ink-400"><KeyRound className="h-3.5 w-3.5" /> {tap?.verifications ?? 0} signed requests this run</span>
        <button className="chip border-ink-600 text-ink-300 hover:border-status-critical/60 hover:text-status-critical" onClick={onProbe} disabled={!state?.rail.mode}>
          <ShieldX className="h-3 w-3" /> try unsigned bot
        </button>
      </div>
      {state?.blockedBotProbe && (
        <div className="slide-in rounded-md border border-status-critical/40 bg-status-critical/10 px-2 py-1 font-mono text-[11px] text-status-critical">
          HTTP {state.blockedBotProbe.status} bot_blocked: {state.blockedBotProbe.reason}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-ink-400">{k}</span>
      <span className={`truncate font-mono text-[11px] ${accent ? 'text-flame-400' : 'text-ink-200'}`} title={v}>{v}</span>
    </div>
  );
}
