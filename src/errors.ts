export type ErrorCode =
  | 'NOT_GIT_REPOSITORY'
  | 'INVALID_INPUT'
  | 'AGENT_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_CONFLICT'
  | 'REPLY_NOT_ALLOWED'
  | 'REPLY_EXISTS'
  | 'REPLY_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'SESSION_EXPIRED'
  | 'DATABASE_BUSY'
  | 'DATABASE_ERROR'
  | 'SETUP_ERROR';

/** An expected product failure that adapters can render without a stack trace. */
export class ClankerChatError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ClankerChatError';
    this.code = code;
    this.details = details;
  }
}

export function isClankerChatError(error: unknown): error is ClankerChatError {
  return error instanceof ClankerChatError;
}

// Preserve source compatibility for consumers moving from the short-lived clankchat package.
export { ClankerChatError as ClankChatError };
export const isClankChatError = isClankerChatError;

export function errorResult(error: unknown): {
  error: { code: string; details: Record<string, unknown>; message: string };
  ok: false;
} {
  if (isClankerChatError(error)) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }

  const sqliteCode = error instanceof Error ? String(Reflect.get(error, 'code') ?? '') : '';
  if (sqliteCode.includes('BUSY') || sqliteCode.includes('LOCKED')) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_BUSY',
        message: 'The clankerchat line remained locked while waiting for another writer.',
        details: { cause: error instanceof Error ? error.message : String(error) },
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'DATABASE_ERROR',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}
