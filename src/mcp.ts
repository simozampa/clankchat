#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { writeSync } from 'node:fs';

import { errorResult } from './errors.js';

try {
  const { runMcp } = await import('./mcp-server.js');
  await runMcp();
} catch (error) {
  writeSync(process.stderr.fd, `${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
}
