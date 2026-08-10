import { lstatSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { Command } from 'commander';

import { agentIdentity, detectHarness } from './activity.js';
import { handleCodexHook, isCodexHookEvent } from './codex.js';
import { doctor } from './doctor.js';
import { globalStateDirectory, type LineScope, parseLineScope } from './git.js';
import { ChatLine, ChatObserver } from './line.js';
import { setup } from './setup.js';
import type { Harness, Message } from './types.js';
import { VERSION } from './version.js';
import { followMessages, watchEvents } from './watch.js';

interface GlobalOptions {
  cwd: string;
  scope: LineScope;
  agent?: string;
  harness?: Harness;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readStdin(limit: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, limit + 1 - total));
    const count = readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total).toString('utf8');
    total += count;
    if (total > limit) throw new Error(`Standard input exceeds ${limit} bytes.`);
    chunks.push(chunk.subarray(0, count));
  }
}

function body(options: { body?: string; bodyStdin?: boolean }): string {
  if (options.body !== undefined && options.bodyStdin) {
    throw new Error('Use either --body or --body-stdin, not both.');
  }
  if (options.body !== undefined) return options.body;
  if (options.bodyStdin) return readStdin(50_000);
  throw new Error('A message body is required.');
}

function globalOptions(command: Command): GlobalOptions {
  const options = command.optsWithGlobals<Omit<GlobalOptions, 'scope'> & { scope?: string }>();
  return {
    ...options,
    scope: parseLineScope(
      options.scope ?? process.env.CLANKERCHAT_SCOPE ?? process.env.CLANKCHAT_SCOPE,
    ),
  };
}

function harnessBindingAssertion(): (() => void) | undefined {
  const target = process.env.CLANKERCHAT_BINDING_FILE;
  const token = process.env.CLANKERCHAT_BINDING_TOKEN;
  if (!target && !token) return undefined;
  if (!target || !token || !path.isAbsolute(target))
    throw new Error('The harness binding is invalid.');
  const expectedDirectory = path.join(globalStateDirectory(), 'harness-bindings');
  return () => {
    const state = lstatSync(target);
    const userId = typeof process.getuid === 'function' ? process.getuid() : null;
    const lines = readFileSync(target, 'utf8').split('\n');
    const fields = lines[0]?.split('\t') ?? [];
    const owner = Number(fields[2]);
    const expires = Number(fields[3]);
    if (
      realpathSync(path.dirname(target)) !== expectedDirectory ||
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1 ||
      (userId !== null && state.uid !== userId) ||
      (state.mode & 0o777) !== 0o600 ||
      lines.length !== 3 ||
      fields.length !== 5 ||
      fields[0] !== '1' ||
      fields[4] !== token ||
      !Number.isSafeInteger(owner) ||
      owner <= 0 ||
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      lines[1] !== process.env.CLANKERCHAT_EXPECTED_DATABASE_PATH_BASE64
    ) {
      throw new Error('The harness binding is no longer active.');
    }
    process.kill(owner, 0);
  };
}

function openLine(command: Command): ChatLine {
  const options = globalOptions(command);
  const harness = options.harness ?? detectHarness();
  const announcePresence = command.name() === 'follow' && command.parent?.name() === 'message';
  const sessionId = process.env.CLANKERCHAT_SESSION ?? process.env.CLANKCHAT_SESSION;
  const encodedPath = process.env.CLANKERCHAT_EXPECTED_DATABASE_PATH_BASE64;
  const expectedDatabasePath = encodedPath
    ? Buffer.from(encodedPath, 'base64').toString('utf8')
    : undefined;
  if (
    encodedPath &&
    (!expectedDatabasePath || Buffer.from(expectedDatabasePath).toString('base64') !== encodedPath)
  ) {
    throw new Error('The harness database binding is invalid.');
  }
  harnessBindingAssertion()?.();
  return new ChatLine({
    cwd: options.cwd,
    scope: options.scope,
    agent: options.agent ?? agentIdentity(harness),
    harness,
    announcePresence,
    ...(expectedDatabasePath ? { expectedDatabasePath } : {}),
    ...(sessionId ? { sessionId } : {}),
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
    .name('clankerchat')
    .description('comms for your coding agents')
    .version(VERSION)
    .option(
      '--cwd <path>',
      'context path',
      process.env.CLANKERCHAT_CWD ?? process.env.CLANKCHAT_CWD ?? process.cwd(),
    )
    .option('--scope <scope>', 'auto, repository, or global')
    .option(
      '--agent <name>',
      'agent name',
      process.env.CLANKERCHAT_AGENT ?? process.env.CLANKCHAT_AGENT,
    )
    .option('--harness <name>', 'claude-code, opencode, or other');

  program
    .command('setup')
    .description('Configure Claude Code, Codex, and OpenCode.')
    .option('--user', 'configure user-level integrations')
    .option('--claude', 'configure only Claude Code')
    .option('--codex', 'configure only Codex')
    .option('--opencode', 'configure only OpenCode')
    .action(
      (
        options: { user?: boolean; claude?: boolean; codex?: boolean; opencode?: boolean },
        command: Command,
      ) => {
        const globals = globalOptions(command);
        print(
          setup({
            cwd: globals.cwd,
            ...(options.user ? { user: true } : {}),
            ...(options.claude ? { claude: true } : {}),
            ...(options.codex ? { codex: true } : {}),
            ...(options.opencode ? { opencode: true } : {}),
          }),
        );
      },
    );

  program
    .command('status')
    .description('Show the selected line and the current agent.')
    .action((_options: unknown, command: Command) =>
      print(withLine(command, (line) => line.status())),
    );

  program
    .command('agents')
    .description('List agents on the selected line.')
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
    .description('Check line state and Codex setup.')
    .action((_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const report = doctor(globals.cwd, { scope: globals.scope });
      print(report);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('watch')
    .description('Watch the selected line.')
    .option('--after <sequence>', 'start after event sequence', (value) => Number(value), 0)
    .option('--interval <milliseconds>', 'poll interval', (value) => Number(value), 1_000)
    .option('--json', 'emit JSON Lines')
    .option('--once', 'drain current events and stop')
    .action(
      async (
        options: { after: number; interval: number; json?: boolean; once?: boolean },
        command: Command,
      ) => {
        const globals = globalOptions(command);
        const observer = new ChatObserver({ cwd: globals.cwd, scope: globals.scope });
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
    .option('--timeout-ms <milliseconds>', 'reply timeout in milliseconds', Number, 30_000)
    .option('--pinned', 'deliver this broadcast to every future session')
    .option('--source-key <key>', 'stable adapter source identity')
    .action(
      async (
        options: {
          to?: string;
          body?: string;
          bodyStdin?: boolean;
          awaitReply?: boolean;
          timeoutMs: number;
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
                timeoutMs: options.timeoutMs,
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
        const assertActive = harnessBindingAssertion();
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
            ...(assertActive ? { assertActive } : {}),
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
        const input: unknown = JSON.parse(readStdin(1_000_000));
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

  const hooks = program.command('hook', { hidden: true });
  hooks
    .command('codex', { hidden: true })
    .requiredOption('--event <name>')
    .action(async (options: { event: string }, command: Command) => {
      const watchdog = setTimeout(() => process.exit(0), 4_000);
      try {
        if (!isCodexHookEvent(options.event)) return;
        await handleCodexHook(options.event, readStdin(1_000_000), {
          scope: globalOptions(command).scope,
        });
      } catch {
      } finally {
        clearTimeout(watchdog);
      }
    });

  return program;
}

export async function run(argv = process.argv, signal?: AbortSignal): Promise<void> {
  await buildProgram(signal).parseAsync(argv);
}
