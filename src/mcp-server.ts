import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { agentIdentity, detectHarness } from './activity.js';
import { codexAgentIdentity } from './codex.js';
import { errorResult } from './errors.js';
import { ChatLine } from './line.js';
import type { Harness } from './types.js';
import { VERSION } from './version.js';

const outputSchema = { result: z.unknown() };
const MAX_CODEX_THREADS = 32;

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
  options: { cwd?: string; agent?: string; harness?: Harness } = {},
): { close: () => void; server: McpServer } {
  const cwd =
    options.cwd ??
    process.env.CLANKERCHAT_CWD ??
    process.env.CLANKCHAT_CWD ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd();
  const harness = options.harness ?? detectHarness();
  const codex =
    (process.env.CLANKERCHAT_CODEX === '1' || process.env.CLANKCHAT_CODEX === '1') &&
    options.agent === undefined;
  const lines = new Map<string, ChatLine>();
  const server = new McpServer({ name: 'clankerchat', version: VERSION });

  function lineFor(extra: ToolExtra): ChatLine {
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
    const line = new ChatLine({
      cwd,
      agent: codexAgent ?? options.agent ?? agentIdentity(harness),
      harness: codexAgent ? 'other' : harness,
      ...(codexAgent ? { sessionId: `codex-mcp-${codexAgent.slice('codex-'.length)}` } : {}),
    });
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
        'Send directly to one agent or broadcast on this repository line. Optionally wait for a correlated reply.',
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
      description: 'Show this repository line, current identity, agents, and unread count.',
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
