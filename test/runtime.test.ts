import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installRuntimePath } from '../src/runtime.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('install runtime', () => {
  it('selects a different executable runtime', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'clankchat-runtime-'));
    directories.push(directory);
    const runtime = path.join(directory, 'node');
    const metadata = path.join(directory, '.clankchat-install-runtime.json');
    writeFileSync(runtime, '#!/bin/sh\n');
    chmodSync(runtime, 0o755);
    writeFileSync(metadata, `${JSON.stringify({ runtime })}\n`);
    expect(installRuntimePath(metadata, '/another/node', {})).toBe(runtime);
  });

  it('does not relaunch recursively', () => {
    expect(
      installRuntimePath('/missing', '/node', { CLANKCHAT_INSTALL_RUNTIME_RELAUNCHED: '1' }),
    ).toBeNull();
  });

  it('loads native command implementations only after runtime selection', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    const mcp = readFileSync('src/mcp.ts', 'utf8');
    expect(cli).toContain("await import('./cli-main.js')");
    expect(mcp).toContain("await import('./mcp-server.js')");
    expect(cli).not.toContain("from './line.js'");
    expect(mcp).not.toContain("from './line.js'");
    expect(cli).toContain("process.once('SIGHUP'");
    expect(cli).toContain("process.once('SIGQUIT'");
  });
});
