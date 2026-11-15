import { useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';
import type { RunState } from '../types';

const SAMPLES = [
  { file: 'cloudscale-order-form.pdf', label: 'CloudScale APM', hint: 'yearly breaks the floor' },
  { file: 'northbeam-analytics-order-form.pdf', label: 'Northbeam Analytics', hint: 'bigger numbers' },
  { file: 'pagelight-status-order-form.pdf', label: 'PageLight', hint: 'yearly is safe' },
];

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Upload the vendor's order form / terms. The same path is used for the sample PDFs. */
export function ContractUpload({ state, call, disabled }: { state: RunState; call: (path: string, body?: unknown) => Promise<unknown>; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const src = state.contractSource;

  async function send(name: string, mimeType: string, buf: ArrayBuffer) {
    setError(null);
    setUploading(name);
    try {
      await call('contract', { filename: name, mimeType, data: toBase64(buf) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return setError('File is larger than 8 MB');
    await send(f.name, f.type, await f.arrayBuffer());
  }

  async function useSample(file: string) {
    const res = await fetch(`/samples/${file}`);
    if (!res.ok) return setError(`Could not load sample ${file}`);
    await send(file, 'application/pdf', await res.arrayBuffer());
  }

  const busy = disabled || Boolean(uploading);
  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!busy) void onFile(e.dataTransfer.files[0]);
        }}
        className={`rounded-2xl border-2 border-dashed p-6 text-center transition ${drag ? 'border-flame-500 bg-flame-500/10' : 'border-ink-600 bg-ink-900/60'}`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-[14px] text-ink-300"><Loader2 className="h-4 w-4 animate-spin" /> Reading {uploading}…</div>
        ) : (
          <>
            <Upload className="mx-auto h-7 w-7 text-ink-400" />
            <div className="mt-2 text-[15px] font-semibold">Drop the vendor's order form or terms here</div>
            <div className="text-[13px] text-ink-400">PDF, .txt or .md, up to 8 MB</div>
            <button className="btn-ghost mt-3" disabled={busy} onClick={() => input.current?.click()}>Choose a file</button>
            <input ref={input} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" className="hidden" onChange={(e) => void onFile(e.target.files?.[0] ?? undefined)} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-ink-400">Or try a sample contract:</span>
        {SAMPLES.map((s) => (
          <button key={s.file} className="rounded-full border border-ink-600 px-3 py-1 text-ink-200 hover:border-flame-500/60 hover:text-ink-100 disabled:opacity-40" disabled={busy} onClick={() => void useSample(s.file)} title={s.hint}>
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-xl border border-status-critical/50 bg-status-critical/10 px-4 py-3 text-[13px] text-status-critical">{error}</div>}

      <div className="flex items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/80 px-4 py-3 text-[14px]">
        <FileText className="h-4 w-4 shrink-0 text-flame-400" />
        <span className="text-ink-400">Contract loaded:</span>
        <span className="truncate font-medium">{src.name}</span>
        <span className="ml-auto shrink-0 text-[12px] text-ink-500">{src.pages ? `${src.pages} page${src.pages > 1 ? 's' : ''} · ` : ''}{src.chars.toLocaleString()} characters</span>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-status-good" />
      </div>
    </div>
  );
}
