import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { harnessActivityId } from '../src/activity.js';

describe('harness activity identity', () => {
  it('keeps stable native session IDs for Claude Code', () => {
    expect(harnessActivityId('claude-code', 'session-1')).toBe('session-1');
  });

  it('qualifies OpenCode process IDs with process-start identity when available', () => {
    const processId = String(process.pid);
    const activityId = harnessActivityId('opencode', processId);

    if (existsSync(`/proc/${processId}/stat`) && existsSync('/proc/sys/kernel/random/boot_id')) {
      expect(activityId).toMatch(new RegExp(`^${processId}:`));
    } else {
      expect(activityId).toBeUndefined();
    }
  });
});
