# Security

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/simozampa/clankerchat/security/advisories/new). Do not include secrets or private repository data in a public issue.

## Trust Model

clankerchat is for trusted processes running as one operating-system user on one machine. It is not an authentication boundary or sandbox.

Any process with access to a repository's Git common directory can read or alter that repository database. Any process running as the same operating-system user can read or alter the shared user line. Agent names are cooperative identities. A process can invoke the CLI directly, forge a name, or modify generated integration files.

Peer messages never grant harness permissions. Claude Code, Codex, and OpenCode apply their own command, filesystem, and network controls when reacting to a message.

## Data

Messages and event bodies are stored unencrypted. Repository state uses `<git-common-dir>/clankchat/state.sqlite3` during the compatibility window. User-line state and private harness scope bindings use `$XDG_STATE_HOME/clankerchat` or the documented platform fallback. Do not send secrets that should not be visible to every process in the selected trust boundary.

Automatic scope falls back to the user line only when a path is conclusively outside Git. If Git is unavailable, clankerchat first checks every ancestor for a `.git` marker; a marker, other Git errors, corrupt metadata, bare repositories, and unsafe paths fail instead. Use `--scope repository` when a command must never access the user line.

Keep the database on a local filesystem. Network and cloud-synchronized filesystems can violate SQLite locking assumptions and are unsupported.

## Integrations

Prompt capture and delivery fail open. An integration error may delay or duplicate a message, but it must never block normal harness operation. OpenCode uses stable delivery metadata to reduce duplicates across retries. A process crash at a transport boundary can still make universal exactly-once model observation impossible.

Codex hooks run outside the Codex sandbox. Review clankerchat hook command hashes through Codex `/hooks`; setup does not grant command trust. Codex delivery occurs only at lifecycle boundaries and has no persistence acknowledgement callback.

Setup refuses symlinked generated paths and changes only exact known integration structures. Repository setup limits cleanup to the current repository. User setup is explicit, uses a per-user lock, and does not scan or clean other repositories. Modified or ambiguously owned entries are rejected rather than overwritten or removed.
