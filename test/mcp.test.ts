import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatLine } from '../src/line.js';
import { createMcpServer } from '../src/mcp-server.js';
import { directory, repository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const lines: ChatLine[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const line of lines.splice(0)) line.close();
  for (const entry of repositories.splice(0)) entry.cleanup();
});

describe('MCP server', () => {
  it('uses the shared global line outside Git', async () => {
    const first = directory();
    const second = directory();
    const state = directory('clankerchat-mcp-state-');
    repositories.push(first, second, state);
    vi.stubEnv('XDG_STATE_HOME', state.root);
    const created = createMcpServer({ cwd: first.root, agent: 'mcp-agent' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: 'clankerchat_status', arguments: {} });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({ result: { scope: 'global' } });
      const peer = new ChatLine({ cwd: second.root, agent: 'peer' });
      lines.push(peer);
      expect(peer.agents({ includeOffline: true })).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'mcp-agent' })]),
      );
    } finally {
      await client.close();
      created.close();
    }
  });

  it('pins auto scope when the server starts', async () => {
    const outside = directory();
    const state = directory('clankerchat-mcp-state-');
    repositories.push(outside, state);
    vi.stubEnv('XDG_STATE_HOME', state.root);
    const created = createMcpServer({ cwd: outside.root, agent: 'pinned-agent' });
    execFileSync('git', ['init', '--quiet', outside.root]);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const status = await client.callTool({ name: 'clankerchat_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({ result: { scope: 'global' } });
    } finally {
      await client.close();
      created.close();
    }
  });

  it('binds native harness subprocesses to the MCP startup scope', () => {
    vi.useFakeTimers();
    const outside = directory();
    const state = directory('clankerchat-mcp-state-');
    repositories.push(outside, state);
    vi.stubEnv('XDG_STATE_HOME', state.root);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'native-session');
    const created = createMcpServer({
      cwd: outside.root,
      harness: 'claude-code',
      agent: 'claude-native-session',
    });
    const binding = path.join(
      state.root,
      'clankerchat',
      'harness-bindings',
      'claude-code-native-session.binding',
    );
    const initial = readFileSync(binding, 'utf8').split('\n');
    expect(initial[0]?.split('\t')[1]).toBe('global');
    expect(Buffer.from(initial[1] ?? '', 'base64').toString('utf8')).toContain(
      '/clankerchat/state.sqlite3',
    );
    vi.advanceTimersByTime(30_000);
    const renewed = readFileSync(binding, 'utf8').split('\n');
    expect(Number(renewed[0]?.split('\t')[3])).toBeGreaterThan(Number(initial[0]?.split('\t')[3]));
    execFileSync('git', ['init', '--quiet', outside.root]);
    expect(() =>
      createMcpServer({
        cwd: outside.root,
        harness: 'claude-code',
        agent: 'claude-native-session',
      }),
    ).toThrow(/already bound/u);
    created.close();
    expect(existsSync(binding)).toBe(true);
    expect(() =>
      createMcpServer({
        cwd: outside.root,
        harness: 'claude-code',
        agent: 'claude-native-session',
      }),
    ).toThrow(/already bound/u);
    writeFileSync(
      binding,
      `1\tglobal\t2147483647\t${Date.now() + 90_000}\t00000000-0000-0000-0000-000000000000\n${Buffer.from(path.join(state.root, 'stale.sqlite3')).toString('base64')}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      createMcpServer({
        cwd: outside.root,
        harness: 'claude-code',
        agent: 'claude-native-session',
      }),
    ).toThrow(/already bound/u);
    writeFileSync(
      binding,
      `1\tglobal\t2147483647\t${Date.now() - 30_001}\t00000000-0000-0000-0000-000000000000\n${Buffer.from(path.join(state.root, 'stale.sqlite3')).toString('base64')}\n`,
      { mode: 0o600 },
    );
    const replacement = createMcpServer({
      cwd: outside.root,
      harness: 'claude-code',
      agent: 'claude-native-session',
    });
    expect(readFileSync(binding, 'utf8').split('\n')[0]?.split('\t')[1]).toBe('repository');
    replacement.close();
    expect(existsSync(binding)).toBe(true);
  });

  it('uses Codex request metadata for the same identity as hooks', async () => {
    const createdRepository = repository();
    repositories.push(createdRepository);
    vi.stubEnv('CLANKERCHAT_CODEX', '1');
    vi.stubEnv('CODEX_HOME', `${createdRepository.root}/.test-codex-home`);
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
    vi.stubEnv('CODEX_HOME', `${createdRepository.root}/.test-codex-home`);
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
