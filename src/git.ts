import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClankerChatError } from './errors.js';

export interface RepositoryContext {
  root: string;
  commonGitDirectory: string;
  privateGitDirectory: string;
  linkedWorktree: boolean;
  databasePath: string;
}

export type LineScope = 'auto' | 'repository' | 'global';

export interface RepositoryLineContext extends RepositoryContext {
  scope: 'repository';
  stateDirectory: string;
}

export interface GlobalLineContext {
  scope: 'global';
  stateDirectory: string;
  databasePath: string;
}

export type LineContext = RepositoryLineContext | GlobalLineContext;

export interface ResolveLineOptions {
  cwd?: string;
  scope?: LineScope;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export function parseLineScope(value: unknown): LineScope {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'repository' || value === 'global') return value;
  throw new ClankerChatError('INVALID_INPUT', 'Line scope must be auto, repository, or global.', {
    scope: value,
  });
}

function gitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')),
  );
}

function git(cwd: string, args: string[], environment = process.env): string {
  try {
    return execFileSync('git', args, {
      cwd,
      env: { ...gitEnvironment(environment), LANG: 'C', LC_ALL: 'C' },
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

function hasGitMarker(cwd: string): boolean {
  let current = cwd;
  for (;;) {
    try {
      lstatSync(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
    }
    try {
      lstatSync(path.join(current, 'HEAD'));
      lstatSync(path.join(current, 'objects'));
      lstatSync(path.join(current, 'refs'));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isGitWorkingTree(cwd: string, environment: NodeJS.ProcessEnv): boolean {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    env: { ...gitEnvironment(environment), LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if (Reflect.get(result.error, 'code') === 'ENOENT' && !hasGitMarker(cwd)) return false;
    throw new ClankerChatError('NOT_GIT_REPOSITORY', 'Could not inspect the Git working tree.', {
      cwd,
      cause: result.error.message,
    });
  }
  if (result.status === 0) {
    if (result.stdout.trim() === 'true') return true;
    throw new ClankerChatError(
      'NOT_GIT_REPOSITORY',
      'Bare repositories do not have an agent chat line.',
      { cwd },
    );
  }
  if (result.status === 128 && /not a git repository/iu.test(result.stderr)) {
    if (hasGitMarker(cwd)) {
      throw new ClankerChatError(
        'NOT_GIT_REPOSITORY',
        'Git metadata exists but could not be resolved safely.',
        { cwd, stderr: result.stderr.trim() },
      );
    }
    return false;
  }
  throw new ClankerChatError('NOT_GIT_REPOSITORY', 'Could not inspect the Git working tree.', {
    cwd,
    status: result.status,
    stderr: result.stderr.trim(),
  });
}

function canonicalFuturePath(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function globalStateDirectory(options: ResolveLineOptions = {}): string {
  const environment = options.environment ?? process.env;
  const configured = environment.XDG_STATE_HOME?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new ClankerChatError('INVALID_INPUT', 'XDG_STATE_HOME must be an absolute path.', {
      path: configured,
    });
  }
  const home = options.homeDirectory ?? os.homedir();
  const base = configured
    ? configured
    : (options.platform ?? process.platform) === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.local', 'state');
  return path.join(canonicalFuturePath(base), 'clankerchat');
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

export function resolveRepository(
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): RepositoryContext {
  if (git(cwd, ['rev-parse', '--is-bare-repository'], environment) === 'true') {
    throw new ClankerChatError(
      'NOT_GIT_REPOSITORY',
      'Bare repositories do not have an agent chat line.',
    );
  }

  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel'], environment));
  const commonGitDirectory = realpathSync(
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], environment),
  );
  const privateGitDirectory = realpathSync(
    git(root, ['rev-parse', '--absolute-git-dir'], environment),
  );
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

export function resolveLineContext(options: ResolveLineOptions = {}): LineContext {
  const scope = parseLineScope(options.scope);
  if (scope !== 'global') {
    let cwd: string;
    try {
      cwd = realpathSync(options.cwd ?? process.cwd());
    } catch (error) {
      throw new ClankerChatError('INVALID_INPUT', 'The context path could not be resolved.', {
        cwd: options.cwd ?? process.cwd(),
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (isGitWorkingTree(cwd, options.environment ?? process.env)) {
      const repository = resolveRepository(cwd, options.environment ?? process.env);
      return {
        ...repository,
        scope: 'repository',
        stateDirectory: path.dirname(repository.databasePath),
      };
    }
    if (scope === 'repository') {
      throw new ClankerChatError(
        'NOT_GIT_REPOSITORY',
        'clankerchat repository scope requires a Git working tree.',
        { cwd },
      );
    }
  }
  const stateDirectory = globalStateDirectory(options);
  return {
    scope: 'global',
    stateDirectory,
    databasePath: path.join(stateDirectory, 'state.sqlite3'),
  };
}
