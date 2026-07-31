import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { SameTreeError } from './errors.js';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

/** Refuse writes through symlinks, even when the resolved target remains inside the repository. */
export function assertSafeWritePath(repositoryRoot: string, target: string): string {
  const root = realpathSync(repositoryRoot);
  const absolute = path.resolve(root, target);
  if (!isInside(root, absolute)) {
    throw new SameTreeError('INVALID_INPUT', 'A generated path cannot leave the repository.', {
      path: target,
    });
  }

  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SameTreeError('INVALID_INPUT', 'Refusing to write through a symbolic link.', {
          path: current,
        });
      }
    } catch (error) {
      if (error instanceof SameTreeError) throw error;
      const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
      if (code === 'ENOENT') break;
      throw error;
    }
  }
  return absolute;
}
