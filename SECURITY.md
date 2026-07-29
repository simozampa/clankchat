# Security Policy

## Supported Versions

SameTree is currently alpha software. Security fixes are applied to the latest release and the `main` branch.

## Reporting a Vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/simozampa/sametree/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. You can expect an initial response within seven days.

## Security Boundaries

SameTree protects its own state against malformed inputs, accidental path escapes, and conflicting transactional updates. It is not a sandbox or authorization system.

The shipped Claude Code and OpenCode integrations fail closed before recognized tool calls can leave the worktree where the harness launched. They canonicalize structured paths and effective working directories, reject symbolic-link and nested-repository escapes, and block explicit shell directory changes, external path operands, dynamic expansion, Git context overrides, worktree creation, branch switching, and branch integration commands. A workspace may share coordination across members, but it does not expand an individual harness process's filesystem boundary.

This guard is cooperative preflight validation, not process isolation. It cannot inspect the behavior of an opaque executable, script, package lifecycle command, compiler plugin, or child process after launch. Same-user time-of-check/time-of-use changes can also replace paths after validation. Use operating-system sandboxing when commands themselves are not trusted.

Processes running as the same operating-system user can:

- Write source files without acquiring a claim.
- Read or modify the local SameTree database.
- Impersonate another agent name.
- Bypass Git hooks with `--no-verify`.
- Modify repository policy and hook files.
- Disable, replace, or bypass the harness worktree guard and invoke opaque programs that write elsewhere.
- Invoke shared-instruction CLI/library APIs with `userAuthorized: true` or modify harness capture plugins.

Do not use SameTree to coordinate mutually hostile agents. Use separate operating-system accounts, containers, or worktrees when isolation is required.

The exact `For all agents:` prefix prevents accidental capture of ordinary prompts by the shipped Claude Code and OpenCode adapters. It is a cooperative authorization signal, not proof of user identity. Agent-facing MCP exposes only instruction reads and per-agent acknowledgements, but a process with the same operating-system access can still forge the prefix, call the CLI or library directly, read stored instruction text, or alter local delivery state.

Keep the SQLite database on a local filesystem. Network filesystems and file-sync services can violate SQLite locking assumptions and are unsupported.
