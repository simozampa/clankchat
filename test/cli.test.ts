import { spawn, spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const entry of repositories.splice(0)) entry.cleanup();
});

function run(root: string, agent: string, args: string[]) {
  return spawnSync(process.execPath, ['dist/cli.js', '--cwd', root, '--agent', agent, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('CLI', () => {
  it('reports the new package version', () => {
    const result = spawnSync(process.execPath, ['dist/cli.js', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.1');
  });

  it('discovers agents and exchanges messages', () => {
    const created = repository();
    repositories.push(created);
    expect(run(created.root, 'alice', ['status']).status).toBe(0);
    expect(run(created.root, 'bob', ['status']).status).toBe(0);
    const sent = run(created.root, 'alice', [
      'message',
      'send',
      '--to',
      'bob',
      '--body',
      'Hello Bob',
    ]);
    expect(sent.status).toBe(0);
    const inbox = run(created.root, 'bob', ['message', 'inbox']);
    expect(JSON.parse(inbox.stdout)).toEqual([
      expect.objectContaining({ sender: 'alice', body: 'Hello Bob' }),
    ]);
    expect(JSON.parse(run(created.root, 'alice', ['agents', '--all']).stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'bob' })]),
    );
  });

  it('keeps short-lived commands out of the presence stream', () => {
    const created = repository();
    repositories.push(created);
    run(created.root, 'alice', ['status']);
    run(created.root, 'alice', ['message', 'inbox']);
    const beforeFollow = run(created.root, 'human', ['watch', '--once']).stdout;
    expect(beforeFollow).toContain('alice joined the line');
    expect(beforeFollow).not.toContain('alice came online');

    run(created.root, 'alice', ['message', 'follow', '--once', '--json']);
    const afterFollow = run(created.root, 'human', ['watch', '--once']).stdout;
    expect(afterFollow.match(/alice came online/gu)).toHaveLength(1);
  });

  it('waits for a reply in the same command', async () => {
    const created = repository();
    repositories.push(created);
    run(created.root, 'alice', ['status']);
    run(created.root, 'bob', ['status']);
    const child = spawn(
      process.execPath,
      [
        'dist/cli.js',
        '--cwd',
        created.root,
        '--agent',
        'alice',
        'message',
        'send',
        '--to',
        'bob',
        '--body',
        'Which port?',
        '--await-reply',
        '--timeout-ms',
        '2000',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    let requestId = '';
    for (let attempt = 0; attempt < 20 && !requestId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const inbox = JSON.parse(run(created.root, 'bob', ['message', 'inbox']).stdout) as Array<{
        id: string;
        kind: string;
      }>;
      requestId = inbox.find((message) => message.kind === 'request')?.id ?? '';
    }
    expect(requestId).not.toBe('');
    expect(run(created.root, 'alice', ['message', 'follow', '--once', '--json']).status).toBe(0);
    expect(run(created.root, 'bob', ['message', 'reply', requestId, '--body', '8080']).status).toBe(
      0,
    );
    const exit = await exitPromise;
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ reply: { body: '8080', replyTo: requestId } });
    const watched = run(created.root, 'human', ['watch', '--once']).stdout;
    expect(watched.match(/alice came online/gu)).toHaveLength(1);
  });

  it('releases an awaited reply when interrupted', async () => {
    const created = repository();
    repositories.push(created);
    run(created.root, 'alice', ['status']);
    run(created.root, 'bob', ['status']);
    const child = spawn(
      process.execPath,
      [
        'dist/cli.js',
        '--cwd',
        created.root,
        '--agent',
        'alice',
        'message',
        'send',
        '--to',
        'bob',
        '--body',
        'Interrupted?',
        '--await-reply',
        '--timeout-ms',
        '5000',
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exitPromise = new Promise<number | null>((resolve) => child.once('exit', resolve));
    let requestId = '';
    for (let attempt = 0; attempt < 40 && !requestId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const inbox = JSON.parse(run(created.root, 'bob', ['message', 'inbox']).stdout) as Array<{
        id: string;
        kind: string;
      }>;
      requestId = inbox.find((message) => message.kind === 'request')?.id ?? '';
    }
    expect(requestId).not.toBe('');
    child.kill('SIGINT');
    await expect(exitPromise).resolves.toBe(130);
    run(created.root, 'bob', ['message', 'reply', requestId, '--body', 'Still durable.']);
    const followed = run(created.root, 'alice', ['message', 'follow', '--once', '--json']);
    expect(followed.status).toBe(0);
    expect(JSON.parse(followed.stdout)).toMatchObject({
      body: 'Still durable.',
      replyTo: requestId,
    });
  });
});
