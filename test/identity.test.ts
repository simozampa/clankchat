import { describe, expect, it } from 'vitest';

import { agentIdentity, detectHarness } from '../src/activity.js';

describe('agent identity', () => {
  it('uses an explicit clankchat name', () => {
    expect(agentIdentity('opencode', { CLANKCHAT_AGENT: 'named-agent' })).toBe('named-agent');
  });

  it('derives Claude identity from its native session', () => {
    const environment = { CLAUDE_CODE_SESSION_ID: 'session/one' };
    expect(detectHarness(environment)).toBe('claude-code');
    expect(agentIdentity('claude-code', environment)).toBe('claude-code-session-one');
  });

  it('derives OpenCode identity from its process identity', () => {
    const environment = { OPENCODE_PID: '999999999' };
    expect(detectHarness(environment)).toBe('opencode');
    expect(agentIdentity('opencode', environment)).toBe('opencode-999999999');
  });
});
