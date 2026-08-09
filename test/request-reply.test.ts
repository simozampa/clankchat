import { afterEach, describe, expect, it } from 'vitest';

import { ClankerChatError } from '../src/errors.js';
import { ChatLine } from '../src/line.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const entry of repositories.splice(0)) entry.cleanup();
});

function pair(): { alice: ChatLine; bob: ChatLine } {
  const created = repository();
  repositories.push(created);
  return {
    alice: new ChatLine({ cwd: created.root, agent: 'alice' }),
    bob: new ChatLine({ cwd: created.root, agent: 'bob' }),
  };
}

describe('request and reply', () => {
  it('returns a correlated reply in the awaiting call', async () => {
    const { alice, bob } = pair();
    const request = alice.request({ to: 'bob', body: 'Which port?' });
    setTimeout(() => bob.reply({ toMessage: request.id, body: '8080' }), 20);
    const reply = await alice.awaitReply(request.id, { timeoutMs: 1_000 });
    expect(reply).toMatchObject({
      body: '8080',
      replyTo: request.id,
      correlationId: request.correlationId,
    });
    expect(alice.inbox({ unreadOnly: true })).toEqual([]);
    alice.close();
    bob.close();
  });

  it('times out without cancelling the durable request', async () => {
    const { alice, bob } = pair();
    const request = alice.request({ to: 'bob', body: 'Still there?' });
    await expect(alice.awaitReply(request.id, { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'REPLY_TIMEOUT',
    });
    const late = bob.reply({ toMessage: request.id, body: 'Yes.' });
    expect((await alice.awaitReply(request.id, { timeoutMs: 100 })).id).toBe(late.id);
    alice.close();
    bob.close();
  });

  it('resolves concurrent awaits only with their own replies', async () => {
    const { alice, bob } = pair();
    const first = alice.request({ to: 'bob', body: 'First?' });
    const second = alice.request({ to: 'bob', body: 'Second?' });
    const waits = [
      alice.awaitReply(first.id, { timeoutMs: 1_000 }),
      alice.awaitReply(second.id, { timeoutMs: 1_000 }),
    ];
    setTimeout(() => {
      bob.reply({ toMessage: second.id, body: 'two' });
      bob.reply({ toMessage: first.id, body: 'one' });
    }, 20);
    await expect(Promise.all(waits)).resolves.toMatchObject([
      { body: 'one', replyTo: first.id },
      { body: 'two', replyTo: second.id },
    ]);
    alice.close();
    bob.close();
  });

  it('protects an awaited reply from another live session', async () => {
    const { alice, bob } = pair();
    const otherAlice = new ChatLine({ cwd: alice.repository.root, agent: 'alice' });
    const waiting = alice.requestAndAwait({ to: 'bob', body: 'Fast reply?', timeoutMs: 1_000 });
    const request = bob.inbox().find((message) => message.kind === 'request');
    expect(request).toBeDefined();
    bob.reply({ toMessage: request?.id ?? '', body: 'Here.' });
    expect(otherAlice.reserveNextDelivery()).toBeNull();
    await expect(waiting).resolves.toMatchObject({ reply: { body: 'Here.' } });
    alice.close();
    bob.close();
    otherAlice.close();
  });

  it('cancels a wait without cancelling its durable request', async () => {
    const { alice, bob } = pair();
    const controller = new AbortController();
    const waiting = alice.requestAndAwait({
      to: 'bob',
      body: 'Can be answered later?',
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    const request = bob.inbox().find((message) => message.kind === 'request');
    expect(request?.body).toBe('Can be answered later?');
    alice.close();
    bob.close();
  });

  it('does not consume a reply after cancellation', async () => {
    const { alice, bob } = pair();
    const request = alice.request({ to: 'bob', body: 'Already answered?' });
    const reply = bob.reply({ toMessage: request.id, body: 'Waiting unread.' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      alice.awaitReply(request.id, { timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(alice.inbox({ unreadOnly: true }).map((message) => message.id)).toContain(reply.id);
    alice.close();
    bob.close();
  });

  it('validates the timeout before sending a request', async () => {
    const { alice, bob } = pair();
    await expect(
      alice.requestAndAwait({ to: 'bob', body: 'Do not send.', timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(bob.inbox()).toEqual([]);
    alice.close();
    bob.close();
  });

  it('allows only the recipient and one reply', () => {
    const { alice, bob } = pair();
    const carol = new ChatLine({ cwd: alice.repository.root, agent: 'carol' });
    const request = alice.request({ to: 'bob', body: 'Question' });
    expect(() => carol.reply({ toMessage: request.id, body: 'No.' })).toThrow(ClankerChatError);
    bob.reply({ toMessage: request.id, body: 'Answer.' });
    expect(() => bob.reply({ toMessage: request.id, body: 'Again.' })).toThrow(/already/u);
    alice.close();
    bob.close();
    carol.close();
  });
});
