import { openDatabase } from './database.js';
import { resolveRepository } from './git.js';
import type { DoctorReport } from './types.js';

export function doctor(cwd = process.cwd()): DoctorReport {
  const repository = resolveRepository(cwd);
  const database = openDatabase(repository.databasePath);
  try {
    const integrity = String(database.pragma('integrity_check', { simple: true }));
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    const journal = String(database.pragma('journal_mode', { simple: true }));
    const checks = [
      { name: 'integrity', ok: integrity === 'ok', detail: integrity },
      { name: 'foreign-keys', ok: foreignKeys.length === 0, detail: `${foreignKeys.length}` },
      { name: 'journal', ok: journal.toLowerCase() === 'wal', detail: journal },
      {
        name: 'common-directory-state',
        ok: repository.databasePath.startsWith(repository.commonGitDirectory),
        detail: repository.databasePath,
      },
    ];
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
