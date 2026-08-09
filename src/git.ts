import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { ClankerChatError } from './errors.js';

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
    throw new ClankerChatError(
      'NOT_GIT_REPOSITORY',
      'clankerchat must run inside a Git working tree.',
      { cwd, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function stateFileExists(target: string): boolean {
  try {
    const state = lstatSync(target);
    if (state.isSymbolicLink()) {
      throw new ClankerChatError('DATABASE_ERROR', 'Refusing to use a symlinked database.', {
        path: target,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof ClankerChatError) throw error;
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return false;
    throw error;
  }
}

export function resolveRepository(cwd = process.cwd()): RepositoryContext {
  if (git(cwd, ['rev-parse', '--is-bare-repository']) === 'true') {
    throw new ClankerChatError(
      'NOT_GIT_REPOSITORY',
      'Bare repositories do not have an agent chat line.',
    );
  }

  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const commonGitDirectory = realpathSync(
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const privateGitDirectory = realpathSync(git(root, ['rev-parse', '--absolute-git-dir']));
  const databasePath = path.join(commonGitDirectory, 'clankerchat', 'state.sqlite3');
  const legacyDatabasePath = path.join(commonGitDirectory, 'clankchat', 'state.sqlite3');
  const currentStateExists = stateFileExists(databasePath);
  const legacyStateExists = stateFileExists(legacyDatabasePath);
  if (currentStateExists) {
    throw new ClankerChatError(
      'DATABASE_ERROR',
      legacyStateExists
        ? 'Both clankerchat and legacy clankchat state exist; refusing to choose between them.'
        : 'The unreleased clankerchat state layout is unsupported; move it to the legacy compatibility path before continuing.',
      { databasePath, legacyDatabasePath },
    );
  }
  return {
    root,
    commonGitDirectory,
    privateGitDirectory,
    linkedWorktree: privateGitDirectory !== commonGitDirectory,
    // Keep one path while old clankchat processes may still run in the same repository.
    databasePath: legacyDatabasePath,
  };
}
