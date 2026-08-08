export type Harness = 'claude-code' | 'opencode' | 'other';
export type MessageKind = 'message' | 'request' | 'reply';

export interface Agent {
  name: string;
  harness: Harness;
  online: boolean;
  sessions: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Session {
  id: string;
  agentName: string;
  harness: Harness;
  processId: number | null;
  startedAt: number;
  lastHeartbeatAt: number;
  expiresAt: number;
  closedAt: number | null;
}

export interface Message {
  id: string;
  kind: MessageKind;
  correlationId: string | null;
  replyTo: string | null;
  sender: string;
  recipient: string | null;
  body: string;
  pinned: boolean;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  /** Stable discriminator included only while a live delivery is reserved. */
  deliveryScope?: string;
}

export interface ChatEvent {
  sequence: number;
  kind: string;
  actor: string;
  messageId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface LineStatus {
  repositoryRoot: string;
  commonGitDirectory: string;
  databasePath: string;
  agent: Agent;
  session: Session;
  agents: Agent[];
  unreadMessages: number;
  lastEventSequence: number;
}

export interface DoctorReport {
  ok: boolean;
  repositoryRoot: string;
  databasePath: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}
