import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPENCODE_TUI_PLUGIN } from '../src/adapters.js';
import { ChatLine } from '../src/line.js';
import { followMessages } from '../src/watch.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const originalBun = Reflect.get(globalThis, 'Bun');
afterEach(() => {
  vi.restoreAllMocks();
  if (originalBun === undefined) Reflect.deleteProperty(globalThis, 'Bun');
  else Reflect.set(globalThis, 'Bun', originalBun);
  for (const entry of repositories.splice(0)) entry.cleanup();
});

function lines(): { sender: ChatLine; first: ChatLine; second: ChatLine } {
  const created = repository();
  repositories.push(created);
  return {
    sender: new ChatLine({ cwd: created.root, agent: 'sender' }),
    first: new ChatLine({ cwd: created.root, agent: 'receiver' }),
    second: new ChatLine({ cwd: created.root, agent: 'receiver' }),
  };
}

describe('live delivery', () => {
  it('allows only one live session to reserve a message', () => {
    const { sender, first, second } = lines();
    const sent = sender.send({ to: 'receiver', body: 'Only once.' });
    const reserved = first.reserveNextDelivery();
    expect(reserved?.id).toBe(sent.id);
    expect(second.reserveNextDelivery()).toBeNull();
    first.completeDelivery(sent.id);
    expect(second.reserveNextDelivery()).toBeNull();
    sender.close();
    first.close();
    second.close();
  });

  it('recovers a reservation after its session closes', () => {
    const { sender, first, second } = lines();
    const sent = sender.send({ to: 'receiver', body: 'Retry me.' });
    expect(first.reserveNextDelivery()?.id).toBe(sent.id);
    first.close();
    expect(second.reserveNextDelivery()?.id).toBe(sent.id);
    second.completeDelivery(sent.id);
    sender.close();
    second.close();
  });

  it('fences completion from an expired reservation owner', () => {
    const created = repository();
    repositories.push(created);
    let now = 1_000;
    const sender = new ChatLine({ cwd: created.root, agent: 'sender', now: () => now });
    const first = new ChatLine({
      cwd: created.root,
      agent: 'receiver',
      sessionTtlSeconds: 1,
      now: () => now,
    });
    const second = new ChatLine({ cwd: created.root, agent: 'receiver', now: () => now });
    const sent = sender.send({ to: 'receiver', body: 'Fence me.' });
    expect(first.reserveNextDelivery()?.id).toBe(sent.id);
    now += 2_000;
    expect(second.reserveNextDelivery()?.id).toBe(sent.id);
    expect(() => first.completeDelivery(sent.id)).toThrow(/no longer current/u);
    second.completeDelivery(sent.id);
    sender.close();
    first.close();
    second.close();
  });

  it('recovers a reservation when a harness session resumes', () => {
    const created = repository();
    repositories.push(created);
    const sender = new ChatLine({ cwd: created.root, agent: 'sender' });
    const first = new ChatLine({
      cwd: created.root,
      agent: 'receiver',
      sessionId: 'stable-session',
    });
    const sent = sender.send({ to: 'receiver', body: 'Resume me.' });
    expect(first.reserveNextDelivery()?.id).toBe(sent.id);
    const resumed = new ChatLine({
      cwd: created.root,
      agent: 'receiver',
      sessionId: 'stable-session',
    });
    expect(resumed.reserveNextDelivery()?.id).toBe(sent.id);
    expect(() => first.completeDelivery(sent.id)).toThrow(/no longer current/u);
    resumed.completeDelivery(sent.id);
    sender.close();
    first.database.close();
    resumed.close();
  });

  it('completes only after downstream confirmation', async () => {
    const { sender, first, second } = lines();
    const sent = sender.send({ to: 'receiver', body: 'Confirm me.' });
    await followMessages(first, {
      once: true,
      json: true,
      write: () => undefined,
      confirm: () => false,
    });
    expect(second.reserveNextDelivery()?.id).toBe(sent.id);
    sender.close();
    first.close();
    second.close();
  });

  it('renders request reply instructions for OpenCode', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_TUI_PLUGIN).toString('base64')}`
    )) as { promptFor: (message: Record<string, unknown>) => string };
    const prompt = module.promptFor({
      id: 'message-1',
      kind: 'request',
      correlationId: 'correlation-1',
      replyTo: null,
      sender: 'alice',
      recipient: 'bob',
      body: 'Which port?',
      pinned: false,
    });
    expect(prompt).toContain('Reply-To: message-1');
    expect(prompt).toContain('Reply with clankerchat_reply using that messageId');
    expect(prompt).toContain('Correlation: correlation-1');
    expect(prompt).toContain('peer context');
  });

  it('keeps stable OpenCode delivery metadata in the generated adapter', () => {
    expect(OPENCODE_TUI_PLUGIN).toContain('clankerchatDeliveryKey');
    expect(OPENCODE_TUI_PLUGIN).toContain('clankchatDeliveryKey');
    expect(OPENCODE_TUI_PLUGIN).toContain('clankchat.delivery.');
    expect(OPENCODE_TUI_PLUGIN).toContain('message.deliveryScope');
    expect(OPENCODE_TUI_PLUGIN).toContain('await persisted');
    expect(OPENCODE_TUI_PLUGIN).toContain('ack-stdin');
    expect(OPENCODE_TUI_PLUGIN).not.toContain('sametreeDeliveryKey');
  });

  it('injects once, confirms persistence, and acknowledges downstream', async () => {
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_TUI_PLUGIN).toString('base64')}`
    )) as { default: { tui: (api: Record<string, unknown>) => Promise<void> } };
    const controller = new AbortController();
    const chatMessage = {
      id: 'message-1',
      kind: 'request',
      correlationId: 'correlation-1',
      replyTo: null,
      sender: 'alice',
      recipient: 'bob',
      body: 'Which port?',
      pinned: false,
      createdAt: Date.now(),
      deliveredAt: null,
      readAt: null,
      deliveryScope: 'session-1',
    };
    const stdout = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`${JSON.stringify(chatMessage)}\n`));
        stream.close();
      },
    });
    const prompts: Array<Record<string, unknown>> = [];
    const acknowledgements: string[] = [];
    const values = new Map<string, unknown>();
    let persisted = false;
    let promptedPartId = '';
    let spawnedSession = '';
    let finish: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Reflect.set(globalThis, 'Bun', {
      spawn: (_args: unknown, options: { env: Record<string, string> }) => {
        spawnedSession = options.env.CLANKERCHAT_SESSION ?? '';
        return {
          stdout,
          stdin: {
            write: (value: string) => acknowledgements.push(value),
            end: () => undefined,
            flush: async () => {
              controller.abort();
              finish();
            },
          },
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      },
    });

    await module.default.tui({
      lifecycle: { signal: controller.signal, onDispose: () => undefined },
      state: {
        ready: true,
        path: { directory: '/repo' },
        session: {},
      },
      route: {
        current: { name: 'session', params: { sessionID: 'root' } },
        navigate: () => undefined,
      },
      kv: {
        ready: true,
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
      client: {
        session: {
          get: async () => ({ error: undefined, data: { id: 'root', directory: '/repo' } }),
          list: async () => ({ error: undefined, data: [{ id: 'root', directory: '/repo' }] }),
          messages: async () => ({ error: undefined, data: [] }),
          message: async ({ messageID }: { messageID: string }) => ({
            response: { status: persisted ? 200 : 404 },
            data: persisted
              ? {
                  info: { id: messageID },
                  parts: [{ id: promptedPartId, type: 'text' }],
                }
              : undefined,
          }),
          promptAsync: async (input: Record<string, unknown>) => {
            prompts.push(input);
            promptedPartId = (input.parts as Array<{ id: string }>)[0]?.id ?? '';
            persisted = true;
            return { error: undefined };
          },
          create: async () => ({ error: new Error('not expected') }),
        },
      },
      ui: { toast: () => undefined },
    });

    await completed;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      sessionID: 'root',
      parts: [
        expect.objectContaining({
          metadata: {
            clankerchatDeliveryKey: 'message-1:session-1',
            clankerchatMessageID: 'message-1',
          },
        }),
      ],
    });
    expect(acknowledgements).toEqual(['message-1\n']);
    expect(spawnedSession).toMatch(/^opencode-/u);
  });
});
