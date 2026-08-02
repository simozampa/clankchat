import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function json(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve(relativePath), 'utf8')) as Record<string, unknown>;
}

describe('package metadata', () => {
  it('keeps the Claude plugin version aligned without duplicate hook registration', () => {
    const packageMetadata = json('package.json');
    const plugin = json('plugins/sametree/.claude-plugin/plugin.json');
    const hooks = json('plugins/sametree/hooks/hooks.json');

    expect(plugin.version).toBe(packageMetadata.version);
    expect(plugin).not.toHaveProperty('hooks');
    expect(hooks).toHaveProperty('hooks');
    expect(JSON.stringify(hooks)).not.toContain('guard-worktree');
    expect((hooks.hooks as { PreToolUse: Array<{ matcher?: string }> }).PreToolUse).toEqual([
      expect.objectContaining({ matcher: 'ExitPlanMode' }),
    ]);
    expect(existsSync(path.resolve('plugins/sametree/hooks/guard-worktree.mjs'))).toBe(false);
  });
});
