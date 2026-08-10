import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClankChatError, ClankerChatError, isClankChatError } from '../src/index.js';

function json(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve(relative), 'utf8')) as Record<string, unknown>;
}

describe('package metadata', () => {
  it('aligns the package and Claude plugin', () => {
    const metadata = json('package.json');
    const marketplace = json('.claude-plugin/marketplace.json');
    const plugin = json('plugins/clankerchat/.claude-plugin/plugin.json');
    expect(metadata).toMatchObject({
      name: 'clankerchat',
      version: '0.1.1',
      description: 'comms for your coding agents',
      bin: { clankerchat: 'dist/cli.js', 'clankerchat-mcp': 'dist/mcp.js' },
    });
    expect(plugin.version).toBe(metadata.version);
    expect(marketplace).toMatchObject({
      name: 'clankerchat',
      plugins: [{ name: 'clankerchat', source: './plugins/clankerchat' }],
    });
    expect(metadata.keywords).toEqual([
      'agent',
      'agents',
      'comms',
      'claude-code',
      'codex',
      'opencode',
      'mcp',
      'mcp-server',
      'multi-agent',
    ]);
  });

  it('exposes exactly seven MCP tools', () => {
    const source = readFileSync('src/mcp-server.ts', 'utf8');
    const tools = [...source.matchAll(/server\.registerTool\(\s*'([^']+)'/gu)].map(
      (match) => match[1],
    );
    expect(tools).toEqual([
      'clankerchat_send',
      'clankerchat_reply',
      'clankerchat_inbox',
      'clankerchat_ack',
      'clankerchat_agents',
      'clankerchat_status',
      'clankerchat_heartbeat',
    ]);
  });

  it('keeps production source under six thousand lines', () => {
    const files = readdirSync('src').filter((file) => file.endsWith('.ts'));
    const lines = files.reduce(
      (total, file) => total + readFileSync(path.join('src', file), 'utf8').split('\n').length,
      0,
    );
    expect(lines).toBeLessThan(6_000);
  });

  it('keeps old error exports as aliases during package migration', () => {
    const error = new ClankerChatError('INVALID_INPUT', 'test');
    expect(ClankChatError).toBe(ClankerChatError);
    expect(isClankChatError(error)).toBe(true);
  });
});
