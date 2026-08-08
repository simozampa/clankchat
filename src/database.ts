import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ClankChatError } from './errors.js';

const SCHEMA_VERSION = 1;
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

function ensureSafeParent(databasePath: string): void {
  const parent = path.dirname(databasePath);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new ClankChatError('DATABASE_ERROR', 'Refusing to use a symlinked state directory.', {
      path: parent,
    });
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
    throw new ClankChatError('DATABASE_ERROR', 'Refusing to open a symlinked database.', {
      path: databasePath,
    });
  }
}

export function assertDatabaseRuntimeCompatible(): void {
  const database = new Database(':memory:');
  database.close();
}

export function openDatabase(databasePath: string): Database.Database {
  ensureSafeParent(databasePath);
  try {
    const database = new Database(databasePath, { timeout: 15_000 });
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('busy_timeout = 15000');
    const version = Number(database.pragma('user_version', { simple: true }));
    if (version !== 0 && version !== SCHEMA_VERSION) {
      database.close();
      throw new ClankChatError('DATABASE_ERROR', 'Unsupported clankchat database version.', {
        expected: SCHEMA_VERSION,
        actual: version,
      });
    }
    database.exec(SCHEMA);
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
    return database;
  } catch (error) {
    if (error instanceof ClankChatError) throw error;
    const code = error instanceof Error ? String(Reflect.get(error, 'code') ?? '') : '';
    throw new ClankChatError(
      code.includes('BUSY') || code.includes('LOCKED') ? 'DATABASE_BUSY' : 'DATABASE_ERROR',
      error instanceof Error ? error.message : 'Could not open the clankchat database.',
      { path: databasePath },
    );
  }
}

export function immediateTransaction<T>(database: Database.Database, operation: () => T): T {
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
