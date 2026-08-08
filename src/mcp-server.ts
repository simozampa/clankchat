import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { agentIdentity, detectHarness } from './activity.js';
import { errorResult } from './errors.js';
import { ChatLine } from './line.js';
import type { Harness } from './types.js';
import { VERSION } from './version.js';

const outputSchema = { result: z.unknown() };

function response(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: { result: value },
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpServer(
  options: { cwd?: string; agent?: string; harness?: Harness } = {},
): { line: ChatLine; server: McpServer } {
  const harness = options.harness ?? detectHarness();
  const line = new ChatLine({
    cwd:
      options.cwd ?? process.env.CLANKCHAT_CWD ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    agent: options.agent ?? agentIdentity(harness),
    harness,
  });
  const server = new McpServer({ name: 'clankchat', version: VERSION });

  function execute(operation: () => unknown) {
    try {
      line.heartbeat();
      return response(operation());
    } catch (error) {
      return response(errorResult(error), true);
    }
  }

  async function executeAsync(operation: () => Promise<unknown>) {
    try {
      line.heartbeat();
      return response(await operation());
    } catch (error) {
      return response(errorResult(error), true);
    }
  }

  server.registerTool(
    'clankchat_send',
    {
      title: 'Send a clankchat message',
      description:
        'Send directly to one agent or broadcast on this repository line. Optionally wait for a correlated reply.',
      inputSchema: {
        body: z.string().min(1).max(50_000),
        to: z.string().min(1).max(80).optional(),
        awaitReply: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
        pinned: z.boolean().optional(),
      },
      outputSchema,
    },
    ({ body, to, awaitReply, timeoutMs, pinned }, { signal }) => {
      if (awaitReply) {
        return executeAsync(async () => {
          if (!to) throw new Error('awaitReply requires a direct recipient.');
          return await line.requestAndAwait({
            to,
            body,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            signal,
          });
        });
      }
      return execute(() =>
        line.send({
          body,
          ...(to ? { to } : {}),
          ...(pinned ? { pinned: true } : {}),
        }),
      );
    },
  );

  server.registerTool(
    'clankchat_reply',
    {
      title: 'Reply to a clankchat request',
      description: 'Reply to a direct request using the request message ID.',
      inputSchema: {
        messageId: z.string().min(1).max(100),
        body: z.string().min(1).max(50_000),
      },
      outputSchema,
    },
    ({ messageId, body }) => execute(() => line.reply({ toMessage: messageId, body })),
  );

  server.registerTool(
    'clankchat_inbox',
    {
      title: 'Read clankchat messages',
      description: 'Read direct messages and broadcasts for this agent.',
      inputSchema: {
        unreadOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ unreadOnly, limit }) =>
      execute(() =>
        line.inbox({
          ...(unreadOnly === undefined ? {} : { unreadOnly }),
          ...(limit === undefined ? {} : { limit }),
        }),
      ),
  );

  server.registerTool(
    'clankchat_ack',
    {
      title: 'Mark clankchat messages read',
      description: 'Idempotently mark messages read by this agent.',
      inputSchema: { messageIds: z.array(z.string().min(1).max(100)).min(1).max(1_000) },
      outputSchema,
      annotations: { idempotentHint: true },
    },
    ({ messageIds }) => execute(() => ({ acknowledged: line.acknowledge(messageIds) })),
  );

  server.registerTool(
    'clankchat_agents',
    {
      title: 'List agents on this line',
      description: 'List agent names, harnesses, online state, and last-seen times.',
      inputSchema: { includeOffline: z.boolean().optional() },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ includeOffline }) => execute(() => line.agents({ includeOffline: includeOffline ?? false })),
  );

  server.registerTool(
    'clankchat_status',
    {
      title: 'Show clankchat status',
      description: 'Show this repository line, current identity, agents, and unread count.',
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    () => execute(() => line.status()),
  );

  server.registerTool(
    'clankchat_heartbeat',
    {
      title: 'Renew clankchat session',
      description: 'Renew this agent session after idle time or system sleep.',
      outputSchema,
      annotations: { idempotentHint: true },
    },
    () => execute(() => line.heartbeat()),
  );

  return { line, server };
}

export async function runMcp(): Promise<void> {
  const { line, server } = createMcpServer();
  const close = () => {
    try {
      line.close();
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
  await server.connect(new StdioServerTransport());
}
