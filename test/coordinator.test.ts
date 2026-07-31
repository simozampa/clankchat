import { writeFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { Coordinator } from '../src/coordinator.js';
import { SameTreeError } from '../src/errors.js';
import { resolveRepository } from '../src/git.js';
import { createTestRepository, type TestRepository } from './helpers.js';

const repositories: TestRepository[] = [];
const coordinators: Coordinator[] = [];

function setup(clock?: () => number) {
  const repository = createTestRepository();
  repositories.push(repository);
  const open = (agent: string) => {
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent,
      ...(clock ? { clock } : {}),
    });
    coordinators.push(coordinator);
    return coordinator;
  };
  return { repository, open };
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.close();
  for (const repository of repositories.splice(0)) repository.cleanup();
});

describe('Coordinator', () => {
  it('supports an explicit in-memory database without requiring WAL', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent: 'memory-agent',
      databasePath: ':memory:',
    });
    coordinators.push(coordinator);

    expect(coordinator.createTask({ title: 'Memory task' })).toMatchObject({
      assignee: 'memory-agent',
      status: 'ready',
    });
  });

  it('can omit lifecycle events while retaining a durable closed session', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const coordinator = Coordinator.open({
      cwd: repository.root,
      agent: 'quiet-session',
      recordSessionLifecycleEvents: false,
    });
    coordinators.push(coordinator);
    const sessionId = coordinator.sessionId;

    expect(coordinator.events({ after: 0 })).toEqual([]);
    coordinator.close();

    const database = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(database.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId)).toEqual({
      status: 'closed',
    });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM events WHERE entity_id = ?').get(sessionId),
    ).toEqual({
      count: 0,
    });
    database.close();
  });

  it('keeps status compact while preserving opt-in history', () => {
    const { open } = setup();
    const historical = open('historical');
    const completed = historical.startTask(historical.createTask({ title: 'Completed work' }).id);
    historical.updateTask(completed.id, { status: 'done' });
    historical.close();
    const observer = open('observer');

    const current = observer.snapshot();
    expect(current.agents.map((agent) => agent.name)).toEqual(['observer']);
    expect(current.tasks).toEqual([]);

    const history = observer.snapshot({
      includeInactiveAgents: true,
      includeTerminalTasks: true,
    });
    expect(history.agents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['historical', 'observer']),
    );
    expect(history.tasks).toEqual([expect.objectContaining({ id: completed.id, status: 'done' })]);
  });

  it('pages task history with stable task cursors', () => {
    const { open } = setup(() => 1_000);
    const author = open('author');
    const created = [
      author.createTask({ title: 'One' }),
      author.createTask({ title: 'Two' }),
      author.createTask({ title: 'Three' }),
      author.createTask({ title: 'Four' }),
    ];

    const first = author.listTasks({ limit: 2 });
    const cursor = first.at(-1)?.id;
    if (!cursor) throw new Error('Expected a task cursor.');
    const second = author.listTasks({ after: cursor, limit: 2 });

    expect([...first, ...second].map((task) => task.id).sort()).toEqual(
      created.map((task) => task.id).sort(),
    );
    expect(new Set([...first, ...second].map((task) => task.id)).size).toBe(4);
  });

  it('does not silently truncate status tasks and rejects invalid page limits', () => {
    const { open } = setup();
    const author = open('author');
    for (let index = 0; index < 101; index += 1) {
      author.createTask({ title: `Visible task ${index}` });
    }

    expect(author.snapshot().tasks).toHaveLength(101);
    expect(() => author.listTasks({ limit: 101 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => author.events({ limit: 1_001 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('limits direct event reads to 25 rows by default', () => {
    const { open } = setup();
    const author = open('author');
    for (let index = 0; index < 30; index += 1) {
      author.createTask({ title: `Task ${index}` });
    }

    expect(author.events()).toHaveLength(25);
    expect(author.events({ limit: 30 })).toHaveLength(30);
  });

  it('enforces task dependencies and active leases', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const prerequisite = author.createTask({ title: 'Define contract' });
    const implementation = author.createTask({
      title: 'Implement contract',
      dependencies: [prerequisite.id],
    });

    expect(() => reviewer.startTask(implementation.id)).toThrowError(
      expect.objectContaining({ code: 'TASK_BLOCKED' }),
    );

    author.startTask(prerequisite.id);
    author.updateTask(prerequisite.id, { status: 'done' });
    const claimed = author.startTask(implementation.id);

    expect(claimed.assignee).toBe('author');
    expect(() => reviewer.startTask(implementation.id)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
  });

  it('keeps claimTask as an alias while recording canonical task start events', () => {
    const { open } = setup();
    const author = open('author');
    const task = author.createTask({ title: 'Compatibility start' });

    expect(author.claimTask(task.id)).toMatchObject({
      assignee: 'author',
      status: 'in_progress',
    });
    expect(author.events({ after: 0 }).map((event) => event.kind)).toContain('task.started');
    expect(author.events({ after: 0 }).map((event) => event.kind)).not.toContain('task.claimed');
  });

  it('creates self-owned task records and rejects peer assignment', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const assigned = author.createTask({ title: 'Assigned work', assignee: 'author' });
    const implicit = author.createTask({ title: 'Implicit self-assignment' });

    expect(implicit.assignee).toBe('author');
    expect(() =>
      author.createTask({ title: 'Peer assignment', assignee: 'reviewer' }),
    ).toThrowError(expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }));

    expect(() => reviewer.startTask(assigned.id)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(() =>
      reviewer.updateTask(implicit.id, { description: 'Taken without assignment' }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_ASSIGNED' }));
  });

  it('requires direct user authorization to adopt a legacy unassigned task', () => {
    const { repository, open } = setup();
    const author = open('author');
    const database = new Database(resolveRepository(repository.root).databasePath);
    database
      .prepare(
        `INSERT INTO tasks
          (id, title, description, status, priority, assignee, revision, created_at, updated_at)
         VALUES ('task_legacy', 'Legacy task', '', 'ready', 'normal', NULL, 1, 1, 1)`,
      )
      .run();
    database.close();

    expect(() => author.startTask('task_legacy')).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(
      author.startTask('task_legacy', {
        expectedRevision: 1,
        reason: 'The user explicitly assigned this legacy task.',
        userAuthorized: true,
      }),
    ).toMatchObject({ assignee: 'author', status: 'in_progress' });
  });

  it('checks dependencies on every transition into progress', () => {
    const { open } = setup();
    const author = open('author');
    const prerequisite = author.createTask({ title: 'Prerequisite' });
    const assigned = author.createTask({
      title: 'Assigned dependent work',
      assignee: 'author',
      dependencies: [prerequisite.id],
    });

    expect(() => author.updateTask(assigned.id, { status: 'in_progress' })).toThrowError(
      expect.objectContaining({ code: 'TASK_BLOCKED' }),
    );
  });

  it('forcibly transfers active work while ignoring legacy claim IDs', () => {
    const { open } = setup();
    const owner = open('owner');
    const replacement = open('replacement');
    const task = owner.createTask({ title: 'Transfer active work' });
    const active = owner.startTask(task.id);

    const takeover = replacement.forceTakeoverTask(task.id, {
      claimIds: ['claim_archived'],
      expectedRevision: active.revision,
      reason: 'The user reassigned this work while the first agent handles another task.',
      userAuthorized: true,
    });

    expect(takeover.task).toMatchObject({ assignee: 'replacement', status: 'in_progress' });
    expect(takeover.claims).toEqual([]);
    expect(() => owner.updateTask(task.id, { description: 'Old owner update.' })).toThrowError(
      expect.objectContaining({ code: 'NOT_ASSIGNED' }),
    );
    expect(
      replacement.events({ after: 0 }).find((event) => event.kind === 'task.force_taken_over'),
    ).toMatchObject({
      actor: 'replacement',
      payload: {
        newAssignee: 'replacement',
        previousAssignee: 'owner',
        claimIds: [],
        reason: 'The user reassigned this work while the first agent handles another task.',
        userAuthorized: true,
      },
    });
  });

  it('requires authorization and a current revision for forced takeover', () => {
    const { open } = setup();
    const owner = open('owner');
    const first = open('first-replacement');
    const second = open('second-replacement');
    const active = owner.startTask(owner.createTask({ title: 'Contended takeover' }).id);

    expect(() =>
      first.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'No user authorization was supplied.',
        userAuthorized: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));

    first.forceTakeoverTask(active.id, {
      expectedRevision: active.revision,
      reason: 'The user selected the first replacement.',
      userAuthorized: true,
    });
    expect(() =>
      second.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'This instruction used a stale task view.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TASK_UNAVAILABLE' }));
  });

  it('requires user-authorized takeover after lease expiry', () => {
    let now = Date.now();
    const { open } = setup(() => now);
    const owner = open('owner');
    const active = owner.startTask(owner.createTask({ title: 'Expired takeover' }).id);
    now += 901_000;
    const replacement = open('replacement');

    expect(() => replacement.startTask(active.id)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    expect(
      replacement.forceTakeoverTask(active.id, {
        expectedRevision: active.revision,
        reason: 'The user reassigned this expired work.',
        userAuthorized: true,
      }).task.assignee,
    ).toBe('replacement');
  });

  it('reassigns blocked work without incorrectly starting execution', () => {
    const { open } = setup();
    const owner = open('owner');
    const replacement = open('replacement');
    const active = owner.startTask(owner.createTask({ title: 'Blocked takeover' }).id);
    const blocked = owner.updateTask(active.id, { status: 'blocked' });

    const takeover = replacement.forceTakeoverTask(blocked.id, {
      expectedRevision: blocked.revision,
      reason: 'The user reassigned investigation of the blocker.',
      userAuthorized: true,
    });

    expect(takeover.task).toMatchObject({
      assignee: 'replacement',
      status: 'blocked',
      leaseExpiresAt: null,
    });
    const ready = replacement.updateTask(blocked.id, { status: 'ready' });
    expect(replacement.startTask(ready.id)).toMatchObject({
      assignee: 'replacement',
      status: 'in_progress',
    });
  });

  it('reassigns dependency-blocked ready work without starting execution', () => {
    const { open } = setup();
    const owner = open('owner');
    const replacement = open('replacement');
    const prerequisite = owner.createTask({ title: 'Prerequisite' });
    const dependent = owner.createTask({
      title: 'Waiting takeover',
      dependencies: [prerequisite.id],
    });

    const takeover = replacement.forceTakeoverTask(dependent.id, {
      expectedRevision: dependent.revision,
      reason: 'The user reassigned the waiting task.',
      userAuthorized: true,
    });

    expect(takeover.task).toMatchObject({
      assignee: 'replacement',
      status: 'ready',
      leaseExpiresAt: null,
    });
  });

  it('keeps archived claim rows while exposing no active claim behavior', () => {
    const { repository, open } = setup();
    const author = open('author');
    const database = new Database(resolveRepository(repository.root).databasePath);
    database
      .prepare(
        `INSERT INTO path_claims
          (id, path, comparison_path, kind, agent_name, session_id,
           expires_at, created_at, worktree_id)
         VALUES ('claim_archived', 'src/legacy.ts', 'src/legacy.ts', 'exact', ?, ?, ?, ?, ?)`,
      )
      .run(author.agentName, author.sessionId, Date.now() + 60_000, Date.now(), author.worktreeId);
    database.close();

    expect(() => author.acquireClaims([{ path: 'src/new.ts' }])).toThrowError(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        message: expect.stringContaining('Path claims were removed'),
      }),
    );
    expect(author.listClaims({ includeExpired: true })).toEqual([]);
    expect(author.releaseClaims({ all: true })).toEqual({ released: 0 });
    expect(author.snapshot().claims).toEqual([]);

    const archived = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(archived.prepare('SELECT id, path FROM path_claims').get()).toEqual({
      id: 'claim_archived',
      path: 'src/legacy.ts',
    });
    archived.close();
  });

  it('delivers and acknowledges direct and broadcast messages', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const direct = reviewer.sendMessage({
      to: 'author',
      subject: 'Review finding',
      body: 'Handle the empty state.',
    });
    reviewer.sendMessage({ subject: 'Heads up', body: 'The schema changed.' });

    expect(author.inbox({ unreadOnly: true })).toHaveLength(2);
    expect(author.acknowledgeMessage(direct.id).readAt).not.toBeNull();
    expect(author.inbox({ unreadOnly: true })).toHaveLength(1);
  });

  it('delivers review findings in the task-linked request thread', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.startTask(author.createTask({ title: 'Implement parser' }).id);
    const request = author.sendMessage({
      to: 'reviewer',
      subject: 'Review parser implementation',
      body: 'Commit abc123; npm test passes.',
      taskId: task.id,
    });
    const finding = reviewer.sendMessage({
      to: 'author',
      subject: 'P1: reject malformed input',
      body: 'src/parser.ts:42 accepts an invalid token.',
      taskId: task.id,
      threadId: request.threadId,
    });

    expect(reviewer.inbox()).toContainEqual(
      expect.objectContaining({ id: request.id, taskId: task.id }),
    );
    expect(author.inbox()).toContainEqual(
      expect.objectContaining({
        id: finding.id,
        taskId: task.id,
        threadId: request.threadId,
      }),
    );
  });

  it('publishes revisioned plans idempotently and notifies live peers', () => {
    const { open } = setup(() => 1_000);
    const author = open('author');
    const reviewer = open('reviewer');
    const first = author.publishPlan({
      body: '# Validation plan\n\n1. Reject empty arrays.\n2. Add regression coverage.',
      sourceSessionId: 'session-plan',
      sourceEventId: 'event-one',
    });

    expect(first).toMatchObject({
      author: 'author',
      revision: 1,
      sourceHarness: 'other',
      title: 'Validation plan',
    });
    expect(reviewer.inbox()).toEqual([
      expect.objectContaining({
        sender: 'author',
        subject: 'Plan from author: Validation plan',
        threadId: `plan:${first.id}`,
      }),
    ]);
    expect(
      author.publishPlan({
        body: first.body,
        sourceSessionId: 'session-plan',
        sourceEventId: 'event-one',
      }),
    ).toEqual(first);

    const revised = author.publishPlan({
      body: '# Validation plan\n\n1. Reject empty arrays.\n2. Add property coverage.',
      sourceSessionId: 'session-plan',
      sourceEventId: 'event-two',
    });
    expect(revised.revision).toBe(2);
    expect(author.getPlan(first.id, 1).body).toContain('regression coverage');
    expect(author.listPlans()).toEqual([
      expect.objectContaining({ id: first.id, revision: 2, title: 'Validation plan' }),
    ]);
    expect(reviewer.inbox()).toHaveLength(2);
    expect(
      author.events({ limit: 100 }).filter((event) => event.kind.startsWith('plan.')),
    ).toHaveLength(2);

    expect(() =>
      author.publishPlan({
        body: '# Different plan',
        sourceSessionId: 'session-plan',
        sourceEventId: 'event-one',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PLAN_CONFLICT' }));
  });

  it('keeps plans visible to agents that register after publication', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const author = Coordinator.open({ cwd: repository.root, agent: 'author', clock: () => 1_000 });
    coordinators.push(author);
    const plan = author.publishPlan({
      body: '# Durable proposal\n\nShare this with future sessions.',
      sourceSessionId: 'session-plan',
      sourceEventId: 'event-one',
    });
    const future = Coordinator.open({ cwd: repository.root, agent: 'future', clock: () => 1_000 });
    coordinators.push(future);

    expect(future.inbox()).toEqual([]);
    expect(future.snapshot().plans).toEqual([
      expect.objectContaining({ id: plan.id, revision: 1, title: 'Durable proposal' }),
    ]);
    expect(future.getPlan(plan.id).body).toContain('future sessions');
  });

  it('deduplicates a resumed harness session after its process identity changes', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const firstProcess = Coordinator.open({
      cwd: repository.root,
      agent: 'opencode-100',
      harness: 'opencode',
    });
    const resumedProcess = Coordinator.open({
      cwd: repository.root,
      agent: 'opencode-200',
      harness: 'opencode',
    });
    coordinators.push(firstProcess, resumedProcess);
    const first = firstProcess.publishPlan({
      body: '# Stable session\n\nResume without duplicating this proposal.',
      sourceSessionId: 'session-stable',
      sourceEventId: 'message-stable',
    });

    expect(
      resumedProcess.publishPlan({
        body: first.body,
        sourceSessionId: 'session-stable',
        sourceEventId: 'message-stable',
      }),
    ).toEqual(first);
    expect(resumedProcess.listPlans()).toHaveLength(1);

    const revised = resumedProcess.publishPlan({
      body: '# Stable session\n\nPublish one revision after resuming.',
      sourceSessionId: 'session-stable',
      sourceEventId: 'message-revised',
    });
    expect(revised).toMatchObject({ id: first.id, author: 'opencode-200', revision: 2 });
  });

  it('keeps plan pagination stable when an earlier plan is revised', () => {
    let now = 1_000;
    const { open } = setup(() => now);
    const author = open('author');
    const first = author.publishPlan({
      body: '# First plan',
      sourceSessionId: 'session-first',
      sourceEventId: 'event-first',
    });
    now = 2_000;
    const second = author.publishPlan({
      body: '# Second plan',
      sourceSessionId: 'session-second',
      sourceEventId: 'event-second',
    });
    expect(author.listPlans({ limit: 1 })).toEqual([expect.objectContaining({ id: second.id })]);

    now = 3_000;
    author.publishPlan({
      body: '# First plan\n\nRevised after the first page was read.',
      sourceSessionId: 'session-first',
      sourceEventId: 'event-first-revised',
    });

    expect(author.listPlans({ after: second.id, limit: 1 })).toEqual([
      expect.objectContaining({ id: first.id, revision: 2 }),
    ]);
  });

  it('records exact shared instructions idempotently and notifies existing agents', () => {
    const { open } = setup(() => 1_000);
    const author = open('author');
    const recipient = open('recipient');
    const body = 'Always commit your changes.\n  Preserve this indentation.\n';
    const input = {
      body,
      reason: 'The user explicitly prefixed this for all agents.',
      sourceSessionId: 'native-session',
      sourceEventId: 'user-prompt-one',
      userAuthorized: true,
    };
    const instruction = author.recordSharedInstruction(input);

    expect(instruction).toMatchObject({
      action: 'recorded',
      acknowledgedAt: 1_000,
      body,
      createdBy: 'author',
      revision: 1,
      status: 'active',
    });
    expect(author.recordSharedInstruction(input)).toEqual(instruction);
    expect(recipient.snapshot()).toMatchObject({
      unacknowledgedInstructions: 1,
      instructions: [
        expect.objectContaining({ id: instruction.id, acknowledgedAt: null, revision: 1 }),
      ],
    });
    const notice = recipient.inbox({ unreadOnly: true });
    expect(notice).toHaveLength(1);
    const noticeMessage = notice[0];
    if (!noticeMessage) throw new Error('Expected instruction notice.');
    expect(noticeMessage.instruction).toMatchObject({
      id: instruction.id,
      action: 'recorded',
      body,
      isCurrent: true,
      revision: 1,
    });
    expect(recipient.isMessageDeliveryCurrent(noticeMessage.id)).toBe(true);
    expect(() => recipient.acknowledgeMessage(noticeMessage.id)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(recipient.acknowledgeSharedInstruction(instruction.id, 1)).toMatchObject({
      newlyAcknowledged: true,
      revision: 1,
    });
    expect(recipient.acknowledgeSharedInstruction(instruction.id, 1)).toMatchObject({
      newlyAcknowledged: false,
    });
    expect(recipient.snapshot()).toMatchObject({
      unacknowledgedInstructions: 0,
      unreadMessages: 0,
    });
  });

  it('revises and revokes shared instructions with immutable history', () => {
    let now = 1_000;
    const { open } = setup(() => now);
    const author = open('author');
    const recipient = open('recipient');
    const instruction = author.recordSharedInstruction({
      body: 'Commit every completed change.',
      reason: 'Direct user instruction.',
      userAuthorized: true,
    });
    const originalNotice = recipient.inbox({ unreadOnly: true })[0];
    if (!originalNotice) throw new Error('Expected original instruction notice.');
    now = 2_000;
    const revised = author.reviseSharedInstruction(instruction.id, {
      body: 'Commit every completed logical change.',
      expectedRevision: 1,
      reason: 'The user clarified the instruction.',
      userAuthorized: true,
    });

    expect(revised).toMatchObject({ action: 'revised', revision: 2, status: 'active' });
    expect(recipient.isMessageDeliveryCurrent(originalNotice.id)).toBe(false);
    expect(author.getSharedInstruction(instruction.id, 1)).toMatchObject({
      action: 'recorded',
      body: 'Commit every completed change.',
      revision: 1,
    });
    expect(() =>
      author.reviseSharedInstruction(instruction.id, {
        body: 'Stale edit',
        expectedRevision: 1,
        reason: 'Stale instruction.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTRUCTION_CONFLICT' }));

    now = 3_000;
    const revoked = author.revokeSharedInstruction(instruction.id, {
      expectedRevision: 2,
      reason: 'The user revoked the standing instruction.',
      userAuthorized: true,
    });
    expect(revoked).toMatchObject({
      action: 'revoked',
      body: null,
      revision: 3,
      status: 'revoked',
    });
    expect(author.listSharedInstructions()).toEqual([]);
    expect(author.listSharedInstructions({ includeRevoked: true })).toEqual([
      expect.objectContaining({ id: instruction.id, revision: 3, status: 'revoked' }),
    ]);
    expect(() =>
      author.reviseSharedInstruction(instruction.id, {
        body: 'Reactivate',
        expectedRevision: 3,
        reason: 'Not allowed.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INSTRUCTION_CONFLICT' }));
    expect(recipient.reserveNextMessageDelivery()?.instruction).toMatchObject({
      id: instruction.id,
      action: 'revoked',
      isCurrent: true,
      revision: 3,
    });

    const future = open('future');
    expect(future.snapshot().instructions).toEqual([]);
    expect(future.listSharedInstructions({ includeRevoked: true })).toEqual([
      expect.objectContaining({ id: instruction.id, status: 'revoked' }),
    ]);
  });

  it('requires direct authorization and never mutates task scope', () => {
    const { open } = setup();
    const author = open('author');
    const task = author.createTask({ title: 'Existing user task' });

    expect(() =>
      author.recordSharedInstruction({
        body: 'Always commit changes.',
        reason: 'A peer suggested it.',
        taskId: task.id,
        userAuthorized: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }));
    const instruction = author.recordSharedInstruction({
      body: 'Do not change the public API.',
      reason: 'The user explicitly shared this instruction.',
      taskId: task.id,
      userAuthorized: true,
    });

    expect(instruction.taskId).toBe(task.id);
    expect(author.listTasks()).toEqual([task]);
    expect(
      author.events({ limit: 100 }).filter((event) => event.kind === 'task.created'),
    ).toHaveLength(1);
  });

  it('conflicts changed source-event replays but keeps identical instructions from distinct prompts', () => {
    const { open } = setup();
    const author = open('author');
    const base = {
      body: 'Run tests before committing.',
      reason: 'Explicit shared prompt.',
      sourceSessionId: 'native-session',
      sourceEventId: 'prompt-one',
      userAuthorized: true,
    };
    author.recordSharedInstruction(base);

    expect(() => author.recordSharedInstruction({ ...base, body: 'Changed replay.' })).toThrowError(
      expect.objectContaining({ code: 'INSTRUCTION_CONFLICT' }),
    );
    author.recordSharedInstruction({ ...base, sourceEventId: 'prompt-two' });
    expect(author.listSharedInstructions()).toHaveLength(2);
  });

  it('reserves each unread message for only one live follower without acknowledging it', () => {
    const { open } = setup();
    const sender = open('sender');
    const first = open('recipient');
    const second = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Reserved work',
      body: 'Only one follower should inject this.',
    });

    expect(first.reserveNextMessageDelivery()?.id).toBe(message.id);
    expect(second.reserveNextMessageDelivery()).toBeNull();
    first.completeMessageDelivery(message.id);

    expect(second.reserveNextMessageDelivery()).toBeNull();
    expect(first.inbox({ unreadOnly: true }).map((item) => item.id)).toContain(message.id);
  });

  it('releases pending message reservations when a follower closes', () => {
    const { open } = setup();
    const sender = open('sender');
    const first = open('recipient');
    const second = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Retry delivery',
      body: 'Another follower can continue after shutdown.',
    });

    const original = first.reserveNextMessageDelivery();
    expect(original?.id).toBe(message.id);
    first.close();

    const recovered = second.reserveNextMessageDelivery();
    expect(recovered?.id).toBe(message.id);
  });

  it('allows a current session to recover an expired message reservation', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    let now = 1_000;
    const sender = Coordinator.open({ cwd: repository.root, agent: 'sender', clock: () => now });
    const expired = Coordinator.open({
      cwd: repository.root,
      agent: 'recipient',
      clock: () => now,
    });
    coordinators.push(sender, expired);
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Recover delivery',
      body: 'The original follower stopped heartbeating.',
    });
    expect(expired.reserveNextMessageDelivery()?.id).toBe(message.id);

    now += 91_000;
    const replacement = Coordinator.open({
      cwd: repository.root,
      agent: 'recipient',
      clock: () => now,
    });
    coordinators.push(replacement);

    expect(replacement.reserveNextMessageDelivery()?.id).toBe(message.id);
    expect(() => expired.completeMessageDelivery(message.id)).toThrowError(
      expect.objectContaining({ code: 'NOT_ASSIGNED' }),
    );
  });

  it('migrates a version 2 database without losing unread messages', () => {
    const { repository, open } = setup();
    const sender = open('sender');
    const recipient = open('recipient');
    const message = sender.sendMessage({
      to: 'recipient',
      subject: 'Survive migration',
      body: 'This message predates delivery tracking.',
    });
    sender.close();
    recipient.close();

    const database = new Database(resolveRepository(repository.root).databasePath);
    database.exec(
      'DROP TABLE message_deliveries; DELETE FROM schema_migrations WHERE version >= 3;',
    );
    database.close();

    const migrated = open('recipient');
    expect(migrated.reserveNextMessageDelivery()?.id).toBe(message.id);
    const verification = new Database(resolveRepository(repository.root).databasePath, {
      readonly: true,
    });
    expect(
      verification.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
    ).toEqual({ version: 7 });
    verification.close();
  });

  it('transfers task ownership through a user-authorized handoff', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.startTask(task.id);

    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Parser is ready for edge-case fixes.',
      context: { commit: 'abc123' },
      claimIds: ['claim_archived'],
    });
    expect(() => reviewer.respondToHandoff(offer.id, true)).toThrowError(
      expect.objectContaining({ code: 'USER_AUTHORIZATION_REQUIRED' }),
    );
    reviewer.respondToHandoff(offer.id, true, {
      reason: 'The user moved parser ownership to the reviewer.',
      userAuthorized: true,
    });

    expect(reviewer.listTasks().find((item) => item.id === task.id)?.assignee).toBe('reviewer');
    expect(reviewer.listClaims()).toEqual([]);
  });

  it('ignores legacy claim IDs on handoff offers', () => {
    const { open } = setup();
    const author = open('author');
    open('reviewer');
    const task = author.startTask(author.createTask({ title: 'Legacy handoff input' }).id);
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Continue the user-assigned work.',
      claimIds: Array.from({ length: 101 }, (_, index) => `claim_${index}`),
    });

    expect(author.listHandoffs()).toContainEqual(expect.objectContaining({ id: offer.id }));
  });

  it('does not report handoffs made stale by another accepted transfer as pending', () => {
    const { open } = setup();
    const author = open('author');
    const first = open('first-reviewer');
    const second = open('second-reviewer');
    const task = author.startTask(author.createTask({ title: 'Competing handoffs' }).id);
    const firstOffer = author.offerHandoff({
      taskId: task.id,
      to: 'first-reviewer',
      summary: 'First offer.',
    });
    author.offerHandoff({
      taskId: task.id,
      to: 'second-reviewer',
      summary: 'Second offer.',
    });

    first.respondToHandoff(firstOffer.id, true, {
      reason: 'The user selected the first reviewer.',
      userAuthorized: true,
    });

    expect(second.listHandoffs({ pendingOnly: true })).toEqual([]);
    expect(second.snapshot().pendingHandoffs).toBe(0);
  });

  it('keeps pending handoffs valid when the source session closes', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.startTask(task.id);
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Continue after I exit.',
      claimIds: ['claim_archived'],
    });

    author.close();

    expect(
      reviewer.respondToHandoff(offer.id, true, {
        reason: 'The user asked the reviewer to continue after the author exited.',
        userAuthorized: true,
      }).status,
    ).toBe('accepted');
  });

  it('rejects a handoff when its task revision becomes stale', () => {
    const { open } = setup();
    const author = open('author');
    const reviewer = open('reviewer');
    const task = author.createTask({ title: 'Implement parser' });
    author.startTask(task.id);
    const offer = author.offerHandoff({
      taskId: task.id,
      to: 'reviewer',
      summary: 'Continue implementation.',
    });
    author.updateTask(task.id, { description: 'The contract changed.' });

    expect(() =>
      reviewer.respondToHandoff(offer.id, true, {
        reason: 'The user authorized the original handoff.',
        userAuthorized: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_CONFLICT' }));
  });

  it('does not offer terminal tasks for handoff', () => {
    const { open } = setup();
    const author = open('author');
    open('reviewer');
    const task = author.createTask({ title: 'Completed work' });
    author.startTask(task.id);
    author.updateTask(task.id, { status: 'done' });

    expect(() =>
      author.offerHandoff({ taskId: task.id, to: 'reviewer', summary: 'Resurrect this task.' }),
    ).toThrowError(expect.objectContaining({ code: 'TASK_UNAVAILABLE' }));
  });

  it('does not renew an expired session or its task lease', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    let now = 1_000_000;
    const author = Coordinator.open({ cwd: repository.root, agent: 'author', clock: () => now });
    coordinators.push(author);
    const task = author.createTask({ title: 'Expiring work' });
    const originalLease = author.startTask(task.id).leaseExpiresAt;
    now += 91_000;

    expect(() => author.heartbeat()).toThrowError(
      expect.objectContaining({ code: 'TASK_UNAVAILABLE' }),
    );
    expect(author.listTasks().find((item) => item.id === task.id)?.leaseExpiresAt).toBe(
      originalLease,
    );
  });

  it('does not deliver historical broadcasts to future agents', () => {
    const repository = createTestRepository();
    repositories.push(repository);
    const author = Coordinator.open({ cwd: repository.root, agent: 'author', clock: () => 1_000 });
    coordinators.push(author);
    author.sendMessage({ subject: 'Before registration', body: 'Historical announcement.' });
    const future = Coordinator.open({ cwd: repository.root, agent: 'future', clock: () => 1_000 });
    coordinators.push(future);

    expect(future.inbox()).toEqual([]);
  });

  it('bounds serialized handoff context', () => {
    const { open } = setup();
    const author = open('author');
    open('reviewer');
    const task = author.createTask({ title: 'Bounded handoff' });
    author.startTask(task.id);

    expect(() =>
      author.offerHandoff({
        taskId: task.id,
        to: 'reviewer',
        summary: 'Oversized context.',
        context: { payload: 'x'.repeat(100_000) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('ties policy acknowledgements to exact content hashes', () => {
    const { open } = setup();
    const author = open('author');
    const policy = author.getPolicy();

    expect(policy.acknowledgedAt).toBeNull();
    const acknowledged = author.acknowledgePolicy(policy.hash);
    expect(acknowledged).toMatchObject({ hash: policy.hash, newlyAcknowledged: true });
    expect(Object.keys(acknowledged).sort()).toEqual([
      'acknowledgedAt',
      'hash',
      'member',
      'newlyAcknowledged',
      'worktreeId',
    ]);
    expect(author.acknowledgePolicy(policy.hash)).toEqual({
      ...acknowledged,
      newlyAcknowledged: false,
    });
    expect(
      author.events({ after: 0 }).filter((event) => event.kind === 'policy.acknowledged'),
    ).toHaveLength(1);

    writeFileSync(policy.path, `${policy.content}\nNew policy version.\n`, 'utf8');
    const changed = author.getPolicy();
    expect(changed).toMatchObject({ acknowledgedAt: null });
    expect(changed.hash).not.toBe(policy.hash);
    author.acknowledgePolicy(changed.hash);
    expect(
      author.events({ after: 0 }).filter((event) => event.kind === 'policy.acknowledged'),
    ).toHaveLength(2);
    writeFileSync(policy.path, Buffer.from([0xff]));
    const invalidUtf8 = author.getPolicy().hash;
    writeFileSync(policy.path, Buffer.from([0xfe]));
    expect(author.getPolicy().hash).not.toBe(invalidUtf8);
    expect(() => author.acknowledgePolicy('0'.repeat(64))).toThrow(SameTreeError);
  });

  it('reports healthy SQLite state', () => {
    const { open } = setup();
    const report = open('doctor').doctor();

    expect(report).toMatchObject({
      ok: true,
      integrity: 'ok',
      journalMode: 'wal',
      foreignKeyViolations: 0,
      policyPresent: true,
    });
  });
});
