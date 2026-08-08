import type { Harness } from './types.js';

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+|-+$/gu, '');
}

export function detectHarness(environment: NodeJS.ProcessEnv = process.env): Harness {
  if (environment.CLANKCHAT_HARNESS === 'claude-code') return 'claude-code';
  if (environment.CLANKCHAT_HARNESS === 'opencode') return 'opencode';
  if (environment.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  if (environment.OPENCODE_PID) return 'opencode';
  return 'other';
}

export function agentIdentity(
  harness = detectHarness(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.CLANKCHAT_AGENT) return environment.CLANKCHAT_AGENT;
  const native =
    harness === 'claude-code'
      ? environment.CLAUDE_CODE_SESSION_ID
      : harness === 'opencode'
        ? environment.OPENCODE_PID
        : undefined;
  if (!native) return `${harness}-${process.pid}`;
  return `${harness}-${safe(native)}`.slice(0, 80);
}
