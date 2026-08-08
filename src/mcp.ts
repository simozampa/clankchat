#!/usr/bin/env node
import { writeSync } from 'node:fs';

import { errorResult } from './errors.js';
import { runWithInstallRuntime } from './runtime.js';

const relaunched = await runWithInstallRuntime();
if (relaunched !== null) process.exit(relaunched);

try {
  const { runMcp } = await import('./mcp-server.js');
  await runMcp();
} catch (error) {
  writeSync(process.stderr.fd, `${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
}
