import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_MINIMUM_VERSION,
  codexHooksConfigured,
  codexHooksFeatureEnabled,
  codexProjectMcpState,
  codexUserConfigured,
  codexUserPresent,
  codexVersion,
  codexVersionSupported,
  inspectCodexProject,
} from './codex.js';
import { openDatabase } from './database.js';
import { type LineScope, resolveLineContext } from './git.js';
import type { DoctorReport } from './types.js';

export interface DoctorOptions {
  scope?: LineScope;
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
  const context = resolveLineContext({
    cwd,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  const database = openDatabase(context.databasePath, { kind: context.scope });
  try {
    const integrityRow = database.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    const integrity = integrityRow?.integrity_check ?? 'missing';
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    const journalRow = database.prepare('PRAGMA journal_mode').get() as
      | { journal_mode: string }
      | undefined;
    const journal = journalRow?.journal_mode ?? 'missing';
    const checks: DoctorReport['checks'] = [
      { name: 'integrity', ok: integrity === 'ok', detail: integrity },
      { name: 'foreign-keys', ok: foreignKeys.length === 0, detail: `${foreignKeys.length}` },
      { name: 'journal', ok: journal.toLowerCase() === 'wal', detail: journal },
      {
        name: 'state-location',
        ok: path.dirname(context.databasePath) === context.stateDirectory,
        detail: context.databasePath,
      },
    ];
    const physicalContext = context.scope === 'repository' ? context : resolveLineContext({ cwd });
    const rootProject =
      physicalContext.scope === 'repository'
        ? inspectCodexProject(physicalContext.root)
        : { present: false, configured: false, detail: '' };
    const projectState =
      physicalContext.scope === 'repository'
        ? codexProjectMcpState(physicalContext.root, realpathSync(cwd))
        : 'absent';
    const codexProject = {
      present: rootProject.present || projectState !== 'absent',
      configured: projectState === 'configured',
      detail:
        rootProject.detail || (physicalContext.scope === 'repository' ? physicalContext.root : ''),
    };
    const home = options.homeDirectory ?? os.homedir();
    const codexHome = path.resolve(
      options.homeDirectory !== undefined
        ? path.join(home, '.codex')
        : (process.env.CODEX_HOME ?? path.join(home, '.codex')),
    );
    const hooks = codexHooksConfigured(codexHome);
    const userMcp = codexUserConfigured(codexHome);
    if (codexProject.present || codexUserPresent(codexHome)) {
      const codexCwd = context.scope === 'repository' ? context.root : cwd;
      const version = (options.codexVersionRunner ?? installedCodexVersion)(codexCwd);
      const features = (options.codexFeaturesRunner ?? installedCodexFeatures)(codexCwd);
      const parsedVersion = codexVersion(version.stdout);
      const mcpConfigured = codexProject.present ? codexProject.configured : userMcp;
      checks.push(
        {
          name: 'codex-mcp',
          ok: mcpConfigured,
          detail: codexProject.present ? codexProject.detail : path.join(codexHome, 'config.toml'),
        },
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
      scope: context.scope,
      repositoryRoot: context.scope === 'repository' ? context.root : null,
      databasePath: context.databasePath,
      checks,
    };
  } finally {
    database.close();
  }
}

function pathForCodexHooks(codexHome: string): string {
  return path.join(codexHome, 'hooks.json');
}
