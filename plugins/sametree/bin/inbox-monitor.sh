#!/bin/sh
set -eu

project=${CLAUDE_PROJECT_DIR:-$PWD}
git_root=$(git -C "$project" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$git_root/.sametree/config.json" ] || exit 0

if [ -n "${SAMETREE_AGENT:-}" ]; then
  agent=$SAMETREE_AGENT
elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  agent="claude-code-${CLAUDE_CODE_SESSION_ID}"
else
  printf '%s\n' 'SameTree: CLAUDE_CODE_SESSION_ID is unavailable; inbox monitor stopped.' >&2
  exit 1
fi

executable=${SAMETREE_BIN:-sametree}

exec "$executable" --cwd "$project" --agent "$agent" --harness claude-code \
  message follow --json --prefix 'SameTree message: '
