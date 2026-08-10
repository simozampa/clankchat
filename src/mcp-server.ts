import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { agentIdentity, detectHarness } from './activity.js';
import { bindCodexLineContext, codexAgentIdentity } from './codex.js';
import { errorResult } from './errors.js';
import { writeTextFileAtomic } from './files.js';
import { globalStateDirectory, type LineScope, parseLineScope, resolveLineContext } from './git.js';
import { ChatLine } from './line.js';
import type { Harness } from './types.js';
import { VERSION } from './version.js';

const outputSchema = { result: z.unknown() };
const MAX_CODEX_THREADS = 32;

interface NativeHarnessBinding {
  scope: 'repository' | 'global';
  databasePath: string;
  ownerProcessId: number;
  expiresAt: number;
  token: string;
}

interface NativeBindingLease {
  assertOwned: () => void;
  close: () => void;
}

interface BindingLock {
  descriptor: number;
  path: string;
  token: string;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

function readNativeBinding(target: string, userId: number | null): NativeHarnessBinding {
  const current = lstatSync(target);
  const lines = readFileSync(target, 'utf8').split('\n');
  const fields = lines[0]?.split('\t') ?? [];
  const ownerProcessId = Number(fields[2]);
  const expiresAt = Number(fields[3]);
  const encodedPath = lines[1] ?? '';
  const databasePath = Buffer.from(encodedPath, 'base64').toString('utf8');
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    (userId !== null && current.uid !== userId) ||
    (current.mode & 0o777) !== 0o600 ||
    lines.length !== 3 ||
    fields.length !== 5 ||
    fields[0] !== '1' ||
    (fields[1] !== 'repository' && fields[1] !== 'global') ||
    !Number.isSafeInteger(ownerProcessId) ||
    ownerProcessId <= 0 ||
    !Number.isSafeInteger(expiresAt) ||
    !/^[0-9a-f-]{36}$/u.test(fields[4] ?? '') ||
    !encodedPath ||
    Buffer.from(databasePath).toString('base64') !== encodedPath
  ) {
    throw new Error('Harness binding file is unsafe or invalid.');
  }
  return {
    scope: fields[1],
    databasePath,
    ownerProcessId,
    expiresAt,
    token: fields[4] as string,
  };
}

function acquireBindingLock(target: string, userId: number | null): BindingLock {
  const lockPath = `${target}.lock`;
  for (;;) {
    const token = randomUUID();
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeSync(descriptor, `${process.pid}\t${token}\n`);
      return { descriptor, path: lockPath, token };
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'EEXIST') throw error;
      const state = lstatSync(lockPath);
      const fields = readFileSync(lockPath, 'utf8').trim().split('\t');
      const owner = Number(fields[0]);
      if (
        !state.isFile() ||
        state.isSymbolicLink() ||
        state.nlink !== 1 ||
        (userId !== null && state.uid !== userId) ||
        (state.mode & 0o777) !== 0o600 ||
        fields.length !== 2 ||
        !Number.isSafeInteger(owner) ||
        processIsAlive(owner)
      ) {
        throw new Error('Another harness binding update is active or unsafe.');
      }
      rmSync(lockPath);
    }
  }
}

function releaseBindingLock(lock: BindingLock): void {
  closeSync(lock.descriptor);
  try {
    if (readFileSync(lock.path, 'utf8') === `${process.pid}\t${lock.token}\n`) rmSync(lock.path);
  } catch {}
}

function bindNativeHarnessScope(
  harness: Harness,
  context: ReturnType<typeof resolveLineContext>,
): NativeBindingLease {
  const native =
    harness === 'claude-code'
      ? process.env.CLAUDE_CODE_SESSION_ID
      : harness === 'opencode'
        ? process.env.OPENCODE_PID
        : undefined;
  if (!native || !/^[A-Za-z0-9._-]{1,120}$/u.test(native)) {
    return { assertOwned: () => undefined, close: () => undefined };
  }
  const state = globalStateDirectory();
  const root = path.dirname(state);
  const bindings = path.join(state, 'harness-bindings');
  const userId = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const [directory, mode] of [
    [root, 0o700],
    [state, 0o700],
    [bindings, 0o700],
  ] as const) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error('Refusing to use a symlinked harness binding directory.');
    }
    mkdirSync(directory, { recursive: true, mode });
    const current = lstatSync(directory);
    if (
      !current.isDirectory() ||
      (userId !== null && current.uid !== userId) ||
      (directory === root ? (current.mode & 0o022) !== 0 : (current.mode & 0o777) !== 0o700)
    )
      throw new Error('Harness binding directory permissions are unsafe.');
  }
  const target = path.join(bindings, `${harness}-${native}.binding`);
  const token = randomUUID();
  const encodedPath = Buffer.from(context.databasePath).toString('base64');
  const writeBinding = () =>
    writeTextFileAtomic(
      target,
      `1\t${context.scope}\t${process.pid}\t${Date.now() + 90_000}\t${token}\n${encodedPath}\n`,
      0o600,
    );
  const initialLock = acquireBindingLock(target, userId);
  try {
    if (existsSync(target)) {
      const existing = readNativeBinding(target, userId);
      const sameLine =
        existing.scope === context.scope && existing.databasePath === context.databasePath;
      if (
        processIsAlive(existing.ownerProcessId) ||
        (!sameLine && existing.expiresAt + 30_000 > Date.now())
      ) {
        throw new Error('The harness session is already bound to another clankerchat line.');
      }
    }
    writeBinding();
  } finally {
    releaseBindingLock(initialLock);
  }
  let ownershipError: Error | null = null;
  const assertOwned = () => {
    if (ownershipError) throw ownershipError;
    const current = readNativeBinding(target, userId);
    if (current.token !== token || current.ownerProcessId !== process.pid) {
      throw new Error('This MCP server no longer owns the harness line binding.');
    }
  };
  const renew = () => {
    if (ownershipError) return;
    let lock: BindingLock | null = null;
    try {
      lock = acquireBindingLock(target, userId);
      assertOwned();
      writeBinding();
    } catch (error) {
      ownershipError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (lock) releaseBindingLock(lock);
    }
  };
  const timer = setInterval(renew, 30_000);
  timer.unref();
  return { assertOwned, close: () => clearInterval(timer) };
}

interface ToolExtra {
  signal: AbortSignal;
  _meta?: { [key: string]: unknown };
}

function response(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpServer(
  options: { cwd?: string; scope?: LineScope; agent?: string; harness?: Harness } = {},
): { close: () => void; server: McpServer } {
  const cwd =
    options.cwd ??
    process.env.CLANKERCHAT_CWD ??
    process.env.CLANKCHAT_CWD ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const harness = options.harness ?? detectHarness();
  const scope = parseLineScope(
    options.scope ?? process.env.CLANKERCHAT_SCOPE ?? process.env.CLANKCHAT_SCOPE,
  );
  const context = resolveLineContext({ cwd, scope });
  const codex =
    (process.env.CLANKERCHAT_CODEX === '1' || process.env.CLANKCHAT_CODEX === '1') &&
    options.agent === undefined;
  const nativeBinding = codex
    ? { assertOwned: () => undefined, close: () => undefined }
    : bindNativeHarnessScope(harness, context);
  const lines = new Map<string, ChatLine>();
  const server = new McpServer({ name: 'clankerchat', version: VERSION });

  function lineFor(extra: ToolExtra): ChatLine {
    nativeBinding.assertOwned();
    const threadId = extra._meta?.threadId;
    if (codex && (typeof threadId !== 'string' || threadId.length === 0)) {
      throw new Error('Codex did not provide its thread identity.');
    }
    const codexAgent = codex && typeof threadId === 'string' ? codexAgentIdentity(threadId) : null;
    if (codex && !codexAgent) throw new Error('Codex provided an invalid thread identity.');
    const key = codexAgent ? `codex:${codexAgent}` : 'default';
    const existing = lines.get(key);
    if (existing) return existing;
    if (lines.size >= MAX_CODEX_THREADS) {
      throw new Error('This clankerchat MCP server has reached its Codex thread limit.');
    }
    if (codexAgent && typeof threadId === 'string') bindCodexLineContext(threadId, context);
    const line = new ChatLine(
      {
        cwd,
        scope: context.scope,
        agent: codexAgent ?? options.agent ?? agentIdentity(harness),
        harness: codexAgent ? 'other' : harness,
        ...(codexAgent ? { sessionId: `codex-mcp-${codexAgent.slice('codex-'.length)}` } : {}),
      },
      context,
    );
    lines.set(key, line);
    return line;
  }

  function execute(extra: ToolExtra, operation: (line: ChatLine) => unknown) {
    try {
      const line = lineFor(extra);
      line.heartbeat();
      return response(operation(line));
    } catch (error) {
      return response(errorResult(error), true);
    }
  }

  async function executeAsync(extra: ToolExtra, operation: (line: ChatLine) => Promise<unknown>) {
    try {
      const line = lineFor(extra);
      line.heartbeat();
      return response(await operation(line));
    } catch (error) {
      return response(errorResult(error), true);
    }
  }

  server.registerTool(
    'clankerchat_send',
    {
      title: 'Send a clankerchat message',
      description:
        'Send directly to one agent or broadcast on the selected line. Optionally wait for a correlated reply.',
      inputSchema: {
        body: z.string().min(1).max(50_000),
        to: z.string().min(1).max(80).optional(),
        awaitReply: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
      },
      outputSchema,
    },
    ({ body, to, awaitReply, timeoutMs }, extra) => {
      if (awaitReply) {
        return executeAsync(extra, async (line) => {
          if (!to) throw new Error('awaitReply requires a direct recipient.');
          return await line.requestAndAwait({
            to,
            body,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            signal: extra.signal,
          });
        });
      }
      return execute(extra, (line) =>
        line.send({
          body,
          ...(to ? { to } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'clankerchat_reply',
    {
      title: 'Reply to a clankerchat request',
      description: 'Reply to a direct request using the request message ID.',
      inputSchema: {
        messageId: z.string().min(1).max(100),
        body: z.string().min(1).max(50_000),
      },
      outputSchema,
    },
    ({ messageId, body }, extra) =>
      execute(extra, (line) => line.reply({ toMessage: messageId, body })),
  );

  server.registerTool(
    'clankerchat_inbox',
    {
      title: 'Read clankerchat messages',
      description: 'Read direct messages and broadcasts for this agent.',
      inputSchema: {
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ unreadOnly, limit }, extra) =>
      execute(extra, (line) =>
        line.inbox({
          ...(unreadOnly === undefined ? {} : { unreadOnly }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
  );

  server.registerTool(
    'clankerchat_ack',
    {
      title: 'Mark clankerchat messages read',
      description: 'Idempotently mark messages read by this agent.',
      inputSchema: { messageIds: z.array(z.string().min(1).max(100)).min(1).max(1_000) },
      outputSchema,
      annotations: { idempotentHint: true },
    },
    ({ messageIds }, extra) =>
      execute(extra, (line) => ({ acknowledged: line.acknowledge(messageIds) })),
  );

  server.registerTool(
    'clankerchat_agents',
    {
      title: 'List agents on this line',
      description: 'List agent names, harnesses, online state, and last-seen times.',
      inputSchema: { includeOffline: z.boolean().optional() },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ includeOffline }, extra) =>
      execute(extra, (line) => line.agents({ includeOffline: includeOffline ?? false })),
  );

  server.registerTool(
    'clankerchat_status',
    {
      title: 'Show clankerchat status',
      description: 'Show the selected line, current identity, agents, and unread count.',
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    (extra) => execute(extra, (line) => line.status()),
  );

  server.registerTool(
    'clankerchat_heartbeat',
    {
      title: 'Renew clankerchat session',
      description: 'Renew this agent session after idle time or system sleep.',
      outputSchema,
      annotations: { idempotentHint: true },
    },
    (extra) => execute(extra, (line) => line.heartbeat()),
  );

  const close = () => {
    for (const line of lines.values()) {
      try {
        line.close();
      } catch {}
    }
    lines.clear();
    nativeBinding.close();
  };
  return { close, server };
}

export async function runMcp(): Promise<void> {
  const created = createMcpServer();
  const close = () => {
    try {
      created.close();
    } catch {}
  };
  process.once('exit', close);
  process.once('SIGINT', () => {
    close();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    close();
    process.exit(143);
  });
  await created.server.connect(new StdioServerTransport());
}
