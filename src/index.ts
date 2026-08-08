export { agentIdentity, detectHarness } from './activity.js';
export { assertDatabaseRuntimeCompatible, immediateTransaction, openDatabase } from './database.js';
export { doctor } from './doctor.js';
export { ClankChatError, errorResult, isClankChatError } from './errors.js';
export { resolveRepository } from './git.js';
export { ChatLine, ChatObserver, validateAgentName } from './line.js';
export { setup } from './setup.js';
export type {
  Agent,
  ChatEvent,
  DoctorReport,
  Harness,
  LineStatus,
  Message,
  MessageKind,
  Session,
} from './types.js';
export { VERSION } from './version.js';
export { followMessages, formatEvent, formatMessage, terminalSafe, watchEvents } from './watch.js';
