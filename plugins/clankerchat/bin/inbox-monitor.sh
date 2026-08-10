#!/bin/sh
set -eu

project=${CLAUDE_PROJECT_DIR:-$PWD}
scope=${CLANKERCHAT_SCOPE:-${CLANKCHAT_SCOPE:-auto}}
case "$scope" in auto|repository|global) ;; *) exit 0 ;; esac

for name in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

user_setup=false
if [ -f "$HOME/.claude/CLAUDE.md" ] && grep -Fq '<!-- clankerchat:user:start -->' "$HOME/.claude/CLAUDE.md"; then
  user_setup=true
fi

child_scope=$scope
if [ "$scope" = auto ] && [ "$user_setup" = false ]; then
  child_scope=repository
fi

binding_scope=
binding_database=
binding_token=
native=${CLAUDE_CODE_SESSION_ID:-}
case "$native" in ''|*[!A-Za-z0-9._-]*) ;; *)
  if [ -n "${XDG_STATE_HOME:-}" ]; then
    state_base=$XDG_STATE_HOME
  elif [ "$(uname -s)" = Darwin ]; then
    state_base="$HOME/Library/Application Support"
  else
    state_base="$HOME/.local/state"
  fi
  binding="$state_base/clankerchat/harness-bindings/claude-code-$native.binding"
  if [ -f "$binding" ]; then
    tab=$(printf '\t')
    IFS="$tab" read -r binding_version binding_scope binding_owner binding_expires binding_token < "$binding"
    binding_database=$(sed -n '2p' "$binding")
    case "$binding_version:$binding_scope:$binding_owner:$binding_expires:$binding_token:$binding_database" in
      1:repository:[0-9]*:[0-9]*:*:?*|1:global:[0-9]*:[0-9]*:*:?*) ;;
      *) exit 0 ;;
    esac
    kill -0 "$binding_owner" 2>/dev/null || exit 0
    [ "$binding_expires" -gt "$(($(date +%s) * 1000))" ] || exit 0
  fi
;;
esac
case "$binding_scope" in repository|global)
  [ "$scope" = auto ] || [ "$scope" = "$binding_scope" ] || exit 0
  child_scope=$binding_scope
;; '') [ "$scope" != auto ] || exit 0 ;; *) exit 0 ;; esac

if [ -n "$binding_database" ]; then
  export CLANKERCHAT_EXPECTED_DATABASE_PATH_BASE64=$binding_database
  export CLANKERCHAT_BINDING_FILE=$binding
  export CLANKERCHAT_BINDING_TOKEN=$binding_token
fi

if [ "$child_scope" = repository ]; then
  common=$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  if [ "$user_setup" = false ]; then
    [ -f "$common/clankerchat/state.sqlite3" ] || [ -f "$common/clankchat/state.sqlite3" ] || exit 0
  fi
fi

if [ -n "${CLANKERCHAT_AGENT:-${CLANKCHAT_AGENT:-}}" ]; then
  agent=${CLANKERCHAT_AGENT:-$CLANKCHAT_AGENT}
elif [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  agent="claude-code-${CLAUDE_CODE_SESSION_ID}"
else
  exit 0
fi

executable=clankerchat
if [ -z "$binding_token" ]; then
  exec "$executable" --cwd "$project" --scope "$child_scope" --agent "$agent" --harness claude-code \
    message follow --json --prefix 'clankerchat message: '
fi

"$executable" --cwd "$project" --scope "$child_scope" --agent "$agent" --harness claude-code \
  message follow --json --prefix 'clankerchat message: ' &
child=$!
trap 'kill "$child" 2>/dev/null || true' EXIT INT TERM
while kill -0 "$child" 2>/dev/null; do
  sleep 5
  [ -f "$binding" ] || break
  tab=$(printf '\t')
  IFS="$tab" read -r current_version current_scope current_owner current_expires current_token < "$binding"
  current_database=$(sed -n '2p' "$binding")
  [ "$current_version:$current_scope:$current_token:$current_database" = \
    "$binding_version:$binding_scope:$binding_token:$binding_database" ] || break
  kill -0 "$current_owner" 2>/dev/null || break
  [ "$current_expires" -gt "$(($(date +%s) * 1000))" ] || break
done
kill "$child" 2>/dev/null || true
wait "$child" 2>/dev/null || true
