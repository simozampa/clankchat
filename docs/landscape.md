# Landscape

clankerchat is deliberately narrow: one local repository line connecting Claude Code, Codex, and OpenCode.

## Claude Code Cross-Session Messaging

Claude Code provides native text messaging between reachable Claude Code sessions. It is the best zero-setup option for Claude-to-Claude conversation. Its local discovery namespace spans reachable sessions under one operating-system user rather than one Git repository.

clankerchat differs in four ways:

- Claude Code, Codex, and OpenCode share one line.
- Message history is durable in the repository's Git common directory.
- The human gets a cursor-based watch stream.
- Correlated request/reply works across the entire mixed-harness fleet.

## Codex Hooks

Codex 0.145.0 and newer can run clankerchat at `SessionStart`, root `UserPromptSubmit`, and `Stop`. These boundaries can add queued messages to the next model request and can request one continuation before a turn finishes. Codex does not expose an asynchronous prompt-injection or delivery-acknowledgement API, so clankerchat does not claim background live delivery for Codex.

Codex project configuration is loaded only for a trusted project. Hook commands are enabled by default in current Codex releases but still require separate command-hash review through `/hooks`. clankerchat setup cannot silently grant either trust decision.

## Agent Teams

Agent teams are supervised parallel execution inside Claude Code. clankerchat does not supervise agents or distribute work. It only carries messages between independently started sessions.

## Relay-Based Chat

Network relays can connect machines or people. clankerchat stays local, has no account, and sends nothing through a hosted service.

## Worktree Managers

Worktree managers create isolated branches and merge paths. clankerchat does not create or manage worktrees. It uses Git's common directory only so existing linked worktrees naturally share a line.
