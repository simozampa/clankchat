import { afterEach, describe, expect, it } from 'vitest';

import { ChatLine, ChatObserver } from '../src/line.js';
import { formatEvent, formatMessage, watchEvents } from '../src/watch.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const entry of repositories.splice(0)) entry.cleanup();
});

describe('human watch stream', () => {
  it('shows the conversation in the human-readable stream', async () => {
    const created = repository();
    repositories.push(created);
    const alice = new ChatLine({ cwd: created.root, agent: 'alice' });
    const bob = new ChatLine({ cwd: created.root, agent: 'bob' });
    alice.send({ to: 'bob', body: 'Can you review this?' });
    const lines: string[] = [];
    await watchEvents(bob, {
      once: true,
      write: (value) => {
        lines.push(value);
      },
    });
    expect(lines.join('\n')).toContain('alice -> bob: Can you review this?');
    alice.close();
    bob.close();
  });

  it('observes events without joining the agent line', async () => {
    const created = repository();
    repositories.push(created);
    const alice = new ChatLine({ cwd: created.root, agent: 'alice' });
    const observer = new ChatObserver(created.root);
    await watchEvents(observer, { once: true, write: () => undefined });
    expect(alice.agents({ includeOffline: true }).map((agent) => agent.name)).toEqual(['alice']);
    observer.close();
    alice.close();
  });

  it('announces only offline-to-online presence sessions', () => {
    const created = repository();
    repositories.push(created);
    const first = new ChatLine({
      cwd: created.root,
      agent: 'alice',
    });
    const overlapping = new ChatLine({
      cwd: created.root,
      agent: 'alice',
    });
    expect(overlapping.events().filter((event) => event.kind === 'session.started')).toHaveLength(
      1,
    );
    first.close();
    overlapping.close();
    const returned = new ChatLine({
      cwd: created.root,
      agent: 'alice',
    });
    expect(returned.events().filter((event) => event.kind === 'session.started')).toHaveLength(2);
    returned.close();
  });

  it('does not announce short-lived agent commands', () => {
    const created = repository();
    repositories.push(created);
    const first = new ChatLine({ cwd: created.root, agent: 'alice', announcePresence: false });
    first.close();
    const second = new ChatLine({ cwd: created.root, agent: 'alice', announcePresence: false });
    expect(second.events().filter((event) => event.kind === 'session.started')).toEqual([]);
    second.close();
  });

  it('does not let an overlapping silent session suppress presence', () => {
    const created = repository();
    repositories.push(created);
    const waitingCommand = new ChatLine({
      cwd: created.root,
      agent: 'alice',
      announcePresence: false,
    });
    const follower = new ChatLine({ cwd: created.root, agent: 'alice' });
    expect(follower.events().filter((event) => event.kind === 'session.started')).toHaveLength(1);
    waitingCommand.close();
    follower.close();
  });

  it('formats requests, replies, and pinned broadcasts', () => {
    const base = {
      sequence: 1,
      actor: 'alice',
      messageId: 'message-1',
      createdAt: 0,
    };
    expect(
      formatEvent({
        ...base,
        kind: 'message.requested',
        payload: { recipient: 'bob', body: 'Q?' },
      }),
    ).toContain('asked: Q?');
    expect(
      formatEvent({
        ...base,
        kind: 'message.replied',
        payload: { recipient: 'alice', body: 'A.' },
      }),
    ).toContain('replied: A.');
    expect(
      formatEvent({ ...base, kind: 'message.pinned', payload: { body: 'Always.' } }),
    ).toContain('pinned: Always.');
  });

  it('neutralizes terminal control characters', () => {
    const rendered = formatMessage({
      id: 'message-1',
      kind: 'message',
      correlationId: null,
      replyTo: null,
      sender: 'alice\u001b[31m',
      recipient: null,
      body: 'safe\u0000text',
      pinned: false,
      createdAt: 0,
      deliveredAt: null,
      readAt: null,
    });
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0000');
    expect(rendered).toContain('safe?text');
  });
});
