import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Chat awareness must never prevent Claude from accepting a user prompt.
const command = 'clankerchat';
const scope = process.env.CLANKERCHAT_SCOPE || process.env.CLANKCHAT_SCOPE || 'auto';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const env = {
  ...process.env,
  CLANKERCHAT_CWD: cwd,
};
for (const name of Object.keys(env)) {
  if (name.startsWith('GIT_')) delete env[name];
}

function harnessBinding() {
  const native = process.env.CLAUDE_CODE_SESSION_ID;
  if (!native || !/^[A-Za-z0-9._-]{1,120}$/u.test(native)) {
    return scope === 'auto' ? null : { scope, databasePath: null };
  }
  const base = process.env.XDG_STATE_HOME?.trim()
    ? process.env.XDG_STATE_HOME
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'state');
  const target = path.join(
    base,
    'clankerchat',
    'harness-bindings',
    `claude-code-${native}.binding`,
  );
  if (!existsSync(target)) return scope === 'auto' ? null : { scope, databasePath: null };
  const state = lstatSync(target);
  const userId = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1 ||
    (userId !== null && state.uid !== userId) ||
    (state.mode & 0o777) !== 0o600
  ) {
    return null;
  }
  const lines = readFileSync(target, 'utf8').split('\n');
  const fields = lines[0]?.split('\t') ?? [];
  const owner = Number(fields[2]);
  const expires = Number(fields[3]);
  if (
    lines.length !== 3 ||
    fields.length !== 5 ||
    fields[0] !== '1' ||
    (fields[1] !== 'repository' && fields[1] !== 'global') ||
    !Number.isSafeInteger(owner) ||
    owner <= 0 ||
    !Number.isSafeInteger(expires) ||
    expires <= Date.now() ||
    !lines[1]
  ) {
    return null;
  }
  process.kill(owner, 0);
  if (scope !== 'auto' && scope !== fields[1]) return null;
  return { scope: fields[1], databasePath: lines[1], bindingFile: target, token: fields[4] };
}

try {
  if (!['auto', 'repository', 'global'].includes(scope)) process.exit(0);
  const instructions = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  const userSetup =
    existsSync(instructions) &&
    readFileSync(instructions, 'utf8').includes('<!-- clankerchat:user:start -->');
  const binding = harnessBinding();
  if (!binding) process.exit(0);
  const childScope = binding.scope;
  if (!userSetup && childScope !== 'global') {
    const common = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (
      !existsSync(path.join(common, 'clankerchat', 'state.sqlite3')) &&
      !existsSync(path.join(common, 'clankchat', 'state.sqlite3'))
    )
      process.exit(0);
  }
  if (binding.databasePath) {
    env.CLANKERCHAT_EXPECTED_DATABASE_PATH_BASE64 = binding.databasePath;
    env.CLANKERCHAT_BINDING_FILE = binding.bindingFile;
    env.CLANKERCHAT_BINDING_TOKEN = binding.token;
  }
  const args = ['--scope', childScope, '--harness', 'claude-code', 'message', 'capture'];
  const child = spawn(command, args, {
    env,
    shell: process.platform === 'win32',
    stdio: ['inherit', 'ignore', 'ignore'],
    windowsHide: true,
  });
  const timeout = setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 2_000);
  const finish = () => {
    clearTimeout(timeout);
    process.exitCode = 0;
  };
  child.once('error', finish);
  child.once('close', finish);
} catch {
  process.exitCode = 0;
}
