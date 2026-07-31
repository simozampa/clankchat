import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertSafeWritePath } from '../src/paths.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('generated path safety', () => {
  it('accepts repository-relative paths', () => {
    const root = temporaryDirectory('sametree-path-');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'index.ts'), '');

    expect(assertSafeWritePath(root, './src/../src/index.ts')).toBe(
      path.join(root, 'src', 'index.ts'),
    );
  });

  it('rejects traversal and symbolic links', () => {
    const root = temporaryDirectory('sametree-root-');
    const outside = temporaryDirectory('sametree-outside-');
    symlinkSync(outside, path.join(root, 'escaped'));

    expect(() => assertSafeWritePath(root, '../outside.ts')).toThrow(/cannot leave/u);
    expect(() => assertSafeWritePath(root, 'escaped/new.ts')).toThrow(/symbolic link/u);
  });
});
