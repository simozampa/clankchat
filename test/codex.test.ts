import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleCodexHook } from '../src/codex.js';
import { doctor } from '../src/doctor.js';
import { resolveRepository } from '../src/git.js';
import { ChatLine } from '../src/line.js';
import { setup } from '../src/setup.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const homes: string[] = [];
const lines: ChatLine[] = [];

afterEach(() => {
  for (const line of lines.splice(0)) line.close();
  for (const entry of repositories.splice(0)) entry.cleanup();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(): { root: string; home: string } {
  const created = repository();
  repositories.push(created);
  const home = mkdtempSync(path.join(tmpdir(), 'clankchat-codex-home-'));
  homes.push(home);
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
  it('injects instructions and completes one peer delivery at a turn boundary', async () => {
    const { root } = fixture();
    const started = await outputFor(root, 'SessionStart');
    expect(JSON.parse(started[0] ?? '{}')).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('clankchat_*'),
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
      resolveRepository(root).commonGitDirectory,
      'clankchat',
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
    expect(context).toContain('clankchat_reply');
  });
});
