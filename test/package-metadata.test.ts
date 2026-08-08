import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function json(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.resolve(relative), 'utf8')) as Record<string, unknown>;
}

describe('package metadata', () => {
  it('aligns the package and Claude plugin', () => {
    const metadata = json('package.json');
    const plugin = json('plugins/clankchat/.claude-plugin/plugin.json');
    expect(metadata).toMatchObject({
      name: 'clankchat',
      version: '0.1.1',
      description: 'comms for your coding agents',
      bin: { clankchat: 'dist/cli.js', 'clankchat-mcp': 'dist/mcp.js' },
    });
    expect(plugin.version).toBe(metadata.version);
    expect(metadata.keywords).toEqual([
      'agent',
      'agents',
      'comms',
      'claude-code',
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
      'clankchat_send',
      'clankchat_reply',
      'clankchat_inbox',
      'clankchat_ack',
      'clankchat_agents',
      'clankchat_status',
      'clankchat_heartbeat',
    ]);
  });

  it('keeps production source under five thousand lines', () => {
    const files = readdirSync('src').filter((file) => file.endsWith('.ts'));
    const lines = files.reduce(
      (total, file) => total + readFileSync(path.join('src', file), 'utf8').split('\n').length,
      0,
    );
    expect(lines).toBeLessThan(5_000);
  });
});
