import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('runs the Claude inbox monitor only in an initialized SameTree project', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'sametree-claude-monitor-'));
    try {
      const initialized = spawnSync('git', ['init', '--quiet', project]);
      expect(initialized.status).toBe(0);

      const result = spawnSync('sh', [path.resolve('plugins/sametree/bin/inbox-monitor.sh')], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: 'test-session',
          CLAUDE_PROJECT_DIR: project,
          SAMETREE_BIN: path.join(project, 'missing-sametree'),
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');

      mkdirSync(path.join(project, '.sametree'));
      writeFileSync(path.join(project, '.sametree', 'config.json'), '{}\n');
      const executable = path.join(project, 'sametree');
      writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
      chmodSync(executable, 0o755);

      const followed = spawnSync('sh', [path.resolve('plugins/sametree/bin/inbox-monitor.sh')], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: 'test-session',
          CLAUDE_PROJECT_DIR: project,
          SAMETREE_BIN: executable,
        },
      });

      expect(followed.status).toBe(0);
      expect(followed.stderr).toBe('');
      expect(followed.stdout.replace(/\n$/u, '').split('\n')).toEqual([
        '--cwd',
        project,
        '--agent',
        'claude-code-test-session',
        '--harness',
        'claude-code',
        'message',
        'follow',
        '--json',
        '--prefix',
        'SameTree message: ',
      ]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
