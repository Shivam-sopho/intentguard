import Anthropic from '@anthropic-ai/sdk';
import { claudeCodeBinary } from './claudeCode.js';

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

/**
 * Which model backend serves the probabilistic layer:
 *   api          Anthropic API (ANTHROPIC_API_KEY set)
 *   claude-code  headless `claude -p` using the local Claude Code login (no API key needed)
 *   offline      labelled templates / regex parser
 * Override with INTENTGUARD_LLM=api|claude-code|offline.
 */
export type LlmBackend = 'api' | 'claude-code' | 'offline';

export function llmBackend(): LlmBackend {
  const forced = process.env.INTENTGUARD_LLM;
  if (forced === 'api' || forced === 'claude-code' || forced === 'offline') return forced;
  if (process.env.INTENTGUARD_DISABLE_LLM === '1') return 'offline';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'api';
  if (claudeCodeBinary()) return 'claude-code';
  return 'offline';
}

export function claudeAvailable(): boolean {
  return llmBackend() !== 'offline';
}

export function llmLabel(): string {
  const b = llmBackend();
  if (b === 'api') return `${CLAUDE_MODEL} (Anthropic API)`;
  if (b === 'claude-code') return `Claude Code${process.env.CLAUDE_CODE_MODEL ? ` · ${process.env.CLAUDE_CODE_MODEL}` : ''}`;
  return 'offline templates';
}

let client: Anthropic | null = null;

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
  via?: 'api' | 'claude-code';
  model?: string;
  ms: number;
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string | null;
  error?: string;
}
