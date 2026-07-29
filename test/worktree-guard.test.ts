import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SameTreeError } from '../src/errors.js';
import { assertWorktreeBoundary } from '../src/worktree-guard.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];

function setup(): TestRepository {
  const repository = createTestRepository();
  repositories.push(repository);
  return repository;
}

function guarded(root: string, toolName: string, toolInput: Record<string, unknown>) {
  return () =>
    assertWorktreeBoundary(root, {
      hook_event_name: 'PreToolUse',
      cwd: root,
      tool_name: toolName,
      tool_input: toolInput,
    });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('worktree guard', () => {
  it('allows structured paths and ordinary Git commands inside the launch worktree', () => {
    const repository = setup();
    mkdirSync(path.join(repository.root, 'src'));

    expect(guarded(repository.root, 'Read', { file_path: 'src/example.ts' })).not.toThrow();
    expect(
      guarded(repository.root, 'Bash', {
        command: "git status --short && printf '%s\\n' 'git worktree add /tmp/example'",
        workdir: 'src',
      }),
    ).not.toThrow();
    expect(guarded(repository.root, 'Bash', { command: "printf '%s\\n' '$HOME'" })).not.toThrow();
  });

  it.each([
    ['absolute file path', (root: string) => ({ filePath: `${path.dirname(root)}/outside.ts` })],
    ['relative file path', () => ({ path: '../../outside.ts' })],
    ['external workdir', (root: string) => ({ workdir: path.dirname(root) })],
    [
      'patch target',
      () => ({ patchText: '*** Begin Patch\n*** Add File: ../outside.ts\n+unsafe\n*** End Patch' }),
    ],
  ])('blocks an external structured %s', (_name, input) => {
    const repository = setup();

    expect(guarded(repository.root, 'Read', input(repository.root))).toThrowError(
      expect.objectContaining<Partial<SameTreeError>>({ code: 'HOOK_REFUSED' }),
    );
  });

  it('blocks paths that escape through a symbolic link', () => {
    const repository = setup();
    const outside = setup();
    symlinkSync(outside.root, path.join(repository.root, 'outside-link'));

    expect(guarded(repository.root, 'Read', { path: 'outside-link/file.ts' })).toThrow(
      /resolves outside/u,
    );
    expect(guarded(repository.root, 'Bash', { command: 'touch outside-link/file.ts' })).toThrow(
      /resolves outside/u,
    );
  });

  it('blocks paths in a nested Git repository', () => {
    const repository = setup();
    const nested = path.join(repository.root, 'nested');
    mkdirSync(nested);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: nested, stdio: 'ignore' });

    expect(guarded(repository.root, 'Write', { file_path: 'nested/file.ts' })).toThrow(
      /different Git worktree/u,
    );
  });

  it.each([
    'cd src && npm test',
    'pushd src',
    'source ./script.sh',
    'env -C src npm test',
    'git -C src status',
    'git --work-tree=src status',
    'GIT_DIR=../other/.git git status',
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.escape GIT_CONFIG_VALUE_0='!touch /tmp/outside' git escape",
    'git -c core.worktree=../other status',
    'git worktree add ../feature feature',
    'git merge feature',
    'git rebase main',
    'git cherry-pick HEAD~1',
    'git switch feature',
    'gh pr merge 123',
    'bash -c "git checkout feature"',
    "bash -lc 'touch /tmp/outside'",
    "sh -ec 'touch /tmp/outside'",
    'touch /tmp/outside',
    'touch existing/../../outside',
    'dd if=/dev/null of=/tmp/outside',
    'curl -o/tmp/outside https://example.com',
    'curl -Lo/tmp/outside https://example.com',
    'gcc -o../outside source.c',
    'tar -xf archive.tar -C/tmp',
    'tar -xC/tmp -f archive.tar',
    'printf unsafe >/tmp/outside',
    'touch ~another/outside',
    'touch C:\\outside\\file.txt',
    'touch \\\\server\\share\\file.txt',
    'cat "$HOME/outside"',
    "eval 'touch /tmp/outside'",
    'find . -exec sh -c "touch /tmp/outside" ;',
  ])('blocks shell context change: %s', (command) => {
    const repository = setup();

    expect(guarded(repository.root, 'Bash', { command })).toThrowError(
      expect.objectContaining<Partial<SameTreeError>>({ code: 'HOOK_REFUSED' }),
    );
  });

  it('normalizes path-bearing keys from custom tools', () => {
    const repository = setup();

    expect(
      guarded(repository.root, 'custom', {
        request: { repository_path: path.join(path.dirname(repository.root), 'other') },
      }),
    ).toThrow(/outside the launch worktree/u);
  });

  it('fails closed for malformed guard payloads and ambiguous shell quoting', () => {
    const repository = setup();

    expect(() => assertWorktreeBoundary(repository.root, {})).toThrow(/empty/u);
    expect(guarded(repository.root, 'Bash', { command: "printf 'unterminated" })).toThrow(
      /ambiguous quoting/u,
    );
  });
});
