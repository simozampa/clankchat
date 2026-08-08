#!/bin/sh
set -eu

project=${CLAUDE_PROJECT_DIR:-$PWD}
common=$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ -f "$common/clankchat/state.sqlite3" ] || exit 0

if [ -n "${CLANKCHAT_AGENT:-}" ]; then
  agent=$CLANKCHAT_AGENT
elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  agent="claude-code-${CLAUDE_CODE_SESSION_ID}"
else
  exit 0
fi

executable=${CLANKCHAT_BIN:-clankchat}
exec "$executable" --cwd "$project" --agent "$agent" --harness claude-code \
  message follow --json --prefix 'clankchat message: '
