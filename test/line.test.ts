import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRepository } from '../src/git.js';
import { ChatLine } from '../src/line.js';
import { linkedWorktree, repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const entry of repositories.splice(0)) entry.cleanup();
});

function repo(): TestRepository {
  const created = repository();
  repositories.push(created);
  return created;
}

describe('repository chat line', () => {
  it('refuses to claim a nonempty SQLite database', () => {
    const { root } = repo();
    const databasePath = resolveRepository(root).databasePath;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const unrelated = new DatabaseSync(databasePath);
    unrelated.exec('CREATE TABLE personal_data(value TEXT)');
    expect(unrelated.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    unrelated.close();

    expect(() => new ChatLine({ cwd: root, agent: 'alice' })).toThrow(/nonempty SQLite/u);
    const verifier = new DatabaseSync(databasePath);
    expect(
      verifier.prepare("SELECT name FROM sqlite_schema WHERE name = 'personal_data'").get(),
    ).toEqual({ name: 'personal_data' });
    expect(verifier.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    verifier.close();
  });

  it('rejects a versioned lookalike legacy database', () => {
    const { root } = repo();
    const databasePath = resolveRepository(root).databasePath;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const lookalike = new DatabaseSync(databasePath);
    for (const table of [
      'agents',
      'events',
      'message_recipients',
      'messages',
      'presence_sessions',
      'reply_waiters',
      'sessions',
    ]) {
      lookalike.exec(`CREATE TABLE ${table}(unowned TEXT)`);
    }
    lookalike.exec('PRAGMA user_version = 1');
    lookalike.close();

    expect(() => new ChatLine({ cwd: root, agent: 'alice' })).toThrow(
      /not a clankerchat database/u,
    );
    const verifier = new DatabaseSync(databasePath);
    expect(verifier.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 });
    verifier.close();
  });

  it('sends durable direct messages and idempotently acknowledges them', () => {
    const { root } = repo();
    const alice = new ChatLine({ cwd: root, agent: 'alice', harness: 'claude-code' });
    const bob = new ChatLine({ cwd: root, agent: 'bob', harness: 'opencode' });
    const sent = alice.send({ to: 'bob', body: 'The API is ready.' });

    expect(bob.inbox({ unreadOnly: true })).toEqual([
      expect.objectContaining({ id: sent.id, sender: 'alice', body: 'The API is ready.' }),
    ]);
    expect(bob.acknowledge([sent.id])).toBe(1);
    expect(bob.acknowledge([sent.id])).toBe(0);
    expect(bob.inbox({ unreadOnly: true })).toEqual([]);
    alice.close();
    bob.close();
  });

  it('broadcasts only to agents already on the line', () => {
    const { root } = repo();
    const alice = new ChatLine({ cwd: root, agent: 'alice' });
    const bob = new ChatLine({ cwd: root, agent: 'bob' });
    alice.send({ body: 'Current agents only.' });
    const carol = new ChatLine({ cwd: root, agent: 'carol' });

    expect(bob.inbox()).toHaveLength(1);
    expect(carol.inbox()).toEqual([]);
    alice.close();
    bob.close();
    carol.close();
  });

  it('delivers pinned broadcasts to current and future sessions exactly once per session', () => {
    const { root } = repo();
    const alice = new ChatLine({ cwd: root, agent: 'alice' });
    const bob = new ChatLine({ cwd: root, agent: 'bob' });
    const pinned = alice.send({ body: 'For all agents: use port 8080.', pinned: true });
    expect(bob.inbox().map((item) => item.id)).toEqual([pinned.id]);
    bob.acknowledge([pinned.id]);
    bob.close();

    const restarted = new ChatLine({ cwd: root, agent: 'bob' });
    expect(restarted.inbox().map((item) => item.id)).toEqual([pinned.id]);
    expect(restarted.inbox().map((item) => item.id)).toEqual([pinned.id]);
    alice.close();
    restarted.close();
  });

  it('delivers a pinned broadcast independently to simultaneous sessions', () => {
    const { root } = repo();
    const alice = new ChatLine({ cwd: root, agent: 'alice' });
    const first = new ChatLine({ cwd: root, agent: 'bob' });
    const second = new ChatLine({ cwd: root, agent: 'bob' });
    const pinned = alice.send({ body: 'For every active session.', pinned: true });
    const firstDelivery = first.reserveNextDelivery();
    const secondDelivery = second.reserveNextDelivery();
    expect(firstDelivery?.id).toBe(pinned.id);
    expect(secondDelivery?.id).toBe(pinned.id);
    expect(firstDelivery?.deliveryScope).not.toBe(secondDelivery?.deliveryScope);
    first.completeDelivery(pinned.id);
    second.completeDelivery(pinned.id);
    expect(first.reserveNextDelivery()).toBeNull();
    expect(second.reserveNextDelivery()).toBeNull();
    alice.close();
    first.close();
    second.close();
  });

  it('delivers a pin to another active session with the sender name', () => {
    const { root } = repo();
    const sender = new ChatLine({ cwd: root, agent: 'alice' });
    const peerSession = new ChatLine({ cwd: root, agent: 'alice' });
    const pinned = sender.send({ body: 'Shared session context.', pinned: true });
    expect(sender.inbox()).toEqual([]);
    expect(peerSession.inbox().map((message) => message.id)).toEqual([pinned.id]);
    sender.close();
    peerSession.close();
  });

  it('resumes one harness session without replaying its delivered pins', () => {
    const { root } = repo();
    let now = 1_000;
    const sender = new ChatLine({ cwd: root, agent: 'alice', now: () => now });
    const first = new ChatLine({
      cwd: root,
      agent: 'bob',
      sessionId: 'stable-session',
      sessionTtlSeconds: 1,
      now: () => now,
    });
    const pinned = sender.send({ body: 'Once per harness session.', pinned: true });
    expect(first.reserveNextDelivery()?.id).toBe(pinned.id);
    first.completeDelivery(pinned.id);
    now += 2_000;
    expect(first.heartbeat().id).toBe('stable-session');
    expect(first.reserveNextDelivery()).toBeNull();
    first.close();

    const resumed = new ChatLine({
      cwd: root,
      agent: 'bob',
      sessionId: 'stable-session',
      now: () => now,
    });
    expect(resumed.reserveNextDelivery()).toBeNull();
    const future = new ChatLine({ cwd: root, agent: 'bob', now: () => now });
    expect(future.reserveNextDelivery()?.id).toBe(pinned.id);
    sender.close();
    resumed.close();
    future.close();
  });

  it('shares one database across linked worktrees', () => {
    const { root } = repo();
    const linked = linkedWorktree(root);
    const alice = new ChatLine({ cwd: root, agent: 'alice' });
    const bob = new ChatLine({ cwd: linked, agent: 'bob' });
    alice.send({ to: 'bob', body: 'Same repository, same line.' });

    expect(alice.repository.databasePath).toBe(bob.repository.databasePath);
    expect(bob.inbox()[0]?.body).toBe('Same repository, same line.');
    alice.close();
    bob.close();
  });

  it('keeps unrelated repositories isolated', () => {
    const first = repo();
    const second = repo();
    const alice = new ChatLine({ cwd: first.root, agent: 'alice' });
    const other = new ChatLine({ cwd: second.root, agent: 'other' });
    expect(alice.repository.databasePath).not.toBe(other.repository.databasePath);
    expect(() => alice.send({ to: 'other', body: 'No route.' })).toThrow(
      /has not joined this repository line yet; run status, agents, heartbeat, or a message command/u,
    );
    alice.close();
    other.close();
  });

  it('reports online agents and recovers after sleep', () => {
    const { root } = repo();
    let now = 1_000;
    const alice = new ChatLine({
      cwd: root,
      agent: 'alice',
      harness: 'claude-code',
      sessionTtlSeconds: 1,
      now: () => now,
    });
    const original = alice.sessionId;
    now += 2_000;
    expect(alice.heartbeat().id).not.toBe(original);
    expect(alice.agents()).toEqual([
      expect.objectContaining({ name: 'alice', harness: 'claude-code', online: true }),
    ]);
    alice.close();
  });

  it('leaves the database healthy after competing writers', async () => {
    const { root } = repo();
    const lineModule = pathToFileURL(path.resolve('dist/line.js')).href;
    const run = (index: number) =>
      new Promise<number | null>((resolve) => {
        const source = `
          import { ChatLine } from ${JSON.stringify(lineModule)};
          const line = new ChatLine({ cwd: ${JSON.stringify(root)}, agent: "agent-${index}" });
          line.send({ body: "broadcast-${index}" });
          line.close();
        `;
        const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
          stdio: 'ignore',
        });
        child.once('exit', resolve);
      });
    expect(await Promise.all(Array.from({ length: 8 }, (_, index) => run(index)))).toEqual(
      Array.from({ length: 8 }, () => 0),
    );
    const verifier = new ChatLine({ cwd: root, agent: 'verifier' });
    expect(verifier.database.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
    expect(verifier.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      (
        verifier.database.prepare('SELECT COUNT(*) AS count FROM messages').get() as {
          count: number;
        }
      ).count,
    ).toBe(8);
    verifier.close();
  });
});
