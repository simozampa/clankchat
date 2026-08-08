import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { immediateTransaction, openDatabase } from './database.js';
import { ClankChatError } from './errors.js';
import { type RepositoryContext, resolveRepository } from './git.js';
import type { Agent, ChatEvent, Harness, LineStatus, Message, Session } from './types.js';

const DEFAULT_SESSION_TTL_SECONDS = 90;
const DEFAULT_REPLY_TIMEOUT_MS = 30_000;
const MAX_BODY_LENGTH = 50_000;

interface AgentRow {
  name: string;
  harness: Harness;
  first_seen_at: number;
  last_seen_at: number;
  online: number;
  sessions: number;
}

interface SessionRow {
  id: string;
  agent_name: string;
  harness: Harness;
  process_id: number | null;
  started_at: number;
  last_heartbeat_at: number;
  expires_at: number;
  closed_at: number | null;
}

interface MessageRow {
  id: string;
  kind: 'message' | 'request' | 'reply';
  correlation_id: string | null;
  reply_to: string | null;
  sender: string;
  recipient: string | null;
  body: string;
  pinned: number;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

interface EventRow {
  sequence: number;
  kind: string;
  actor: string;
  message_id: string | null;
  payload: string;
  created_at: number;
}

interface ReplyRow extends MessageRow {
  reserved_by_session: string | null;
  owner_closed_at: number | null;
  owner_expires_at: number | null;
}

function identifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function bounded(value: string, name: string, maximum = MAX_BODY_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new ClankChatError('INVALID_INPUT', `${name} must contain 1-${maximum} characters.`);
  }
  return value;
}

function replyTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new ClankChatError('INVALID_INPUT', 'Reply timeout must be 1-3600000 milliseconds.');
  }
  return value;
}

export function validateAgentName(value: string): string {
  const name = bounded(value.trim(), 'Agent name', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new ClankChatError(
      'INVALID_INPUT',
      'Agent names may contain letters, numbers, dots, underscores, and hyphens.',
    );
  }
  return name;
}

function toAgent(row: AgentRow): Agent {
  return {
    name: row.name,
    harness: row.harness,
    online: row.online > 0,
    sessions: row.sessions,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    agentName: row.agent_name,
    harness: row.harness,
    processId: row.process_id,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    kind: row.kind,
    correlationId: row.correlation_id,
    replyTo: row.reply_to,
    sender: row.sender,
    recipient: row.recipient,
    body: row.body,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
  };
}

function toEvent(row: EventRow): ChatEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {}
  return {
    sequence: row.sequence,
    kind: row.kind,
    actor: row.actor,
    messageId: row.message_id,
    payload,
    createdAt: row.created_at,
  };
}

export interface LineOptions {
  cwd?: string;
  agent: string;
  harness?: Harness;
  processId?: number | null;
  sessionId?: string;
  sessionTtlSeconds?: number;
  now?: () => number;
}

export class ChatLine {
  readonly repository: RepositoryContext;
  readonly database: Database.Database;
  readonly agentName: string;
  readonly harness: Harness;
  readonly sessionTtlSeconds: number;
  #sessionId: string;
  #resumeSessionId: string | undefined;
  #now: () => number;
  #closed = false;
  #reservations = new Map<string, string>();

  constructor(options: LineOptions) {
    this.repository = resolveRepository(options.cwd);
    this.database = openDatabase(this.repository.databasePath);
    this.agentName = validateAgentName(options.agent);
    this.harness = options.harness ?? 'other';
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.#now = options.now ?? Date.now;
    this.#resumeSessionId = options.sessionId;
    this.#sessionId = this.#startSession(options.processId ?? process.pid, options.sessionId);
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #recordEvent(
    kind: string,
    actorName: string,
    messageId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        'INSERT INTO events(kind, actor, message_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(kind, actorName, messageId, JSON.stringify(payload), this.#now());
  }

  #startSession(processId: number | null, preferredId?: string): string {
    const now = this.#now();
    const sessionId = preferredId ? bounded(preferredId, 'Session ID', 120) : identifier('session');
    immediateTransaction(this.database, () => {
      const existing = this.database
        .prepare('SELECT name FROM agents WHERE name = ?')
        .get(this.agentName);
      const previousSession = this.database
        .prepare('SELECT agent_name, harness FROM sessions WHERE id = ?')
        .get(sessionId) as { agent_name: string; harness: Harness } | undefined;
      if (
        previousSession &&
        (previousSession.agent_name !== this.agentName || previousSession.harness !== this.harness)
      ) {
        throw new ClankChatError('MESSAGE_CONFLICT', 'The session ID belongs to another agent.');
      }
      this.database
        .prepare(
          `INSERT INTO agents(name, harness, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             harness = excluded.harness,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(this.agentName, this.harness, now, now);
      this.database
        .prepare(
          `INSERT INTO sessions(
              id, agent_name, harness, process_id, started_at, last_heartbeat_at, expires_at, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
              process_id = excluded.process_id,
              last_heartbeat_at = excluded.last_heartbeat_at,
              expires_at = excluded.expires_at,
              closed_at = NULL`,
        )
        .run(
          sessionId,
          this.agentName,
          this.harness,
          processId,
          now,
          now,
          now + this.sessionTtlSeconds * 1_000,
        );
      if (previousSession) {
        this.database
          .prepare(
            `UPDATE message_recipients
             SET reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
             WHERE reserved_by_session = ? AND delivered_at IS NULL`,
          )
          .run(sessionId);
        this.database.prepare('DELETE FROM reply_waiters WHERE session_id = ?').run(sessionId);
      }
      this.database
        .prepare(
          `INSERT OR IGNORE INTO message_recipients(message_id, agent_name, scope)
           SELECT messages.id, ?, ? FROM messages
           WHERE messages.pinned = 1`,
        )
        .run(this.agentName, sessionId);
      if (!existing)
        this.#recordEvent('agent.joined', this.agentName, null, { harness: this.harness });
      this.#recordEvent('session.started', this.agentName, null, { harness: this.harness });
    });
    return sessionId;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new ClankChatError('SESSION_EXPIRED', 'This chat line is closed.');
  }

  heartbeat(): Session {
    this.#ensureOpen();
    const now = this.#now();
    const result = this.database
      .prepare(
        `UPDATE sessions
         SET last_heartbeat_at = ?, expires_at = ?
         WHERE id = ? AND closed_at IS NULL AND expires_at >= ?`,
      )
      .run(now, now + this.sessionTtlSeconds * 1_000, this.#sessionId, now);
    if (result.changes === 0) {
      this.#sessionId = this.#startSession(process.pid, this.#resumeSessionId);
    }
    this.database
      .prepare('UPDATE agents SET last_seen_at = ? WHERE name = ?')
      .run(now, this.agentName);
    return this.currentSession();
  }

  currentSession(): Session {
    const row = this.database.prepare('SELECT * FROM sessions WHERE id = ?').get(this.#sessionId) as
      | SessionRow
      | undefined;
    if (!row) throw new ClankChatError('SESSION_EXPIRED', 'The current session no longer exists.');
    return toSession(row);
  }

  close(): void {
    if (this.#closed) return;
    immediateTransaction(this.database, () => {
      this.database
        .prepare('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
        .run(this.#now(), this.#sessionId);
      this.database
        .prepare(
          `UPDATE message_recipients
           SET reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
           WHERE reserved_by_session = ? AND delivered_at IS NULL`,
        )
        .run(this.#sessionId);
      const release = this.database.prepare(
        `UPDATE message_recipients
         SET reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
         WHERE reservation_token = ? AND delivered_at IS NULL`,
      );
      for (const token of this.#reservations.values()) release.run(token);
      this.database.prepare('DELETE FROM reply_waiters WHERE session_id = ?').run(this.#sessionId);
    });
    this.#reservations.clear();
    this.#closed = true;
    this.database.close();
  }

  agents(options: { includeOffline?: boolean } = {}): Agent[] {
    this.heartbeat();
    const now = this.#now();
    const rows = this.database
      .prepare(
        `SELECT agents.*,
           SUM(CASE WHEN sessions.closed_at IS NULL AND sessions.expires_at >= ? THEN 1 ELSE 0 END)
             AS sessions,
           MAX(CASE WHEN sessions.closed_at IS NULL AND sessions.expires_at >= ? THEN 1 ELSE 0 END)
             AS online
         FROM agents LEFT JOIN sessions ON sessions.agent_name = agents.name
         GROUP BY agents.name
         ${options.includeOffline ? '' : 'HAVING online = 1'}
         ORDER BY agents.last_seen_at DESC, agents.name`,
      )
      .all(now, now) as AgentRow[];
    return rows.map(toAgent);
  }

  #requireAgent(name: string): void {
    const found = this.database.prepare('SELECT 1 FROM agents WHERE name = ?').get(name);
    if (!found) throw new ClankChatError('AGENT_NOT_FOUND', `Agent ${name} is not on this line.`);
  }

  #insertMessage(input: {
    kind: 'message' | 'request' | 'reply';
    to?: string;
    body: string;
    pinned?: boolean;
    correlationId?: string;
    replyTo?: string;
    sourceKey?: string;
    waiterExpiresAt?: number;
  }): Message {
    this.heartbeat();
    const body = bounded(input.body, 'Message');
    const recipient = input.to ? validateAgentName(input.to) : null;
    if (recipient) this.#requireAgent(recipient);
    if (input.pinned && recipient) {
      throw new ClankChatError('INVALID_INPUT', 'Only broadcasts can be pinned.');
    }
    const id = identifier('message');
    const createdAt = this.#now();
    const correlationId = input.correlationId ?? null;
    return immediateTransaction(this.database, () => {
      const existing = input.sourceKey
        ? (this.database
            .prepare(
              `SELECT messages.*, NULL AS delivered_at, NULL AS read_at
               FROM messages WHERE source_key = ?`,
            )
            .get(input.sourceKey) as MessageRow | undefined)
        : undefined;
      if (existing) {
        if (
          existing.sender !== this.agentName ||
          existing.kind !== input.kind ||
          existing.recipient !== recipient ||
          existing.body !== body ||
          existing.pinned !== (input.pinned ? 1 : 0) ||
          existing.reply_to !== (input.replyTo ?? null)
        ) {
          throw new ClankChatError(
            'MESSAGE_CONFLICT',
            'The source key already names another message.',
          );
        }
        return toMessage(existing);
      }

      this.database
        .prepare(
          `INSERT INTO messages(
             id, kind, correlation_id, reply_to, sender, recipient, body, pinned, source_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          correlationId,
          input.replyTo ?? null,
          this.agentName,
          recipient,
          body,
          input.pinned ? 1 : 0,
          input.sourceKey ?? null,
          createdAt,
        );
      if (recipient) {
        this.database
          .prepare('INSERT INTO message_recipients(message_id, agent_name, scope) VALUES (?, ?, ?)')
          .run(id, recipient, '');
      } else if (input.pinned) {
        this.database
          .prepare(
            `INSERT INTO message_recipients(message_id, agent_name, scope)
             SELECT ?, sessions.agent_name, sessions.id FROM sessions
             WHERE sessions.closed_at IS NULL AND sessions.expires_at >= ?
                AND sessions.id <> ?`,
          )
          .run(id, createdAt, this.#sessionId);
      } else {
        this.database
          .prepare(
            `INSERT INTO message_recipients(message_id, agent_name, scope)
             SELECT ?, name, '' FROM agents WHERE name <> ?`,
          )
          .run(id, this.agentName);
      }
      if (input.waiterExpiresAt !== undefined) {
        this.database
          .prepare('INSERT INTO reply_waiters(request_id, session_id, expires_at) VALUES (?, ?, ?)')
          .run(id, this.#sessionId, input.waiterExpiresAt);
      }
      const kind =
        input.kind === 'request'
          ? 'message.requested'
          : input.kind === 'reply'
            ? 'message.replied'
            : input.pinned
              ? 'message.pinned'
              : 'message.sent';
      this.#recordEvent(kind, this.agentName, id, {
        recipient,
        body,
        correlationId,
        replyTo: input.replyTo ?? null,
      });
      return {
        id,
        kind: input.kind,
        correlationId,
        replyTo: input.replyTo ?? null,
        sender: this.agentName,
        recipient,
        body,
        pinned: input.pinned ?? false,
        createdAt,
        deliveredAt: null,
        readAt: null,
      };
    });
  }

  send(input: { to?: string; body: string; pinned?: boolean; sourceKey?: string }): Message {
    return this.#insertMessage({ kind: 'message', ...input });
  }

  request(input: { to: string; body: string; sourceKey?: string }): Message {
    return this.#insertMessage({
      kind: 'request',
      to: input.to,
      body: input.body,
      correlationId: identifier('correlation'),
      ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
    });
  }

  reply(input: { toMessage: string; body: string; sourceKey?: string }): Message {
    this.heartbeat();
    const request = this.database
      .prepare(
        `SELECT messages.*, NULL AS delivered_at, NULL AS read_at
         FROM messages WHERE id = ?`,
      )
      .get(input.toMessage) as MessageRow | undefined;
    if (!request) throw new ClankChatError('MESSAGE_NOT_FOUND', 'The request does not exist.');
    if (request.kind !== 'request' || request.recipient !== this.agentName) {
      throw new ClankChatError('REPLY_NOT_ALLOWED', 'Only the request recipient can reply.');
    }
    const existing = this.database
      .prepare('SELECT id FROM messages WHERE reply_to = ?')
      .get(request.id);
    if (existing) throw new ClankChatError('REPLY_EXISTS', 'This request already has a reply.');
    try {
      return this.#insertMessage({
        kind: 'reply',
        to: request.sender,
        body: input.body,
        correlationId: request.correlation_id ?? request.id,
        replyTo: request.id,
        ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}),
      });
    } catch (error) {
      const code = error instanceof Error ? String(Reflect.get(error, 'code') ?? '') : '';
      if (code.startsWith('SQLITE_CONSTRAINT')) {
        throw new ClankChatError('REPLY_EXISTS', 'This request already has a reply.');
      }
      throw error;
    }
  }

  async awaitReply(
    requestId: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Message> {
    const timeoutMs = replyTimeout(options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);
    const request = this.database
      .prepare('SELECT sender, kind FROM messages WHERE id = ?')
      .get(requestId) as { sender: string; kind: string } | undefined;
    if (request?.kind !== 'request' || request.sender !== this.agentName) {
      throw new ClankChatError('REPLY_NOT_ALLOWED', 'Only the request sender can await its reply.');
    }
    const deadline = this.#now() + timeoutMs;
    try {
      while (!options.signal?.aborted) {
        this.heartbeat();
        this.database
          .prepare(
            `INSERT INTO reply_waiters(request_id, session_id, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(request_id) DO UPDATE SET
               session_id = excluded.session_id, expires_at = excluded.expires_at`,
          )
          .run(requestId, this.#sessionId, deadline);
        const found = this.#consumeAvailableReply(requestId);
        if (found) return found;
        if (this.#now() >= deadline) break;
        await delay(Math.min(100, Math.max(1, deadline - this.#now())), undefined, {
          signal: options.signal,
        }).catch((error: unknown) => {
          if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
        });
      }
      if (options.signal?.aborted) {
        throw new ClankChatError('REQUEST_CANCELLED', 'Waiting for the reply was cancelled.', {
          requestId,
        });
      }
      const final = this.#consumeAvailableReply(requestId);
      if (final) return final;
      throw new ClankChatError('REPLY_TIMEOUT', 'No reply arrived before the timeout.', {
        requestId,
        timeoutMs,
      });
    } finally {
      this.database
        .prepare('DELETE FROM reply_waiters WHERE request_id = ? AND session_id = ?')
        .run(requestId, this.#sessionId);
    }
  }

  #consumeAvailableReply(requestId: string): Message | null {
    const now = this.#now();
    return immediateTransaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT messages.*, recipients.delivered_at, recipients.read_at,
                  recipients.reserved_by_session,
                  owner.closed_at AS owner_closed_at, owner.expires_at AS owner_expires_at
           FROM messages
           JOIN message_recipients AS recipients
             ON recipients.message_id = messages.id AND recipients.agent_name = ?
           LEFT JOIN sessions AS owner ON owner.id = recipients.reserved_by_session
           WHERE messages.reply_to = ?`,
        )
        .get(this.agentName, requestId) as ReplyRow | undefined;
      if (!row) return null;
      const ownedElsewhere =
        row.reserved_by_session !== null &&
        row.reserved_by_session !== this.#sessionId &&
        row.owner_closed_at === null &&
        (row.owner_expires_at ?? 0) >= now;
      if (ownedElsewhere && row.delivered_at === null) return null;
      this.database
        .prepare(
          `UPDATE message_recipients
           SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?),
               reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
           WHERE message_id = ? AND agent_name = ?`,
        )
        .run(now, now, row.id, this.agentName);
      this.database.prepare('DELETE FROM reply_waiters WHERE request_id = ?').run(requestId);
      this.#reservations.delete(row.id);
      const found = toMessage(row);
      return { ...found, deliveredAt: found.deliveredAt ?? now, readAt: found.readAt ?? now };
    });
  }

  async requestAndAwait(input: {
    to: string;
    body: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ request: Message; reply: Message }> {
    const timeoutMs = replyTimeout(input.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS);
    if (input.signal?.aborted) {
      throw new ClankChatError('REQUEST_CANCELLED', 'The request was cancelled before sending.');
    }
    const request = this.#insertMessage({
      kind: 'request',
      to: input.to,
      body: input.body,
      correlationId: identifier('correlation'),
      waiterExpiresAt: this.#now() + timeoutMs,
    });
    const reply = await this.awaitReply(request.id, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { request, reply };
  }

  inbox(options: { unreadOnly?: boolean; limit?: number } = {}): Message[] {
    this.heartbeat();
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ClankChatError('INVALID_INPUT', 'Inbox limit must be 1-1000.');
    }
    const rows = this.database
      .prepare(
        `SELECT messages.*,
           MAX(recipients.delivered_at) AS delivered_at,
           MAX(recipients.read_at) AS read_at
         FROM messages JOIN message_recipients AS recipients ON recipients.message_id = messages.id
         WHERE recipients.agent_name = ?
           AND recipients.scope IN ('', ?)
           ${options.unreadOnly ? 'AND recipients.read_at IS NULL' : ''}
         GROUP BY messages.id
         ORDER BY messages.created_at DESC, messages.id DESC
         LIMIT ?`,
      )
      .all(this.agentName, this.#sessionId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  acknowledge(messageIds: string[]): number {
    this.heartbeat();
    const ids = [...new Set(messageIds.map((id) => bounded(id, 'Message ID', 100)))];
    if (ids.length === 0) return 0;
    const now = this.#now();
    return immediateTransaction(this.database, () => {
      let changed = 0;
      const update = this.database.prepare(
        `UPDATE message_recipients SET read_at = COALESCE(read_at, ?)
         WHERE message_id = ? AND agent_name = ? AND scope IN ('', ?) AND read_at IS NULL`,
      );
      for (const id of ids) {
        const result = update.run(now, id, this.agentName, this.#sessionId);
        if (result.changes > 0) {
          changed += result.changes;
          this.#recordEvent('message.acknowledged', this.agentName, id, {});
        }
      }
      return changed;
    });
  }

  reserveNextDelivery(): Message | null {
    this.heartbeat();
    if (this.#reservations.size > 0) return null;
    const now = this.#now();
    return immediateTransaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT messages.*, recipients.delivered_at, recipients.read_at,
                  recipients.agent_name, recipients.scope
           FROM message_recipients AS recipients
           JOIN messages ON messages.id = recipients.message_id
           LEFT JOIN sessions AS owner ON owner.id = recipients.reserved_by_session
           WHERE recipients.agent_name = ?
             AND recipients.scope IN ('', ?)
             AND recipients.read_at IS NULL
             AND recipients.delivered_at IS NULL
              AND (
                recipients.reserved_by_session IS NULL OR owner.id IS NULL OR
                owner.closed_at IS NOT NULL OR owner.expires_at < ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM reply_waiters
                JOIN sessions AS waiter_session ON waiter_session.id = reply_waiters.session_id
                WHERE messages.kind = 'reply'
                  AND reply_waiters.request_id = messages.reply_to
                  AND reply_waiters.expires_at >= ?
                  AND waiter_session.closed_at IS NULL
                  AND waiter_session.expires_at >= ?
              )
            ORDER BY messages.created_at, messages.id
            LIMIT 1`,
        )
        .get(this.agentName, this.#sessionId, now, now, now) as
        | (MessageRow & { agent_name: string; scope: string })
        | undefined;
      if (!row) return null;
      const token = identifier('reservation');
      const updated = this.database
        .prepare(
          `UPDATE message_recipients
           SET reserved_by_session = ?, reservation_token = ?, reserved_at = ?
           WHERE message_id = ? AND agent_name = ? AND scope = ? AND delivered_at IS NULL`,
        )
        .run(this.#sessionId, token, now, row.id, row.agent_name, row.scope);
      if (updated.changes !== 1) return null;
      this.#reservations.set(row.id, token);
      return { ...toMessage(row), ...(row.scope ? { deliveryScope: row.scope } : {}) };
    });
  }

  deliveryIsCurrent(messageId: string): boolean {
    const token = this.#reservations.get(messageId);
    if (!token) return false;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM message_recipients
           WHERE message_id = ? AND agent_name = ? AND reservation_token = ?
             AND delivered_at IS NULL`,
        )
        .get(messageId, this.agentName, token),
    );
  }

  completeDelivery(messageId: string): void {
    const token = this.#reservations.get(messageId);
    if (!token) {
      throw new ClankChatError(
        'MESSAGE_CONFLICT',
        'This delivery reservation is no longer current.',
      );
    }
    const result = this.database
      .prepare(
        `UPDATE message_recipients
         SET delivered_at = ?, reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
         WHERE message_id = ? AND agent_name = ? AND reservation_token = ?
           AND delivered_at IS NULL`,
      )
      .run(this.#now(), messageId, this.agentName, token);
    this.#reservations.delete(messageId);
    if (result.changes !== 1) {
      throw new ClankChatError(
        'MESSAGE_CONFLICT',
        'This delivery reservation is no longer current.',
      );
    }
  }

  releaseDelivery(messageId: string): void {
    const token = this.#reservations.get(messageId);
    if (!token) return;
    this.database
      .prepare(
        `UPDATE message_recipients
         SET reserved_by_session = NULL, reservation_token = NULL, reserved_at = NULL
         WHERE message_id = ? AND agent_name = ? AND reservation_token = ?
           AND delivered_at IS NULL`,
      )
      .run(messageId, this.agentName, token);
    this.#reservations.delete(messageId);
  }

  events(options: { after?: number; limit?: number } = {}): ChatEvent[] {
    const limit = options.limit ?? 1_000;
    const rows = this.database
      .prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?')
      .all(options.after ?? 0, limit) as EventRow[];
    return rows.map(toEvent);
  }

  lastEventSequence(): number {
    const row = this.database.prepare('SELECT MAX(sequence) AS sequence FROM events').get() as {
      sequence: number | null;
    };
    return row.sequence ?? 0;
  }

  status(): LineStatus {
    const current = this.heartbeat();
    const allAgents = this.agents({ includeOffline: true });
    const self = allAgents.find((entry) => entry.name === this.agentName);
    if (!self) throw new ClankChatError('AGENT_NOT_FOUND', 'The current agent disappeared.');
    const unread = this.database
      .prepare(
        `SELECT COUNT(DISTINCT message_id) AS count FROM message_recipients
         WHERE agent_name = ? AND scope IN ('', ?) AND read_at IS NULL`,
      )
      .get(this.agentName, this.#sessionId) as { count: number };
    return {
      repositoryRoot: this.repository.root,
      commonGitDirectory: this.repository.commonGitDirectory,
      databasePath: this.repository.databasePath,
      agent: self,
      session: current,
      agents: allAgents,
      unreadMessages: unread.count,
      lastEventSequence: this.lastEventSequence(),
    };
  }
}

/** A read-only event cursor for humans that never joins the agent line. */
export class ChatObserver {
  readonly repository: RepositoryContext;
  readonly database: Database.Database;

  constructor(cwd = process.cwd()) {
    this.repository = resolveRepository(cwd);
    this.database = openDatabase(this.repository.databasePath);
  }

  heartbeat(): void {}

  events(options: { after?: number; limit?: number } = {}): ChatEvent[] {
    const rows = this.database
      .prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?')
      .all(options.after ?? 0, options.limit ?? 1_000) as EventRow[];
    return rows.map(toEvent);
  }

  lastEventSequence(): number {
    const row = this.database.prepare('SELECT MAX(sequence) AS sequence FROM events').get() as {
      sequence: number | null;
    };
    return row.sequence ?? 0;
  }

  close(): void {
    this.database.close();
  }
}
