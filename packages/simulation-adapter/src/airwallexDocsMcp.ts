/**
 * Minimal client for the Airwallex Docs MCP server (https://mcp.sandbox.airwallex.com/docs,
 * Streamable HTTP, no login). The agent uses it at runtime to look up what an Issuing
 * decline code means, citing Airwallex's own documentation in the incident report.
 */
import type { Telemetry } from './telemetry.js';

const DOCS_MCP_URL = process.env.AIRWALLEX_DOCS_MCP_URL || 'https://mcp.sandbox.airwallex.com/docs';

export interface FailureReasonDoc {
  failure_reason: string;
  category: string;
  description: string;
  next_steps: string;
  source: string;
}

export class AirwallexDocsMcp {
  private session: string | null = null;
  private nextId = 1;

  constructor(private telemetry: Telemetry, private timeoutMs = 15_000) {}

  private async rpc(method: string, params: unknown, notification = false): Promise<any> {
    const res = await fetch(DOCS_MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: this.nextId++ }), method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const text = await res.text();
    if (!res.ok) throw new Error(`Docs MCP ${method} -> HTTP ${res.status}`);
    if (notification || !text) return null;
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    const msg = JSON.parse(line ? line.slice(6) : text);
    if (msg.error) throw new Error(`Docs MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  private async ensureSession() {
    if (this.session) return;
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'intentguard', version: '0.1.0' } });
    await this.rpc('notifications/initialized', {}, true);
  }

  async searchDocs(question: string): Promise<string> {
    const t0 = Date.now();
    try {
      await this.ensureSession();
      const result = await this.rpc('tools/call', { name: 'search_public_docs', arguments: { question } });
      const text = (result?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
      this.telemetry.emitEvent({
        channel: 'AIRWALLEX',
        title: 'Airwallex Docs MCP: search_public_docs',
        level: 'success',
        method: 'MCP',
        path: 'tools/call search_public_docs',
        ms: Date.now() - t0,
        request: { question },
        response: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
      });
      return text;
    } catch (e) {
      this.session = null;
      this.telemetry.emitEvent({ channel: 'AIRWALLEX', title: `Airwallex Docs MCP unavailable: ${(e as Error).message}`, level: 'warn', method: 'MCP', ms: Date.now() - t0 });
      throw e;
    }
  }

  /** Look up an Issuing failure_reason in Airwallex's "Transaction failure reasons" table. */
  async explainFailureReason(reason: string): Promise<FailureReasonDoc | null> {
    const text = await this.searchDocs(`What does the Issuing card transaction failure_reason ${reason} mean?`);
    const escaped = reason.replace(/_/g, '\\_');
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const key = cells[0]?.replace(/\\_/g, '_');
      if (key === reason || cells[0] === escaped) {
        const strip = (s = '') => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
        return {
          failure_reason: reason,
          category: strip(cells[1]),
          description: strip(cells[2]),
          next_steps: strip(cells[3]) === '-' ? '' : strip(cells[3]),
          source: 'Airwallex docs: Transaction failure reasons (via Airwallex Docs MCP)',
        };
      }
    }
    return null;
  }
}
