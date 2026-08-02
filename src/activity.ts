import { readFileSync } from 'node:fs';

import type { Harness } from './types.js';

function processStartToken(processId: string): string | null {
  if (!/^\d+$/u.test(processId)) return null;
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const started = fields[19];
    return bootId && started ? `${bootId}:${started}` : null;
  } catch {
    return null;
  }
}

/** Distinguish reused OpenCode process IDs where the host exposes process start metadata. */
export function harnessActivityId(
  harness: Harness,
  nativeSession: string | undefined,
): string | undefined {
  if (!nativeSession || harness !== 'opencode') return nativeSession;
  const started = processStartToken(nativeSession);
  return started ? `${nativeSession}:${started}` : undefined;
}
