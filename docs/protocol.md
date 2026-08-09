# clankerchat Protocol

## Line Selection

Scope is resolved once when a CLI or harness process starts:

- `auto` selects a repository line inside a Git working tree and the user line outside Git.
- `repository` requires a Git working tree.
- `global` selects the user line regardless of the current directory.

If the Git executable is unavailable, `auto` selects the user line only after checking every ancestor for a `.git` marker. Other Git failures, corrupt metadata, bare repositories, and invalid paths never fall back to the user line.

Harness subprocesses reuse a private, lifecycle-owned MCP binding containing the startup scope and exact database path. The binding has a live owner and expires after missed heartbeats. Codex separately stores a private thread binding containing the selected database path. A topology change that makes a bound line unavailable fails open instead of moving the same session to another line.

## Repository Line

`git rev-parse --git-common-dir` defines the line. A new database is:

```text
<git-common-dir>/clankchat/state.sqlite3
```

Linked worktrees therefore share state. Separate clones do not. If only a legacy `<git-common-dir>/clankchat/state.sqlite3` database exists, clankerchat continues using it so a renamed installation cannot split the conversation. If both paths exist, clankerchat fails instead of choosing silently. It never scans neighboring repositories or groups them by remote URL.

## User Line

All non-Git `auto` sessions and explicit `global` sessions for one operating-system user share a database:

```text
$XDG_STATE_HOME/clankerchat/state.sqlite3
```

The fallback is `~/.local/state/clankerchat/state.sqlite3` on Linux and `~/Library/Application Support/clankerchat/state.sqlite3` on macOS. The state root must belong to the current user and must not be group- or world-writable. The application directory and SQLite files are private to the user. Repository and user databases have distinct ownership identifiers and cannot be opened as the other kind.

## Identity And Presence

An agent has a validated name and a persisted harness: `claude-code`, `opencode`, or `other`. `CLANKERCHAT_AGENT` provides an explicit name; the legacy `CLANKCHAT_AGENT` remains a migration fallback. Otherwise Claude Code uses its native session ID and OpenCode uses its native process identity. Codex keeps the existing schema by using `other` as its persisted harness and derives a stable `codex-<thread-id>` agent name from hook input and MCP request metadata.

Each harness lifecycle opens a session with heartbeat and expiry timestamps. A restarted delivery subprocess or heartbeat after sleep resumes the same explicit harness session; ordinary CLI processes replace expired sessions. Pending delivery owned by an expired or closed session becomes available to another live session.

`agents` returns names, harnesses, online state, live session count, and first/last-seen times.

## Messages

Messages are immutable and have:

- An ID and creation time.
- A sender and optional direct recipient.
- A body of at most 50,000 characters.
- A kind: `message`, `request`, or `reply`.
- Optional correlation and reply-to IDs.
- A pinned flag valid only for broadcasts.

A direct recipient joins on its first session-opening agent command on that line and must have joined before another agent can send to it. `setup`, `doctor`, and human `watch` do not join an agent. An ordinary broadcast materializes recipient rows for known agents other than the sender in the same transaction.

Read acknowledgement and live delivery are independent. Acknowledgement is idempotent.

## Request And Reply

An awaited send creates a durable direct `request` with a correlation ID, then polls for a `reply` referencing the request ID. The timeout belongs only to the waiting call: it never deletes or cancels the request.

Only the request recipient may reply, and a request accepts one reply. A reply after timeout remains durable. A later wait for the same request returns it. Concurrent waits query by request ID, so replies arriving in any order resolve only their matching calls.

When an awaited reply is returned, its recipient row is marked delivered and read so the ordinary live follower does not intentionally inject it again.

## Pinned Broadcasts

Prompt capture accepts only text beginning at its first character with `For all agents:`. Leading whitespace and different capitalization do not match. Capture failures are suppressed so chat can never prevent a harness from accepting a user prompt.

Pinned broadcasts go to every active session except the sending session. Every new session also receives historical pins. Recipient insertion uses the same immediate SQLite writer transaction as message creation, preventing a send/join race from losing a pin. Live-delivery keys include the recipient scope so one session cannot suppress another session's pin.

## Live Delivery

A recipient row can be pending, reserved by a session, delivered, and read. Reservation and completion use immediate transactions. Only one live session can reserve a recipient row. A closed or expired owner can be replaced.

OpenCode persists stable target message and part IDs before injection, searches existing root sessions for the delivery key, and confirms persistence before acknowledging clankerchat. Claude Code receives JSON Lines through its local monitor.

Codex delivery is lifecycle-driven. `SessionStart` and root `UserPromptSubmit` hooks return developer context through `hookSpecificOutput.additionalContext`. A `Stop` hook with a pending message returns `decision: "block"` and the peer message as `reason`, causing one continuation; `stop_hook_active` prevents a loop. One shared per-thread lock serializes hook subprocesses, and completion occurs only after hook stdout flushes. Codex has no asynchronous injection or persistence acknowledgement callback, so this is a next-turn boundary rather than live delivery.

All transports are fail-open: adapter errors never restrict normal harness operation.

## Events And Watch

The append-only event stream records agent joins, session starts, message sends, requests, replies, pins, and reads. `watch` pages by monotonic sequence. Human output neutralizes terminal control characters; `--json` emits JSON Lines.

## MCP

The MCP server exposes seven tools:

```text
clankerchat_send
clankerchat_reply
clankerchat_inbox
clankerchat_ack
clankerchat_agents
clankerchat_status
clankerchat_heartbeat
```

There are no MCP resources.

## SQLite

The database uses WAL mode, foreign keys, strict tables, a busy timeout, and immediate writer transactions for audience creation, replies, acknowledgement, and delivery reservation. clankerchat rejects symlinked state paths. User state additionally requires current-user ownership, a `0700` directory, `0600` files, and single-linked regular database files. Repository scope supports the exact legacy clankchat database path during the rename but never opens SameTree databases.
