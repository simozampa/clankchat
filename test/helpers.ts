import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestRepository {
  root: string;
  cleanup: () => void;
}

export function repository(prefix = 'clankchat-test-'): TestRepository {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'initial',
  ]);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function linkedWorktree(root: string): string {
  const parent = path.dirname(root);
  const linked = path.join(parent, `${path.basename(root)}-linked`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '--quiet', '--detach', linked]);
  return linked;
}
