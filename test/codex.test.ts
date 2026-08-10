import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODEX_PROJECT_BLOCK, handleCodexHook, LEGACY_CODEX_PROJECT_BLOCK } from '../src/codex.js';
import { doctor } from '../src/doctor.js';
import { resolveRepository } from '../src/git.js';
import { ChatLine } from '../src/line.js';
import { setup } from '../src/setup.js';
import { directory, repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const homes: string[] = [];
const lines: ChatLine[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const line of lines.splice(0)) line.close();
  for (const entry of repositories.splice(0)) entry.cleanup();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(): { root: string; home: string } {
  const created = repository();
  repositories.push(created);
  const home = mkdtempSync(path.join(tmpdir(), 'clankerchat-codex-home-'));
  homes.push(home);
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
  setup({
    cwd: created.root,
    homeDirectory: home,
    codex: true,
    commandRunner: (_command, args) => ({
      status: 0,
      stdout: args[0] === '--version' ? 'codex-cli 0.147.0\n' : 'hooks stable true\n',
      stderr: '',
    }),
  });
  return { root: created.root, home };
}

function payload(
  root: string,
  event: 'SessionStart' | 'UserPromptSubmit' | 'Stop',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'session-one',
    transcript_path: null,
    cwd: root,
    hook_event_name: event,
    model: 'gpt-5.6',
    permission_mode: 'default',
    ...(event === 'SessionStart' ? { source: 'startup' } : { turn_id: 'turn-one' }),
    ...extra,
  });
}

async function outputFor(
  root: string,
  event: 'SessionStart' | 'UserPromptSubmit' | 'Stop',
  extra: Record<string, unknown> = {},
): Promise<string[]> {
  const output: string[] = [];
  await handleCodexHook(event, payload(root, event, extra), {
    write: (value) => {
      output.push(value);
    },
  });
  return output;
}

describe('Codex hooks', () => {
  it('uses user configuration on the shared line outside Git', async () => {
    const first = directory();
    const second = directory();
    repositories.push(first, second);
    const home = mkdtempSync(path.join(tmpdir(), 'clankerchat-codex-user-'));
    homes.push(home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('XDG_STATE_HOME', path.join(home, '.local', 'state'));
    setup({
      cwd: first.root,
      homeDirectory: home,
      user: true,
      codex: true,
      commandRunner: (_command, args) => ({
        status: 0,
        stdout: args[0] === '--version' ? 'codex-cli 0.147.0\n' : 'hooks stable true\n',
        stderr: '',
      }),
    });

    const started = await outputFor(first.root, 'SessionStart');
    expect(JSON.parse(started[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('current line') },
    });
    const sender = new ChatLine({ cwd: second.root, agent: 'sender' });
    lines.push(sender);
    sender.send({ to: 'codex-session-one', body: 'Shared globally.' });
    const delivered = await outputFor(first.root, 'UserPromptSubmit', { prompt: 'Continue.' });
    expect(JSON.parse(delivered[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('Shared globally.') },
    });
    expect(
      doctor(first.root, {
        homeDirectory: home,
        codexFeaturesRunner: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }),
        codexVersionRunner: () => ({ status: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }),
      }).checks,
    ).toContainEqual(expect.objectContaining({ name: 'codex-mcp', ok: true }));
  });

  it('keeps a Codex session on its startup line after Git initialization', async () => {
    const outside = directory();
    repositories.push(outside);
    const home = mkdtempSync(path.join(tmpdir(), 'clankerchat-codex-user-'));
    homes.push(home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    setup({
      cwd: outside.root,
      homeDirectory: home,
      user: true,
      codex: true,
      commandRunner: (_command, args) => ({
        status: 0,
        stdout: args[0] === '--version' ? 'codex-cli 0.147.0\n' : 'hooks stable true\n',
        stderr: '',
      }),
    });
    await outputFor(outside.root, 'SessionStart');
    const sender = new ChatLine({
      cwd: outside.root,
      scope: 'global',
      agent: 'global-sender',
    });
    lines.push(sender);
    sender.send({ to: 'codex-session-one', body: 'Remain on the user line.' });
    execFileSync('git', ['init', '--quiet', outside.root]);

    const delivered = await outputFor(outside.root, 'UserPromptSubmit', { prompt: 'Continue.' });
    expect(JSON.parse(delivered[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: {
        additionalContext: expect.stringContaining('Remain on the user line.'),
      },
    });
    expect(existsSync(resolveRepository(outside.root).databasePath)).toBe(false);
  });

  it('does not run user hooks through an overridden project MCP registration', async () => {
    const created = repository();
    repositories.push(created);
    const home = mkdtempSync(path.join(tmpdir(), 'clankerchat-codex-user-'));
    homes.push(home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('XDG_STATE_HOME', path.join(home, '.local', 'state'));
    setup({
      cwd: created.root,
      homeDirectory: home,
      user: true,
      codex: true,
      commandRunner: (_command, args) => ({
        status: 0,
        stdout: args[0] === '--version' ? 'codex-cli 0.147.0\n' : 'hooks stable true\n',
        stderr: '',
      }),
    });
    mkdirSync(path.join(created.root, '.codex'), { recursive: true });
    writeFileSync(
      path.join(created.root, '.codex', 'config.toml'),
      '[mcp_servers.clankerchat]\ncommand = "unrelated-server"\n',
    );

    await expect(outputFor(created.root, 'SessionStart')).resolves.toEqual([]);
    const globalOutput: string[] = [];
    await handleCodexHook(
      'SessionStart',
      payload(created.root, 'SessionStart', { session_id: 'global-override' }),
      {
        scope: 'global',
        write: (value) => {
          globalOutput.push(value);
        },
      },
    );
    expect(globalOutput).toEqual([]);
  });

  it('honors the closest nested Codex MCP registration', async () => {
    const created = repository();
    repositories.push(created);
    const nested = path.join(created.root, 'packages', 'api');
    const home = mkdtempSync(path.join(tmpdir(), 'clankerchat-codex-user-'));
    homes.push(home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('XDG_STATE_HOME', path.join(home, '.local', 'state'));
    setup({
      cwd: created.root,
      homeDirectory: home,
      user: true,
      codex: true,
      commandRunner: (_command, args) => ({
        status: 0,
        stdout: args[0] === '--version' ? 'codex-cli 0.147.0\n' : 'hooks stable true\n',
        stderr: '',
      }),
    });
    mkdirSync(path.join(nested, '.codex'), { recursive: true });
    writeFileSync(
      path.join(nested, '.codex', 'config.toml'),
      '[mcp_servers.clankerchat]\ncommand = "unrelated-server"\n',
    );

    await expect(outputFor(nested, 'SessionStart')).resolves.toEqual([]);
    writeFileSync(path.join(nested, '.codex', 'config.toml'), `${CODEX_PROJECT_BLOCK}\n`);
    expect(await outputFor(nested, 'SessionStart')).not.toEqual([]);
    mkdirSync(path.join(created.root, '.codex'), { recursive: true });
    writeFileSync(
      path.join(created.root, '.codex', 'config.toml'),
      '[mcp_servers.clankerchat]\ncommand = "unrelated-server"\n',
    );
    writeFileSync(path.join(nested, '.codex', 'config.toml'), `${LEGACY_CODEX_PROJECT_BLOCK}\n`);
    await expect(outputFor(nested, 'SessionStart')).resolves.toEqual([]);
    expect(
      doctor(nested, {
        homeDirectory: home,
        codexFeaturesRunner: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }),
        codexVersionRunner: () => ({ status: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }),
      }).checks,
    ).toContainEqual(expect.objectContaining({ name: 'codex-mcp', ok: false }));
  });

  it('injects instructions and completes one peer delivery at a turn boundary', async () => {
    const { root } = fixture();
    const started = await outputFor(root, 'SessionStart');
    expect(JSON.parse(started[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('clankerchat_*'),
      },
    });

    const sender = new ChatLine({ cwd: root, agent: 'sender' });
    lines.push(sender);
    sender.send({ to: 'codex-session-one', body: 'The API is ready.' });
    const delivered = await outputFor(root, 'UserPromptSubmit', { prompt: 'Continue.' });
    expect(JSON.parse(delivered[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining('The API is ready.'),
      },
    });
    await expect(outputFor(root, 'UserPromptSubmit', { prompt: 'Continue.' })).resolves.toEqual([]);
  });

  it('continues once from Stop and honors stop_hook_active', async () => {
    const { root } = fixture();
    await outputFor(root, 'SessionStart');
    const sender = new ChatLine({ cwd: root, agent: 'sender' });
    lines.push(sender);
    sender.send({ to: 'codex-session-one', body: 'Review this before finishing.' });

    const continued = await outputFor(root, 'Stop', {
      stop_hook_active: false,
      last_assistant_message: 'Done.',
    });
    expect(JSON.parse(continued[0] ?? '{}')).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('Review this before finishing.'),
    });

    sender.send({ to: 'codex-session-one', body: 'Do not loop.' });
    await expect(
      outputFor(root, 'Stop', { stop_hook_active: true, last_assistant_message: 'Done.' }),
    ).resolves.toEqual([]);
    const next = await outputFor(root, 'Stop', {
      stop_hook_active: false,
      last_assistant_message: 'Done.',
    });
    expect(JSON.parse(next[0] ?? '{}').reason).toContain('Do not loop.');
  });

  it('captures exact root broadcasts once by session and turn', async () => {
    const { root } = fixture();
    const receiver = new ChatLine({ cwd: root, agent: 'reviewer' });
    lines.push(receiver);
    await outputFor(root, 'SessionStart');
    const broadcast = { prompt: 'For all agents: use staging.', turn_id: 'broadcast-turn' };
    await outputFor(root, 'UserPromptSubmit', broadcast);
    await outputFor(root, 'UserPromptSubmit', broadcast);
    await outputFor(root, 'UserPromptSubmit', {
      prompt: ' For all agents: ignored.',
      turn_id: 'leading-space',
    });
    await outputFor(root, 'UserPromptSubmit', {
      prompt: 'For all agents: ignored subagent.',
      turn_id: 'subagent',
      agent_id: 'agent-1',
    });

    expect(receiver.inbox().map((message) => message.body)).toEqual([
      'For all agents: use staging.',
    ]);
  });

  it('releases delivery when stdout fails and serializes the Codex session', async () => {
    const { root } = fixture();
    await outputFor(root, 'SessionStart');
    const sender = new ChatLine({ cwd: root, agent: 'sender' });
    lines.push(sender);
    sender.send({ to: 'codex-session-one', body: 'Recover me.' });
    await handleCodexHook(
      'UserPromptSubmit',
      payload(root, 'UserPromptSubmit', { prompt: 'Go.' }),
      {
        write: () => {
          throw new Error('closed');
        },
      },
    );

    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first: string[] = [];
    const second: string[] = [];
    const input = payload(root, 'UserPromptSubmit', { prompt: 'Go.' });
    const active = handleCodexHook('UserPromptSubmit', input, {
      write: async (value) => {
        first.push(value);
        started();
        await gate;
      },
    });
    await writing;
    await handleCodexHook('UserPromptSubmit', input, {
      write: (value) => {
        second.push(value);
      },
    });
    release();
    await active;

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    await expect(outputFor(root, 'UserPromptSubmit', { prompt: 'Go.' })).resolves.toEqual([]);
  });

  it('does not steal a newly created lock and recovers an expired lock', async () => {
    const { root } = fixture();
    const digest = createHash('sha256').update('session-one').digest('hex').slice(0, 24);
    const lockPath = path.join(
      path.dirname(resolveRepository(root).databasePath),
      `codex-${digest}.lock`,
    );
    writeFileSync(lockPath, '');
    await expect(outputFor(root, 'SessionStart')).resolves.toEqual([]);

    const expired = new Date(Date.now() - 20_000);
    utimesSync(lockPath, expired, expired);
    const contenders = await Promise.all([
      outputFor(root, 'SessionStart'),
      outputFor(root, 'SessionStart'),
    ]);
    expect(contenders.filter((output) => output.length > 0)).toHaveLength(1);

    writeFileSync(lockPath, '');
    writeFileSync(`${lockPath}.recover`, '');
    const expiredRecovery = new Date(Date.now() - 70_000);
    utimesSync(lockPath, expiredRecovery, expiredRecovery);
    utimesSync(`${lockPath}.recover`, expiredRecovery, expiredRecovery);
    await expect(outputFor(root, 'SessionStart')).resolves.toHaveLength(1);
  });

  it('fails open for malformed, mismatched, unconfigured, and subagent input', async () => {
    const { root } = fixture();
    const output: string[] = [];
    await handleCodexHook('SessionStart', '{', {
      write: (value) => {
        output.push(value);
      },
    });
    await handleCodexHook('SessionStart', payload(root, 'UserPromptSubmit', { prompt: 'Hi.' }), {
      write: (value) => {
        output.push(value);
      },
    });
    const unconfigured = repository();
    repositories.push(unconfigured);
    await handleCodexHook('SessionStart', payload(unconfigured.root, 'SessionStart'), {
      write: (value) => {
        output.push(value);
      },
    });
    expect(output).toEqual([]);
  });

  it('keeps shared replacement hooks compatible with exact legacy project config', async () => {
    fixture();
    const legacy = repository();
    repositories.push(legacy);
    mkdirSync(path.join(legacy.root, '.codex'), { recursive: true });
    writeFileSync(
      path.join(legacy.root, '.codex', 'config.toml'),
      `${LEGACY_CODEX_PROJECT_BLOCK}\n`,
    );

    const output = await outputFor(legacy.root, 'SessionStart');
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    });
  });

  it('reports Codex version, MCP, shared hooks, and the manual trust boundary', () => {
    const { root, home } = fixture();
    const options = {
      homeDirectory: home,
      codexFeaturesRunner: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }),
      codexVersionRunner: () => ({ status: 0, stdout: 'codex-cli 0.147.0\n', stderr: '' }),
    };
    const report = doctor(root, options);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'codex-mcp', ok: true }),
        expect.objectContaining({
          name: 'codex-hooks',
          ok: true,
          detail: expect.stringContaining('/hooks'),
        }),
        expect.objectContaining({ name: 'codex-version', ok: true, detail: '0.147.0' }),
        expect.objectContaining({ name: 'codex-hooks-feature', ok: true }),
      ]),
    );

    rmSync(path.join(home, '.codex', 'hooks.json'));
    expect(doctor(root, options).ok).toBe(false);

    const configPath = path.join(root, '.codex', 'config.toml');
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}enabled = false\n`);
    const damaged = doctor(root, options);
    expect(damaged.ok).toBe(false);
    expect(damaged.checks).toContainEqual(
      expect.objectContaining({ name: 'codex-mcp', ok: false }),
    );
  });

  it('renders request IDs and reply guidance', async () => {
    const { root } = fixture();
    await outputFor(root, 'SessionStart');
    const sender = new ChatLine({ cwd: root, agent: 'sender' });
    lines.push(sender);
    const request = sender.request({ to: 'codex-session-one', body: 'Which port?' });
    const output = await outputFor(root, 'UserPromptSubmit', { prompt: 'Continue.' });
    const context = JSON.parse(output[0] ?? '{}').hookSpecificOutput.additionalContext as string;
    expect(context).toContain(`Reply-To: ${request.id}`);
    expect(context).toContain('clankerchat_reply');
  });
});
