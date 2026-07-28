# Upgrading SameTree

SameTree is pre-1.0 alpha software. Back up coordination state before upgrades and do not mix versions against the same database.

## Upgrade To 0.1.5

Version 0.1.5 preflights MCP session recovery before every tool call. The first read-only or lease-sensitive request after system sleep replaces an expired session before the harness can render `TASK_UNAVAILABLE`.

1. Stop every Claude Code, OpenCode, SameTree MCP, watcher, and message follower process using the coordination database.
2. Install `npm install --global sametree@0.1.5 --force` from your normal Node.js shell.
3. Rerun `sametree setup --claude --opencode`, adding `--local` for personal-only coordination and omitting unused harnesses.
4. Restart every Claude Code and OpenCode process.

## Upgrade To 0.1.4

Version 0.1.4 includes the 0.1.3 local-only setup and sleep-recovery changes while correcting the packaged Claude Code plugin metadata. Install `0.1.4` instead of `0.1.3` so Claude Code can verify and load the matching plugin version without a duplicate hooks registration.

1. Stop every Claude Code, OpenCode, SameTree MCP, watcher, and message follower process using the coordination database.
2. Install `npm install --global sametree@0.1.4 --force` from your normal Node.js shell.
3. Rerun `sametree setup --claude --opencode`, adding `--local` for personal-only coordination and omitting unused harnesses.
4. Restart every Claude Code and OpenCode process.

## Upgrade To 0.1.3

Version 0.1.3 adds personal-only harness setup and transparently replaces an expired MCP session after system sleep. Recovery preserves and renews only still-valid task and path leases; expired leases remain expired.

1. Finish or pause work and stop every Claude Code, OpenCode, SameTree MCP, watcher, message follower, and other process using each standalone or workspace database.
2. Back up every `state.sqlite3` with its `-wal` and `-shm` sidecars as one coherent set while all processes are stopped.
3. Install `npm install --global sametree@0.1.3 --force` from your normal Node.js shell.
4. For repository-visible coordination, rerun `sametree setup --claude --opencode`, omitting unused harnesses.
5. For personal-only coordination, first remove earlier SameTree imports or managed blocks from tracked `CLAUDE.md` and `AGENTS.md`, then run `sametree setup --local --claude --opencode`. Local setup refuses to continue while repository-visible SameTree instructions remain.
6. Review `git status` and tracked-file diffs, then restart every harness.

The local-only exclude block is private to the Git clone and therefore shared by linked worktrees in that clone. Remove the complete managed block before intentionally switching the clone back to repository-visible setup.

## Upgrade To 0.1.2

Version 0.1.2 consolidates the current prelaunch feature set: multi-repository workspace coordination, linked-worktree support, automatic plan sharing, explicit shared user instructions, live Claude Code and OpenCode message delivery, safer setup recovery, native Node runtime pinning, and resilient SQLite writer contention handling.

1. Finish or pause work and stop every Claude Code, OpenCode, SameTree MCP, watcher, message follower, and other process using each standalone or workspace database.
2. Back up every `state.sqlite3` with its `-wal` and `-shm` sidecars as one coherent set while all processes are stopped.
3. Install `npm install --global sametree@0.1.2 --force` from your normal Node.js shell. Do not use `bunx` or rebuild `better-sqlite3` from inside a harness.
4. Rerun `sametree setup --claude --opencode` in every physical worktree that launches a harness, omitting unused harnesses. Review setup statuses and tracked-file diffs.
5. Restart the harnesses. SameTree migrates older coordination databases in place when they are first opened.

Do not run additional manual message followers alongside the managed Claude Code and OpenCode integrations. SameTree waits for transient SQLite writer contention, but duplicate unmanaged followers create needless sessions and database writes.

Automatic shared-instruction capture is deliberately narrow. Only a prompt beginning at its first character with the exact, case-sensitive prefix `For all agents:` is recorded. Proposed plans and peer messages remain non-authoritative context and do not assign work or override user scope.

There is no automatic schema downgrade. To roll back, stop every SameTree process, remove the complete current database set, restore an exact coherent backup created by the older version, reinstall that version, and rerun setup.
