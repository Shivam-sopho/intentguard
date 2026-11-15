/**
 * Claude Code as the model backend: runs `claude -p` headlessly using the operator's
 * existing Claude Code login, so no ANTHROPIC_API_KEY is needed.
 *
 * Hardened for untrusted input (the vendor quote can contain prompt injection):
 *   --tools ""             no built-in tools (no shell, no file access, no web)
 *   --strict-mcp-config    no MCP servers
 *   --no-session-persistence, empty temp working directory
 *   --system-prompt        replaces Claude Code's agent prompt with ours
 *   parent-session env vars are stripped so it runs as an independent process
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
];

let cachedBin: string | null | undefined;

export function claudeCodeBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  if (process.env.CLAUDE_CODE_BIN && existsSync(process.env.CLAUDE_CODE_BIN)) return (cachedBin = process.env.CLAUDE_CODE_BIN);
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const found = r.status === 0 ? r.stdout.split('\n')[0].trim() : '';
  return (cachedBin = found || null);
}

export interface ClaudeCodeResult {
  text: string;
  structured?: unknown;
  model: string;
  ms: number;
}

export class ClaudeCodeError extends Error {}

export function runClaudeCode(opts: { system: string; prompt: string; jsonSchema?: object; timeoutMs?: number; effort?: 'low' | 'medium' | 'high' }): Promise<ClaudeCodeResult> {
  const bin = claudeCodeBinary();
  if (!bin) return Promise.reject(new ClaudeCodeError('claude CLI not found on PATH'));
  const cwd = path.join(tmpdir(), 'intentguard-llm');
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  for (const k of PARENT_SESSION_VARS) delete env[k];

  const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', opts.system, '--effort', opts.effort ?? 'low'];
  if (process.env.CLAUDE_CODE_MODEL) args.push('--model', process.env.CLAUDE_CODE_MODEL);
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));

  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ClaudeCodeError(`claude -p timed out after ${opts.timeoutMs ?? 120_000} ms`));
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ClaudeCodeError(e.message));
    });
    child.on('close', () => {
      clearTimeout(timer);
      let parsed: { is_error?: boolean; result?: string; structured_output?: unknown; modelUsage?: Record<string, unknown>; terminal_reason?: string };
      try {
        parsed = JSON.parse(out);
      } catch {
        return reject(new ClaudeCodeError(`unparseable claude output: ${(out || err).slice(0, 200)}`));
      }
      if (parsed.is_error) return reject(new ClaudeCodeError(`claude -p error: ${parsed.result ?? parsed.terminal_reason}`));
      resolve({
        text: parsed.result ?? '',
        structured: parsed.structured_output,
        model: Object.keys(parsed.modelUsage ?? {})[0] ?? 'claude',
        ms: Date.now() - t0,
      });
    });
    child.stdin.end(opts.prompt);
  });
}
