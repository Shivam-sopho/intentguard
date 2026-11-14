import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let client: Anthropic | null = null;

/** Claude is used only when credentials are configured; otherwise callers use labelled offline fallbacks. */
export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.INTENTGUARD_DISABLE_LLM !== '1';
}

export function getClaude(): Anthropic {
  if (!client) client = new Anthropic({ timeout: 60_000, maxRetries: 2 });
  return client;
}

/**
 * Server-side refusal fallbacks (beta): if the primary model declines, the API re-runs the
 * request on a fallback model inside the same call. Enabled by default for Opus 5.5.
 */
export const FALLBACK_PARAMS = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default' as const,
};

export interface LlmTrace {
  engine: 'claude' | 'offline';
  model?: string;
  ms: number;
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string | null;
  error?: string;
}
