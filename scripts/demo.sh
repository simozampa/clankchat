#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$(mktemp -d)"
CLI=(node "$ROOT/dist/cli.js")

cleanup() {
  rm -rf "$DEMO"
}
trap cleanup EXIT

prompt() {
  printf '\033[1;36m$\033[0m %s\n' "$1"
  sleep 0.7
}

git init --quiet --initial-branch=main "$DEMO"
cd "$DEMO"

printf '\033[1;35mSameTree: deliver reviews without user relay\033[0m\n\n'

prompt 'sametree setup --opencode'
"${CLI[@]}" setup --opencode | jq -r '"ready: launch " + (.restartCommands | join(" or "))'

SAMETREE_AGENT=agent-b SAMETREE_HARNESS=opencode \
  "${CLI[@]}" status >/dev/null

prompt 'agent-a records and starts its assigned task'
task_json="$(SAMETREE_AGENT=agent-a SAMETREE_HARNESS=opencode \
  "${CLI[@]}" task create --title 'Add request validation' --priority high)"
task_id="$(jq -r '.id' <<<"$task_json")"
SAMETREE_AGENT=agent-a "${CLI[@]}" task start "$task_id" >/dev/null
printf 'task:  %s (in progress)\n' "$(jq -r '.title' <<<"$task_json")"

prompt 'agent-a sends a task-linked review request'
request_json="$(SAMETREE_AGENT=agent-a "${CLI[@]}" message send \
  --to agent-b --subject 'Review request validation' \
  --body 'Commit abc123; npm test passes.' --task "$task_id")"
thread_id="$(jq -r '.threadId' <<<"$request_json")"
SAMETREE_AGENT=agent-b "${CLI[@]}" message inbox --unread \
  | jq -r '.[0] | "received: " + .subject + " [task linked]"'

prompt 'agent-b returns a finding in the same thread'
SAMETREE_AGENT=agent-b "${CLI[@]}" message send \
  --to agent-a --subject 'P1: reject an empty token' \
  --body 'src/api.ts:42 accepts an empty token.' \
  --task "$task_id" --thread "$thread_id" >/dev/null
SAMETREE_AGENT=agent-a "${CLI[@]}" message inbox --unread \
  | jq -r --arg thread "$thread_id" '.[0] | "finding: " + .subject + if .threadId == $thread then " [same thread]" else "" end'

printf '\n\033[1;32mTasks stay linked. Review context arrives directly and locally.\033[0m\n'
sleep 1
