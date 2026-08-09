import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_MINIMUM_VERSION,
  codexHooksConfigured,
  codexHooksFeatureEnabled,
  codexVersion,
  codexVersionSupported,
  inspectCodexProject,
} from './codex.js';
import { openDatabase } from './database.js';
import { resolveRepository } from './git.js';
import type { DoctorReport } from './types.js';

export interface DoctorOptions {
  homeDirectory?: string;
  codexFeaturesRunner?: (cwd: string) => { status: number | null; stdout: string; stderr: string };
  codexVersionRunner?: (cwd: string) => { status: number | null; stdout: string; stderr: string };
}

function installedCodexVersion(cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('codex', ['--version'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function installedCodexFeatures(cwd: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('codex', ['features', 'list'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function doctor(cwd = process.cwd(), options: DoctorOptions = {}): DoctorReport {
  const repository = resolveRepository(cwd);
  const database = openDatabase(repository.databasePath);
  try {
    const integrity = String(database.pragma('integrity_check', { simple: true }));
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    const journal = String(database.pragma('journal_mode', { simple: true }));
    const checks: DoctorReport['checks'] = [
      { name: 'integrity', ok: integrity === 'ok', detail: integrity },
      { name: 'foreign-keys', ok: foreignKeys.length === 0, detail: `${foreignKeys.length}` },
      { name: 'journal', ok: journal.toLowerCase() === 'wal', detail: journal },
      {
        name: 'common-directory-state',
        ok: repository.databasePath.startsWith(repository.commonGitDirectory),
        detail: repository.databasePath,
      },
    ];
    const codexProject = inspectCodexProject(repository.root);
    if (codexProject.present) {
      const home = options.homeDirectory ?? os.homedir();
      const codexHome = path.resolve(
        options.homeDirectory !== undefined
          ? path.join(home, '.codex')
          : (process.env.CODEX_HOME ?? path.join(home, '.codex')),
      );
      const hooks = codexHooksConfigured(codexHome);
      const version = (options.codexVersionRunner ?? installedCodexVersion)(repository.root);
      const features = (options.codexFeaturesRunner ?? installedCodexFeatures)(repository.root);
      const parsedVersion = codexVersion(version.stdout);
      checks.push(
        { name: 'codex-mcp', ok: codexProject.configured, detail: codexProject.detail },
        {
          name: 'codex-hooks',
          ok: hooks,
          detail: hooks
            ? `${pathForCodexHooks(codexHome)}; review command trust with Codex /hooks`
            : `missing shared hooks at ${pathForCodexHooks(codexHome)}`,
        },
        {
          name: 'codex-version',
          ok: version.status === 0 && codexVersionSupported(version.stdout),
          detail: parsedVersion ?? (version.stderr.trim() || `requires ${CODEX_MINIMUM_VERSION}+`),
        },
        {
          name: 'codex-hooks-feature',
          ok: features.status === 0 && codexHooksFeatureEnabled(features.stdout),
          detail: codexHooksFeatureEnabled(features.stdout)
            ? 'enabled'
            : features.stderr.trim() || 'disabled',
        },
      );
    }
    return {
      ok: checks.every((check) => check.ok),
      repositoryRoot: repository.root,
      databasePath: repository.databasePath,
      checks,
    };
  } finally {
    database.close();
  }
}

function pathForCodexHooks(codexHome: string): string {
  return path.join(codexHome, 'hooks.json');
}
