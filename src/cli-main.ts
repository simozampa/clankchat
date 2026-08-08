import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { Command } from 'commander';

import { agentIdentity, detectHarness } from './activity.js';
import { doctor } from './doctor.js';
import { ChatLine, ChatObserver } from './line.js';
import { setup } from './setup.js';
import type { Harness, Message } from './types.js';
import { VERSION } from './version.js';
import { followMessages, watchEvents } from './watch.js';

interface GlobalOptions {
  cwd: string;
  agent?: string;
  harness?: Harness;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function body(options: { body?: string; bodyStdin?: boolean }): string {
  if (options.body !== undefined && options.bodyStdin) {
    throw new Error('Use either --body or --body-stdin, not both.');
  }
  if (options.body !== undefined) return options.body;
  if (options.bodyStdin) return readFileSync(0, 'utf8');
  throw new Error('A message body is required.');
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function openLine(command: Command): ChatLine {
  const options = globalOptions(command);
  const harness = options.harness ?? detectHarness();
  return new ChatLine({
    cwd: options.cwd,
    agent: options.agent ?? agentIdentity(harness),
    harness,
    ...(process.env.CLANKCHAT_SESSION ? { sessionId: process.env.CLANKCHAT_SESSION } : {}),
  });
}

function withLine<T>(command: Command, operation: (line: ChatLine) => T): T {
  const line = openLine(command);
  try {
    return operation(line);
  } finally {
    line.close();
  }
}

async function withLineAsync<T>(
  command: Command,
  operation: (line: ChatLine) => Promise<T>,
): Promise<T> {
  const line = openLine(command);
  try {
    return await operation(line);
  } finally {
    line.close();
  }
}

export function buildProgram(signal?: AbortSignal): Command {
  const program = new Command()
    .name('clankchat')
    .description('comms for your coding agents')
    .version(VERSION)
    .option('--cwd <path>', 'repository path', process.env.CLANKCHAT_CWD ?? process.cwd())
    .option('--agent <name>', 'agent name', process.env.CLANKCHAT_AGENT)
    .option('--harness <name>', 'claude-code, opencode, or other');

  program
    .command('setup')
    .description('Configure Claude Code and OpenCode for this repository.')
    .option('--claude', 'configure only Claude Code')
    .option('--opencode', 'configure only OpenCode')
    .action((options: { claude?: boolean; opencode?: boolean }, command: Command) => {
      const globals = globalOptions(command);
      print(
        setup({
          cwd: globals.cwd,
          ...(options.claude ? { claude: true } : {}),
          ...(options.opencode ? { opencode: true } : {}),
        }),
      );
    });

  program
    .command('status')
    .description('Show this repository line and the current agent.')
    .action((_options: unknown, command: Command) =>
      print(withLine(command, (line) => line.status())),
    );

  program
    .command('agents')
    .description('List agents on this repository line.')
    .option('--all', 'include offline agents')
    .action((options: { all?: boolean }, command: Command) =>
      print(
        withLine(command, (line) =>
          line.agents({ ...(options.all === undefined ? {} : { includeOffline: options.all }) }),
        ),
      ),
    );

  program
    .command('heartbeat')
    .description('Renew the current agent session.')
    .action((_options: unknown, command: Command) =>
      print(withLine(command, (line) => line.heartbeat())),
    );

  program
    .command('doctor')
    .description('Check Git and SQLite health.')
    .action((_options: unknown, command: Command) => {
      const report = doctor(globalOptions(command).cwd);
      print(report);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('watch')
    .description('Watch the repository conversation.')
    .option('--after <sequence>', 'start after event sequence', (value) => Number(value), 0)
    .option('--interval <milliseconds>', 'poll interval', (value) => Number(value), 1_000)
    .option('--json', 'emit JSON Lines')
    .option('--once', 'drain current events and stop')
    .action(
      async (
        options: { after: number; interval: number; json?: boolean; once?: boolean },
        command: Command,
      ) => {
        const observer = new ChatObserver(globalOptions(command).cwd);
        try {
          await watchEvents(observer, {
            after: options.after,
            intervalMs: options.interval,
            ...(options.json === undefined ? {} : { json: options.json }),
            ...(options.once === undefined ? {} : { once: options.once }),
            ...(signal ? { signal } : {}),
          });
        } finally {
          observer.close();
        }
      },
    );

  const messages = program.command('message').description('Send and read messages.');

  messages
    .command('send')
    .description('Send a direct message or broadcast.')
    .option('--to <agent>', 'direct recipient')
    .option('--body <text>', 'message body')
    .option('--body-stdin', 'read the body from stdin')
    .option('--await-reply', 'wait for a correlated reply')
    .option('--timeout <milliseconds>', 'reply timeout', (value) => Number(value), 30_000)
    .option('--pinned', 'deliver this broadcast to every future session')
    .option('--source-key <key>', 'stable adapter source identity')
    .action(
      async (
        options: {
          to?: string;
          body?: string;
          bodyStdin?: boolean;
          awaitReply?: boolean;
          timeout: number;
          pinned?: boolean;
          sourceKey?: string;
        },
        command: Command,
      ) => {
        await withLineAsync(command, async (line) => {
          const messageBody = body(options);
          if (options.awaitReply) {
            if (!options.to) throw new Error('--await-reply requires --to.');
            print(
              await line.requestAndAwait({
                to: options.to,
                body: messageBody,
                timeoutMs: options.timeout,
                ...(signal ? { signal } : {}),
              }),
            );
            return;
          }
          print(
            line.send({
              body: messageBody,
              ...(options.to ? { to: options.to } : {}),
              ...(options.pinned ? { pinned: true } : {}),
              ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
            }),
          );
        });
      },
    );

  messages
    .command('reply <message-id>')
    .description('Reply to a request.')
    .option('--body <text>', 'reply body')
    .option('--body-stdin', 'read the body from stdin')
    .action(
      (messageId: string, options: { body?: string; bodyStdin?: boolean }, command: Command) =>
        print(
          withLine(command, (line) => line.reply({ toMessage: messageId, body: body(options) })),
        ),
    );

  messages
    .command('inbox')
    .description('List messages for the current agent.')
    .option('--unread', 'show unread messages only')
    .option('--limit <count>', 'maximum messages', (value) => Number(value), 100)
    .action((options: { unread?: boolean; limit: number }, command: Command) =>
      print(
        withLine(command, (line) =>
          line.inbox({
            ...(options.unread === undefined ? {} : { unreadOnly: options.unread }),
            limit: options.limit,
          }),
        ),
      ),
    );

  messages
    .command('ack <message-ids...>')
    .description('Mark messages read.')
    .action((messageIds: string[], _options: unknown, command: Command) =>
      print({ acknowledged: withLine(command, (line) => line.acknowledge(messageIds)) }),
    );

  messages
    .command('follow')
    .description('Follow messages for a live harness session.')
    .option('--interval <milliseconds>', 'poll interval', (value) => Number(value), 1_000)
    .option('--json', 'emit JSON Lines')
    .option('--once', 'drain pending messages and stop')
    .option('--prefix <text>', 'output prefix', '')
    .option('--ack-stdin', 'wait for each emitted message ID on stdin')
    .action(
      async (
        options: {
          interval: number;
          json?: boolean;
          once?: boolean;
          prefix: string;
          ackStdin?: boolean;
        },
        command: Command,
      ) => {
        await withLineAsync(command, async (line) => {
          const input = options.ackStdin
            ? createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]()
            : null;
          await followMessages(line, {
            intervalMs: options.interval,
            ...(options.json === undefined ? {} : { json: options.json }),
            ...(options.once === undefined ? {} : { once: options.once }),
            prefix: options.prefix,
            ...(signal ? { signal } : {}),
            ...(input
              ? {
                  confirm: async (message: Message) => {
                    const next = await input.next();
                    return !next.done && next.value.trim() === message.id;
                  },
                }
              : {}),
          });
        });
      },
    );

  messages
    .command('capture', { hidden: true })
    .description('Capture a pinned human broadcast from a harness event.')
    .action((_options: unknown, command: Command) => {
      try {
        const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
        if (typeof input !== 'object' || input === null) return;
        const prompt = Reflect.get(input, 'prompt');
        if (typeof prompt !== 'string' || !prompt.startsWith('For all agents:')) return;
        const sessionId = Reflect.get(input, 'session_id');
        const eventId = Reflect.get(input, 'event_id');
        const sourceKey =
          typeof eventId === 'string'
            ? `claude:${eventId}`
            : typeof sessionId === 'string'
              ? `claude:${sessionId}:${Date.now()}`
              : undefined;
        withLine(command, (line) =>
          line.send({ body: prompt, pinned: true, ...(sourceKey ? { sourceKey } : {}) }),
        );
      } catch {}
    });

  return program;
}

export async function run(argv = process.argv, signal?: AbortSignal): Promise<void> {
  await buildProgram(signal).parseAsync(argv);
}
