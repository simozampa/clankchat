import { setTimeout as delay } from 'node:timers/promises';

import type { ChatEvent, Message } from './types.js';

const PAGE_SIZE = 1_000;

export interface EventSource {
  heartbeat: () => unknown;
  events: (options: { after?: number; limit?: number }) => ChatEvent[];
  lastEventSequence: () => number;
}

function unsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

export function terminalSafe(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return unsafeTerminalCodePoint(codePoint) ? '?' : character;
  }).join('');
}

function jsonLine(value: unknown): string {
  return Array.from(JSON.stringify(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return unsafeTerminalCodePoint(codePoint)
      ? `\\u${codePoint.toString(16).padStart(4, '0')}`
      : character;
  }).join('');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function formatEvent(event: ChatEvent): string {
  const time = new Date(event.createdAt).toISOString().slice(11, 19);
  const recipient = text(event.payload.recipient) || 'everyone';
  const body = text(event.payload.body);
  let description: string;
  switch (event.kind) {
    case 'agent.joined':
      description = `${event.actor} joined the line`;
      break;
    case 'session.started':
      description = `${event.actor} came online`;
      break;
    case 'message.requested':
      description = `${event.actor} -> ${recipient} asked: ${body}`;
      break;
    case 'message.replied':
      description = `${event.actor} -> ${recipient} replied: ${body}`;
      break;
    case 'message.pinned':
      description = `${event.actor} pinned: ${body}`;
      break;
    case 'message.sent':
      description = `${event.actor} -> ${recipient}: ${body}`;
      break;
    case 'message.acknowledged':
      description = `${event.actor} read ${event.messageId ?? 'a message'}`;
      break;
    default:
      description = `${event.actor}: ${event.kind}`;
  }
  return terminalSafe(`${time}  ${description}`);
}

export function formatMessage(message: Message): string {
  const time = new Date(message.createdAt).toISOString();
  const recipient = message.recipient ?? 'everyone';
  const labels = [
    message.kind,
    message.pinned ? 'pinned' : '',
    message.correlationId ? `correlation ${message.correlationId}` : '',
    message.replyTo ? `reply-to ${message.replyTo}` : '',
  ].filter(Boolean);
  const header = `${time}  ${message.sender} -> ${recipient}  [${message.id}; ${labels.join('; ')}]`;
  const body = message.body
    .split('\n')
    .map((line) => `  ${terminalSafe(line)}`)
    .join('\n');
  return `${terminalSafe(header)}\n${body}`;
}

function stdoutLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

function brokenPipe(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'EPIPE';
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await delay(milliseconds, undefined, { signal });
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return false;
    throw error;
  }
}

export async function watchEvents(
  line: EventSource,
  options: {
    after?: number;
    intervalMs?: number;
    json?: boolean;
    once?: boolean;
    signal?: AbortSignal;
    write?: (value: string) => void | Promise<void>;
  } = {},
): Promise<number> {
  let cursor = options.after ?? 0;
  const highWater = options.once ? line.lastEventSequence() : null;
  const write = options.write ?? stdoutLine;
  while (!options.signal?.aborted) {
    line.heartbeat();
    const fetched = line.events({ after: cursor, limit: PAGE_SIZE });
    const events =
      highWater === null ? fetched : fetched.filter((item) => item.sequence <= highWater);
    for (const event of events) {
      try {
        await write(options.json ? jsonLine(event) : formatEvent(event));
      } catch (error) {
        if (brokenPipe(error)) return cursor;
        throw error;
      }
      cursor = event.sequence;
    }
    if (highWater !== null && cursor >= highWater) return cursor;
    if (options.once) return cursor;
    if (fetched.length === PAGE_SIZE) continue;
    if (!(await wait(options.intervalMs ?? 1_000, options.signal))) return cursor;
  }
  return cursor;
}

export async function followMessages(
  line: import('./line.js').ChatLine,
  options: {
    intervalMs?: number;
    json?: boolean;
    once?: boolean;
    prefix?: string;
    signal?: AbortSignal;
    write?: (value: string) => void | Promise<void>;
    confirm?: (message: Message) => boolean | Promise<boolean>;
    assertActive?: () => void;
  } = {},
): Promise<number> {
  const write = options.write ?? stdoutLine;
  let delivered = 0;
  let reserved: Message | null = null;
  try {
    while (!options.signal?.aborted) {
      options.assertActive?.();
      reserved = line.reserveNextDelivery();
      if (reserved) {
        options.assertActive?.();
        if (!line.deliveryIsCurrent(reserved.id)) {
          line.releaseDelivery(reserved.id);
          reserved = null;
          continue;
        }
        const output = options.json ? jsonLine(reserved) : formatMessage(reserved);
        try {
          options.assertActive?.();
          await write(`${terminalSafe(options.prefix ?? '')}${output}`);
          options.assertActive?.();
        } catch (error) {
          if (brokenPipe(error)) return delivered;
          throw error;
        }
        if (options.confirm && !(await options.confirm(reserved))) return delivered;
        options.assertActive?.();
        line.completeDelivery(reserved.id);
        delivered += 1;
        reserved = null;
        continue;
      }
      if (options.once) return delivered;
      if (!(await wait(options.intervalMs ?? 1_000, options.signal))) return delivered;
    }
    return delivered;
  } finally {
    if (reserved) line.releaseDelivery(reserved.id);
  }
}
