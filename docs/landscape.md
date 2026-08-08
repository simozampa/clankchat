# Landscape

clankchat is deliberately narrow: one local repository line connecting Claude Code and OpenCode.

## Claude Code Cross-Session Messaging

Claude Code provides native text messaging between reachable Claude Code sessions. It is the best zero-setup option for Claude-to-Claude conversation. Its local discovery namespace spans reachable sessions under one operating-system user rather than one Git repository.

clankchat differs in four ways:

- Claude Code and OpenCode share one line.
- Message history is durable in the repository's Git common directory.
- The human gets a cursor-based watch stream.
- Correlated request/reply works across the entire mixed-harness fleet.

## Agent Teams

Agent teams are supervised parallel execution inside Claude Code. clankchat does not supervise agents or distribute work. It only carries messages between independently started sessions.

## Relay-Based Chat

Network relays can connect machines or people. clankchat stays local, has no account, and sends nothing through a hosted service.

## Worktree Managers

Worktree managers create isolated branches and merge paths. clankchat does not create or manage worktrees. It uses Git's common directory only so existing linked worktrees naturally share a line.
