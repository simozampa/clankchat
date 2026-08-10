import type { Stats } from 'node:fs';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ClankerChatError } from './errors.js';

const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  Reflect.apply(emitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;
const { DatabaseSync: NodeDatabaseSync } = await import('node:sqlite').finally(() => {
  process.emitWarning = emitWarning;
});

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 15_000;
const REPOSITORY_APPLICATION_ID = 0x434c_4e4b;
const GLOBAL_APPLICATION_ID = 0x434c_474c;
const busyWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'opencode', 'other')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE RESTRICT,
  harness TEXT NOT NULL CHECK (harness IN ('claude-code', 'opencode', 'other')),
  process_id INTEGER,
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_agent_expiry ON sessions(agent_name, expires_at);

CREATE TABLE IF NOT EXISTS presence_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'request', 'reply')),
  correlation_id TEXT,
  reply_to TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  sender TEXT NOT NULL REFERENCES agents(name) ON DELETE RESTRICT,
  recipient TEXT REFERENCES agents(name) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  source_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (kind <> 'reply' OR reply_to IS NOT NULL),
  CHECK (kind = 'reply' OR reply_to IS NULL),
  CHECK (kind = 'message' OR correlation_id IS NOT NULL),
  CHECK (kind <> 'request' OR recipient IS NOT NULL),
  CHECK (kind <> 'reply' OR recipient IS NOT NULL),
  CHECK (pinned = 0 OR (kind = 'message' AND recipient IS NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_one_reply ON messages(reply_to)
  WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_correlation ON messages(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL REFERENCES agents(name) ON DELETE RESTRICT,
  scope TEXT NOT NULL DEFAULT '',
  reserved_by_session TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  reservation_token TEXT,
  reserved_at INTEGER,
  delivered_at INTEGER,
  read_at INTEGER,
  PRIMARY KEY (message_id, agent_name, scope),
  CHECK ((reserved_by_session IS NULL) = (reserved_at IS NULL)),
  CHECK ((reserved_by_session IS NULL) = (reservation_token IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS recipients_pending
  ON message_recipients(agent_name, read_at, delivered_at, message_id);
CREATE UNIQUE INDEX IF NOT EXISTS recipients_reservation_token
  ON message_recipients(reservation_token) WHERE reservation_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS reply_waiters (
  request_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;

function pathState(target: string): Stats | null {
  try {
    return lstatSync(target) as Stats;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null;
    throw error;
  }
}

export type DatabaseKind = 'repository' | 'global';

function assertPrivateState(target: string, state: Stats): void {
  const userId = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    state.isSymbolicLink() ||
    (userId !== null && state.uid !== userId) ||
    (!state.isDirectory() && state.nlink !== 1) ||
    (state.mode & 0o777) !== (state.isDirectory() ? 0o700 : 0o600)
  ) {
    throw new ClankerChatError('DATABASE_ERROR', 'Global state permissions are unsafe.', {
      path: target,
    });
  }
}

function assertSafeGlobalRoot(target: string, state: Stats): void {
  const userId = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (userId !== null && state.uid !== userId) ||
    (state.mode & 0o022) !== 0
  ) {
    throw new ClankerChatError('DATABASE_ERROR', 'Global state root permissions are unsafe.', {
      path: target,
    });
  }
}

function ensureSafeParent(databasePath: string, kind: DatabaseKind): boolean {
  const parent = path.dirname(databasePath);
  if (kind === 'global') {
    const root = path.dirname(parent);
    if (pathState(root)?.isSymbolicLink()) {
      throw new ClankerChatError('DATABASE_ERROR', 'Refusing to use a symlinked state root.', {
        path: root,
      });
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertSafeGlobalRoot(root, lstatSync(root));
  }
  if (pathState(parent)?.isSymbolicLink()) {
    throw new ClankerChatError('DATABASE_ERROR', 'Refusing to use a symlinked state directory.', {
      path: parent,
    });
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentState = lstatSync(parent);
  if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
    throw new ClankerChatError('DATABASE_ERROR', 'The state path is not a regular directory.', {
      path: parent,
    });
  }
  if (kind === 'global') assertPrivateState(parent, parentState);
  let databaseState = pathState(databasePath);
  if (databaseState && (!databaseState.isFile() || databaseState.isSymbolicLink())) {
    throw new ClankerChatError('DATABASE_ERROR', 'Refusing to open a non-regular database.', {
      path: databasePath,
    });
  }
  let created = false;
  if (kind === 'global' && !databaseState) {
    try {
      closeSync(openSync(databasePath, 'wx', 0o600));
      created = true;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'EEXIST') throw error;
    }
    databaseState = lstatSync(databasePath);
  }
  if (kind === 'global' && databaseState) assertPrivateState(databasePath, databaseState);
  for (const suffix of ['-journal', '-shm', '-wal']) {
    const sidecar = `${databasePath}${suffix}`;
    const sidecarState = pathState(sidecar);
    if (sidecarState && (!sidecarState.isFile() || sidecarState.isSymbolicLink())) {
      throw new ClankerChatError(
        'DATABASE_ERROR',
        'Refusing to use a non-regular SQLite sidecar.',
        {
          path: sidecar,
        },
      );
    }
    if (kind === 'global' && sidecarState) assertPrivateState(sidecar, sidecarState);
  }
  return created;
}

export function assertGlobalStateSafe(databasePath: string): void {
  ensureSafeParent(databasePath, 'global');
}

export function assertDatabaseRuntimeCompatible(): void {
  const database = new NodeDatabaseSync(':memory:');
  database.close();
}

export type ChatDatabase = DatabaseSync;

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return Number(row?.[name]);
}

interface CatalogEntry {
  type: string;
  name: string;
  table: string;
  sql: string;
}

function catalog(database: DatabaseSync): CatalogEntry[] {
  return database
    .prepare(
      `SELECT type, name, tbl_name AS [table], sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as unknown as CatalogEntry[];
}

const expectedDatabase = new NodeDatabaseSync(':memory:');
expectedDatabase.exec(SCHEMA);
const EXPECTED_CATALOG = catalog(expectedDatabase);
expectedDatabase.close();

function inspectOwnership(
  database: DatabaseSync,
  expectedApplicationId: number,
  kind: DatabaseKind,
): { applicationId: number; version: number } {
  const version = pragmaNumber(database, 'user_version');
  const applicationId = pragmaNumber(database, 'application_id');
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new ClankerChatError('DATABASE_ERROR', 'Unsupported clankerchat database version.', {
      expected: SCHEMA_VERSION,
      actual: version,
    });
  }
  if (applicationId !== 0 && applicationId !== expectedApplicationId) {
    throw new ClankerChatError('DATABASE_ERROR', 'The state file belongs to another application.');
  }
  const actualCatalog = catalog(database);
  if (version === 0 && actualCatalog.length > 0) {
    throw new ClankerChatError('DATABASE_ERROR', 'Refusing to claim a nonempty SQLite database.');
  }
  if (
    version === SCHEMA_VERSION &&
    JSON.stringify(actualCatalog) !== JSON.stringify(EXPECTED_CATALOG)
  ) {
    throw new ClankerChatError('DATABASE_ERROR', 'The state file is not a clankerchat database.');
  }
  if (kind === 'global' && version === SCHEMA_VERSION && applicationId === 0) {
    throw new ClankerChatError(
      'DATABASE_ERROR',
      'The state file is not a global clankerchat line.',
    );
  }
  return { applicationId, version };
}

function inspectOwnershipSnapshot(
  database: DatabaseSync,
  applicationId: number,
  kind: DatabaseKind,
): { applicationId: number; version: number } {
  database.exec('BEGIN');
  try {
    const ownership = inspectOwnership(database, applicationId, kind);
    database.exec('COMMIT');
    return ownership;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function isBusyError(error: unknown): boolean {
  const code = error instanceof Error ? String(Reflect.get(error, 'code') ?? '') : '';
  const message = error instanceof Error ? error.message : '';
  return code.includes('BUSY') || code.includes('LOCKED') || /busy|locked/iu.test(message);
}

function withBusyRetry<T>(operation: () => T): T {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || Date.now() >= deadline) throw error;
      Atomics.wait(busyWait, 0, 0, 25);
    }
  }
}

export function openDatabase(
  databasePath: string,
  options: { kind?: DatabaseKind } = {},
): DatabaseSync {
  const kind = options.kind ?? 'repository';
  const applicationId = kind === 'global' ? GLOBAL_APPLICATION_ID : REPOSITORY_APPLICATION_ID;
  const created = ensureSafeParent(databasePath, kind);
  let database: DatabaseSync | null = null;
  let phase = 'preflight';
  try {
    if (!created && pathState(databasePath)) {
      phase = 'preflight-open';
      const readOnly = withBusyRetry(() => new NodeDatabaseSync(databasePath, { readOnly: true }));
      try {
        readOnly.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        phase = 'preflight-inspect';
        withBusyRetry(() => inspectOwnershipSnapshot(readOnly, applicationId, kind));
      } finally {
        readOnly.close();
      }
    }
    phase = 'open';
    const activeDatabase = withBusyRetry(() => new NodeDatabaseSync(databasePath));
    database = activeDatabase;
    activeDatabase.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    phase = 'inspect';
    withBusyRetry(() => inspectOwnershipSnapshot(activeDatabase, applicationId, kind));
    phase = 'pragmas';
    activeDatabase.exec('PRAGMA foreign_keys = ON');
    phase = 'journal';
    withBusyRetry(() => activeDatabase.exec('PRAGMA journal_mode = WAL'));
    phase = 'pragmas';
    activeDatabase.exec('PRAGMA synchronous = FULL');
    phase = 'transaction';
    activeDatabase.exec('BEGIN IMMEDIATE');
    try {
      const ownership = inspectOwnership(activeDatabase, applicationId, kind);
      if (ownership.version === 0) {
        activeDatabase.exec(SCHEMA);
        activeDatabase.exec(
          `PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${SCHEMA_VERSION};`,
        );
      } else if (ownership.applicationId === 0) {
        activeDatabase.exec(`PRAGMA application_id = ${applicationId}`);
      }
      activeDatabase.exec('COMMIT');
    } catch (error) {
      activeDatabase.exec('ROLLBACK');
      throw error;
    }
    if (kind === 'global') ensureSafeParent(databasePath, kind);
    return activeDatabase;
  } catch (error) {
    try {
      database?.close();
    } catch {}
    if (error instanceof ClankerChatError) throw error;
    const message =
      error instanceof Error ? error.message : 'Could not open the clankerchat database.';
    throw new ClankerChatError(isBusyError(error) ? 'DATABASE_BUSY' : 'DATABASE_ERROR', message, {
      path: databasePath,
      phase,
    });
  }
}

export function immediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
