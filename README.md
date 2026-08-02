# SameTree

**Deliver task-linked reviews between Claude Code and OpenCode agents, no user relay required.**

[![CI](https://github.com/simozampa/sametree/actions/workflows/ci.yml/badge.svg)](https://github.com/simozampa/sametree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22.12-339933.svg)](package.json)

SameTree gives coding agents shared tasks, explicit user instructions, proposed plans, task-linked review messages, handoffs, and policy. It runs locally through MCP, with no daemon, cloud service, or external database service.

<p align="center">
  <img src="docs/demo.svg" alt="SameTree setup, task creation, review request, and same-thread findings" width="100%">
</p>

## Why SameTree

- Keep user-assigned work and agent activity visible in one place.
- Share an explicit user instruction with active and future agents without copying ordinary prompts.
- Deliver review requests and findings directly in one task-linked thread.
- Share proposed plans automatically before implementation starts.
- Deliver peer messages directly to active Claude Code and OpenCode sessions.
- Coordinate several repositories or linked worktrees when one checkout is not enough.
- Keep overlapping writers deliberate through messages or separate worktrees.
- Keep operational state local and outside tracked files.

## Install

Requires Node.js 22.12 or newer and Git. Coordination state must remain on a local disk, not a network or cloud-synced folder.

```bash
npm install --global sametree
```

This installs the `sametree` CLI and `sametree-mcp` server.

Use npm from your normal shell under a supported Node.js runtime. SameTree records that exact install runtime and pins its global entrypoints to it so harness-bundled Node versions cannot load the native SQLite binding with a different ABI. Do not install or run SameTree through `bunx`.

> SameTree is pre-1.0 alpha software. Back up important coordination state before upgrades. Stop active agents and read the [upgrade guide](docs/upgrading.md) before opening existing state with a newer SameTree release.

## Quick Start

Run setup in every working tree that will launch a harness. Setup installs or updates integrations that inject peer messages, share explicitly prefixed user instructions, and automatically publish proposed Claude Code and OpenCode plans.

```bash
cd /path/to/your/project
sametree setup --claude --opencode
git status --short
git diff
```

Review the setup result, the contents of newly created files shown by Git status, and tracked-file diffs before launching agents. Omit `--claude` or `--opencode` when unused. If every agent shares this working tree, skip the optional workspace section.

For personal coordination in a team repository, keep every SameTree integration file local:

```bash
sametree setup --local --claude --opencode
```

Local-only setup writes Claude guidance to `CLAUDE.local.md`, adds OpenCode guidance through a private config, and records its generated paths in a managed `.git/info/exclude` block. It leaves tracked `CLAUDE.md` and `AGENTS.md` unchanged and refuses to update any generated path that Git already tracks.

Git's `info/exclude` file is local to the clone but shared by linked worktrees. Remove the complete managed block before switching that clone back to repository-visible setup; SameTree refuses a non-local setup while the block remains.

## Share An Instruction

Begin a Claude Code or OpenCode user prompt with this exact, case-sensitive prefix:

```text
For all agents: Keep the public API stable while completing assigned work.
```

SameTree preserves the complete prompt text and shares it as a structurally marked user instruction. Existing agents receive the current revision directly; agents that start later discover it in status and retrieve the exact text. Ordinary prompts, leading-whitespace variants, and differently cased prefixes remain local.

Shared instructions are immutable, revisioned, and acknowledged per agent and revision. Recording, revising, or revoking one requires direct user authorization. An instruction can constrain existing work, but it does not create a task, assign new work, or expand an agent's scope.

Agents can retrieve, list, and acknowledge instructions through MCP. SameTree deliberately does not expose fleet-wide instruction mutation as an MCP tool; use the native exact-prefix flow to record one, or the user-facing CLI/library to record, revise, or revoke one.

## Automatic Workspaces

A single repository starts as an implicit one-member workspace. When the same harness session later performs a SameTree operation from another initialized repository, SameTree automatically promotes the original standalone state and joins the observed repository. It imports both repositories' existing tasks, messages, plans, instructions, and history; derives member names from directory names; and never scans sibling directories or infers membership from remotes.

The operation response includes `automaticWorkspace` with the workspace and observed member. `watch` reports `workspace.auto_created` and `member.auto_joined`. A repository already bound to another workspace produces an error instead of being rebound.

Set `"autoWorkspaceEnrollment": false` in `.sametree/config.json` when all membership changes must remain explicit. Manual lifecycle commands remain available:

```bash
cd /path/to/frontend
sametree workspace create Product --member frontend --fresh

cd /path/to/backend
sametree workspace add Product --member backend --fresh

sametree workspace status
sametree workspace doctor
```

Use `--fresh` to start without copying standalone coordination state. Use `--import-current` when existing tasks, messages, and history should move into the shared workspace. Both modes preserve the source database as an independent snapshot.

Automatic enrollment happens only after observed SameTree activity in both repositories. Membership controls which coordination state is shared between repositories and worktrees. It does not grant, restrict, or otherwise change an agent's filesystem access.

Run `sametree setup` in every workspace member that launches a harness. All members must remain on one machine and use the same local workspace registry. See [Upgrading](docs/upgrading.md) for migration, custom registry, and recovery details.

## Start Agents

After single-tree or workspace setup is complete, start agents normally in separate terminals:

```bash
claude
```

```bash
opencode
```

Each process gets its own identity and joins the coordination state for that working tree. SameTree starts with the harness, so there is no server to launch separately.

SameTree never blocks a tool call based on its path, working directory, repository membership, shell command, or Git subcommand. Agents retain whatever access their harness, user account, and operating system provide, including paths outside every SameTree workspace. Rerun setup and restart every harness after upgrading so generated integrations remove obsolete worktree guards.

Automatic OpenCode delivery requires a local TUI process. Attach mode reports the identity limitation instead of consuming messages for another process.

## Coordination Model

- Tasks record work already assigned by the user; they are not a peer-managed queue.
- Shared instructions are direct user context for existing work; they are distinct from repository policy and never create tasks.
- Plans are revisioned shared context; publishing one does not assign review or implementation work.
- Review requests and findings use ordinary messages with the same task and thread IDs.
- Messages and handoffs carry context but never change an agent's scope without user authorization.
- SameTree does not reserve files or restrict tool access; serialize likely overlap through messages or separate worktrees.
- Branch changes remain visible across linked-worktree workspace members.

Task assignments and execution leases coordinate responsibility, not filesystem access. SameTree preserves concurrent changes and routes context, but it does not merge simultaneous edits.

Agents normally use MCP tools directly. Humans and scripts can use the same state through the CLI:

```bash
SAMETREE_AGENT=human sametree status
```

## Local By Design

SameTree stores operational state in SQLite under Git's private directories or the local workspace registry. By default, policy and role files under `.sametree/` remain versioned with the repository. Use `setup --local` when those files and harness integrations must remain private to one local clone.

SameTree is for trusted processes on one machine. It does not merge simultaneous edits, synchronize files, restrict harness tool access, provide an operating-system sandbox, or support state databases on network and cloud-synced filesystems.

## Documentation

- [Architecture](docs/architecture.md): storage, routing, and concurrency
- [Protocol](docs/protocol.md): tools, state transitions, and invariants
- [Upgrading](docs/upgrading.md): migration, rollback, and workspace recovery
- [Landscape](docs/landscape.md): comparison with related tools
- [Four-agent review loop](examples/review-loop/): worker and reviewer example
- [Contributing](CONTRIBUTING.md): development and demo generation
- [Security](SECURITY.md): vulnerability reporting

## FAQ

### Can multiple Claude Code and OpenCode agents safely work in the same repository?

SameTree keeps user-assigned tasks visible and delivers review feedback directly between agents. It does not reserve files, so likely overlapping edits should be serialized through messages or isolated in separate worktrees.

### Do parallel coding agents need separate branches or Git worktrees?

No. Agents can coordinate in the same live checkout when their work is intertwined, while optional workspaces connect repositories or linked worktrees when isolation is useful.

### How do coding agents share context across sessions?

SameTree stores tasks, shared user instructions, proposed plans, messages, handoffs, and policy acknowledgements in local SQLite. Its Claude Code and OpenCode adapters capture only exactly prefixed instructions, publish plans, and deliver structured updates to active sessions.

### Is SameTree a Conductor alternative?

[Conductor](https://conductor.build/) gives each task an isolated workspace, branch, files, and merge path. SameTree instead coordinates cooperative agents in existing local checkouts and surfaces integration risks between linked worktrees.

### How is SameTree different from agent-talk?

[agent-talk](https://github.com/xhluca/agent-talk) provides encrypted agent messaging across people and machines through a relay. SameTree stays on one machine and adds shared tasks, task-linked review threads, handoffs, policy, and Git checks.

### Does SameTree work across multiple machines?

No. SameTree coordinates repositories and worktrees accessible on one machine; use a networked coordination or messaging tool across machines.

## License

[MIT](LICENSE)
