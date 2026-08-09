# Security

## Reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/simozampa/clankchat/security/advisories/new). Do not include secrets or private repository data in a public issue.

## Trust Model

clankchat is for trusted processes running as one operating-system user on one machine. It is not an authentication boundary or sandbox.

Any process with access to the repository's Git common directory can read or alter the SQLite database. Agent names are cooperative identities. A process can invoke the CLI directly, forge a name, or modify generated integration files.

Peer messages never grant harness permissions. Claude Code, Codex, and OpenCode apply their own command, filesystem, and network controls when reacting to a message.

## Data

Messages and event bodies are stored unencrypted at `<git-common-dir>/clankchat/state.sqlite3`. Do not send secrets that should not be visible to every trusted process with local repository access.

Keep the database on a local filesystem. Network and cloud-synchronized filesystems can violate SQLite locking assumptions and are unsupported.

## Integrations

Prompt capture and delivery fail open. An integration error may delay or duplicate a message, but it must never block normal harness operation. OpenCode uses stable delivery metadata to reduce duplicates across retries. A process crash at a transport boundary can still make universal exactly-once model observation impossible.

Codex hooks run outside the Codex sandbox. Review clankchat hook command hashes through Codex `/hooks`; setup does not grant command trust. Codex delivery occurs only at lifecycle boundaries and has no persistence acknowledgement callback.

Setup refuses symlinked generated paths and preserves unrelated JSONC, JSON, and TOML configuration while removing exact stale branded entries.
