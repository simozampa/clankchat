import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { ClankChatError } from './errors.js';

export interface RepositoryContext {
  root: string;
  commonGitDirectory: string;
  privateGitDirectory: string;
  linkedWorktree: boolean;
  databasePath: string;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new ClankChatError(
      'NOT_GIT_REPOSITORY',
      'clankchat must run inside a Git working tree.',
      { cwd, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

export function resolveRepository(cwd = process.cwd()): RepositoryContext {
  if (git(cwd, ['rev-parse', '--is-bare-repository']) === 'true') {
    throw new ClankChatError(
      'NOT_GIT_REPOSITORY',
      'Bare repositories do not have an agent chat line.',
    );
  }

  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const commonGitDirectory = realpathSync(
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const privateGitDirectory = realpathSync(git(root, ['rev-parse', '--absolute-git-dir']));
  return {
    root,
    commonGitDirectory,
    privateGitDirectory,
    linkedWorktree: privateGitDirectory !== commonGitDirectory,
    databasePath: path.join(commonGitDirectory, 'clankchat', 'state.sqlite3'),
  };
}
