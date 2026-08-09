import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatLine } from '../src/line.js';
import { createMcpServer } from '../src/mcp-server.js';
import { repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const lines: ChatLine[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const line of lines.splice(0)) line.close();
  for (const entry of repositories.splice(0)) entry.cleanup();
});

describe('MCP server', () => {
  it('uses Codex request metadata for the same identity as hooks', async () => {
    const createdRepository = repository();
    repositories.push(createdRepository);
    vi.stubEnv('CLANKERCHAT_CODEX', '1');
    const created = createMcpServer({ cwd: createdRepository.root });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({
        name: 'clankerchat_status',
        arguments: {},
        _meta: { threadId: 'session-one' },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        result: { agent: { name: 'codex-session-one', harness: 'other' } },
      });

      const sender = new ChatLine({ cwd: createdRepository.root, agent: 'sender' });
      lines.push(sender);
      const request = sender.request({ to: 'codex-session-one', body: 'Which port?' });
      const reply = await client.callTool({
        name: 'clankerchat_reply',
        arguments: { messageId: request.id, body: '8080' },
        _meta: { threadId: 'session-one' },
      });
      expect(reply.isError).not.toBe(true);
      expect(sender.inbox()).toEqual([
        expect.objectContaining({ body: '8080', replyTo: request.id }),
      ]);
    } finally {
      await client.close();
      created.close();
    }
  });

  it('does not create a fallback Codex identity without thread metadata', async () => {
    const createdRepository = repository();
    repositories.push(createdRepository);
    vi.stubEnv('CLANKERCHAT_CODEX', '1');
    const created = createMcpServer({ cwd: createdRepository.root });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: 'clankerchat_status', arguments: {} });
      expect(status.isError).toBe(true);
      const observer = new ChatLine({ cwd: createdRepository.root, agent: 'observer' });
      lines.push(observer);
      expect(observer.agents({ includeOffline: true }).map((agent) => agent.name)).toEqual([
        'observer',
      ]);
    } finally {
      await client.close();
      created.close();
    }
  });
});
