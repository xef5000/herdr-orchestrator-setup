#!/usr/bin/env bash
# herdr swarm launcher
#
# Opens a new tab in the current herdr workspace with 5 panes, each running a
# named pi agent with a role-specific system prompt:
#
#   ┌──────────────┬──────────────┬──────────────┐
#   │ orchestrator │    impl1     │              │
#   ├──────────────┼──────────────┤   reviewer   │
#   │   planner    │    impl2     │              │
#   └──────────────┴──────────────┴──────────────┘
#
# Usage:
#   launch.sh [--cwd DIR] [--prefix NAME] [--workspace ID] [--goal "text"]
#
#   --cwd        working directory for every agent (default: $PWD)
#   --prefix     prefix for agent names, e.g. "api-" -> api-orchestrator ...
#                (needed if a swarm is already live; names must be unique)
#   --workspace  herdr workspace id (default: $HERDR_WORKSPACE_ID or focused)
#   --goal       optional first task to hand to the orchestrator right away
#
# Models / thinking per role: edit models.conf next to this script.
# Env:
#   SWARM_MODEL      override model for ALL roles (optional)
#   SWARM_THINKING   override thinking level for ALL roles (optional)
set -euo pipefail

SWARM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLES_DIR="$SWARM_DIR/roles"

CWD=""
PREFIX=""
WS="${HERDR_WORKSPACE_ID:-}"
GOAL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --workspace) WS="$2"; shift 2 ;;
    --goal) GOAL="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- resolve the herdr binary matching the running server -------------------
resolve_herdr() {
  if [[ -n "${HERDR_BIN_PATH:-}" && -x "$HERDR_BIN_PATH" ]]; then echo "$HERDR_BIN_PATH"; return; fi
  if [[ -n "${HERDR_BIN:-}" && -x "$HERDR_BIN" ]]; then echo "$HERDR_BIN"; return; fi
  local srv
  srv="$(ps -axo args= | awk '/herdr server$/ && !/awk/ {print $1; exit}')"
  if [[ -n "$srv" && -x "$srv" ]]; then echo "$srv"; return; fi
  if command -v herdr >/dev/null 2>&1; then command -v herdr; return; fi
  echo "herdr binary not found" >&2; exit 1
}
H="$(resolve_herdr)"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# ---- resolve workspace -------------------------------------------------------
if [[ -z "$WS" ]]; then
  WS="$("$H" workspace list | jq -r '.result.workspaces[] | select(.focused) | .workspace_id')"
fi
[[ -n "$WS" ]] || { echo "could not determine workspace" >&2; exit 1; }

# ---- resolve cwd: explicit > inside a herdr pane ($PWD) > focused pane's cwd > $HOME
if [[ -z "$CWD" ]]; then
  if [[ "${HERDR_ENV:-}" == "1" ]]; then
    CWD="$PWD"
  else
    CWD="$("$H" pane current 2>/dev/null | jq -r '.result.pane.foreground_cwd // .result.pane.cwd // empty')"
    CWD="${CWD:-$HOME}"
  fi
fi
CWD="$(cd "$CWD" && pwd)"
PROJECT="$(basename "$CWD")"

# ---- refuse name collisions --------------------------------------------------
ROLES=(orchestrator planner impl1 impl2 reviewer)
LIVE="$("$H" agent list | jq -r '.result.agents[]?.name // empty')"
for r in "${ROLES[@]}"; do
  if grep -qx "${PREFIX}${r}" <<<"$LIVE"; then
    echo "agent '${PREFIX}${r}' is already live; pass --prefix <something> to start a second swarm" >&2
    exit 1
  fi
done

# ---- create tab + 5-pane layout ---------------------------------------------
echo "▶ creating swarm tab in $WS ($CWD)"
T="$("$H" tab create --workspace "$WS" --cwd "$CWD" --label "swarm:${PREFIX}${PROJECT}" --focus)"
TAB="$(jq -r .result.tab.tab_id <<<"$T")"
P_ORCH="$(jq -r .result.root_pane.pane_id <<<"$T")"

split() { # split <pane> <direction> <ratio>
  "$H" pane split --pane "$1" --direction "$2" --ratio "$3" --cwd "$CWD" --no-focus | jq -r .result.pane.pane_id
}

P_IMPL1="$(split "$P_ORCH"  right 0.3334)"   # col1 | col2+col3
P_REV="$(split "$P_IMPL1"   right 0.5)"      # col2 | col3
P_PLAN="$(split "$P_ORCH"   down  0.5)"      # col1: orch / planner
P_IMPL2="$(split "$P_IMPL1" down  0.5)"      # col2: impl1 / impl2

# (bash 3.2 on macOS: no associative arrays)
pane_for() {
  case "$1" in
    orchestrator) echo "$P_ORCH" ;;
    planner)      echo "$P_PLAN" ;;
    impl1)        echo "$P_IMPL1" ;;
    impl2)        echo "$P_IMPL2" ;;
    reviewer)     echo "$P_REV" ;;
  esac
}

for r in "${ROLES[@]}"; do
  "$H" pane rename "$(pane_for "$r")" "${PREFIX}${r}" >/dev/null
done

# ---- wait for shells to be at a prompt --------------------------------------
# Ready = the foreground process group is exactly the shell itself (no child
# running, e.g. slow .zshrc / dev hooks), observed twice in a row.
shell_at_prompt() {
  "$H" pane process-info --pane "$1" 2>/dev/null | jq -e '
    .result.process_info as $p
    | ($p.foreground_processes | length) == 1
      and $p.foreground_processes[0].pid == $p.shell_pid
      and ($p.foreground_processes[0].name | test("^-?(zsh|bash|fish|sh)$"))' >/dev/null 2>&1
}
wait_shell() { # wait_shell <pane>
  # Git Bash / MSYS on native Windows: herdr has no Unix foreground process groups
  # there, so process-info cannot prove readiness. Give the shell a moment instead.
  case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) sleep "${SWARM_SHELL_WAIT:-4}"; return 0 ;; esac
  local i stable=0
  for i in $(seq 1 120); do   # up to ~60s
    if shell_at_prompt "$1"; then
      stable=$((stable+1)); [[ $stable -ge 2 ]] && return 0
    else
      stable=0
    fi
    sleep 0.5
  done
  return 1
}

# ---- start a pi agent in each pane ------------------------------------------
MODELS_CONF="$SWARM_DIR/models.conf"
model_for()    { awk -v r="$1" '$1==r {print $2}' "$MODELS_CONF" 2>/dev/null; }
thinking_for() { awk -v r="$1" '$1==r {print $3}' "$MODELS_CONF" 2>/dev/null; }

# pi flags for a role: --model/--thinking from models.conf, env vars win.
pi_model_args() { # pi_model_args <role>  -> prints args one per line
  local m t
  m="${SWARM_MODEL:-$(model_for "$1")}"
  t="${SWARM_THINKING:-$(thinking_for "$1")}"
  [[ -n "$m" ]] && printf '%s\n' --model "$m"
  [[ -n "$t" ]] && printf '%s\n' --thinking "$t"
  return 0
}

TEAM_FILE="$(mktemp -t herdr-swarm-team.XXXXXX.md)"
cat >"$TEAM_FILE" <<EOF

# Swarm context (injected by herdr swarm launcher)

You are one agent in a 5-agent swarm running inside herdr, all in \`$CWD\`.
Live agent names (use these exact names with \`herdr agent ...\`):

| role         | agent name               | model (thinking)                      | tier |
|--------------|--------------------------|---------------------------------------|------|
| orchestrator | ${PREFIX}orchestrator    | $(model_for orchestrator) ($(thinking_for orchestrator)) | coordinator |
| planner      | ${PREFIX}planner         | $(model_for planner) ($(thinking_for planner))           | strongest, read-only |
| impl1        | ${PREFIX}impl1           | $(model_for impl1) ($(thinking_for impl1))               | cheap+fast: needs explicit tasks |
| impl2        | ${PREFIX}impl2           | $(model_for impl2) ($(thinking_for impl2))               | stronger: harder tasks |
| reviewer     | ${PREFIX}reviewer        | $(model_for reviewer) ($(thinking_for reviewer))         | strong, read-only |

Messaging between agents goes through the herdr CLI (binary: \`$H\`, also \`\$HERDR_BIN_PATH\`):

- Send a message / task:   \`herdr agent prompt <name> "<text>"\`
- Send and wait for reply: \`herdr agent prompt <name> "<text>" --wait --timeout 600000\`
- Read what an agent said: \`herdr agent read <name> --source recent-unwrapped --lines 150\`
- Check state:             \`herdr agent get <name>\`  (idle | working | blocked | done)
- Wait for state:          \`herdr agent wait <name> --until idle --timeout 600000\`

Keep messages self-contained: the receiver has NO access to your context. Include file paths,
acceptance criteria, and what to reply with. When you finish a task someone gave you, reply to
them with \`herdr agent prompt <sender> "DONE <task>: <short summary + files touched>"\`.
Never close panes/tabs/workspaces. Never answer another agent's approval dialog.
EOF

start_agent() { # start_agent <role>
  local role="$1" name="${PREFIX}$1" pane
  pane="$(pane_for "$1")"
  wait_shell "$pane" || echo "  (warning: shell in $pane not confirmed idle, trying anyway)"
  local margs=() line
  while IFS= read -r line; do margs+=("$line"); done < <(pi_model_args "$role")
  echo "▶ starting pi as '$name' in $pane  (${margs[*]:-default model})"
  local attempt out
  for attempt in 1 2 3 4; do
    if out="$("$H" agent start "$name" --kind pi --pane "$pane" --timeout 60000 -- \
        ${margs[@]+"${margs[@]}"} \
        --name "$name" \
        --append-system-prompt "$ROLES_DIR/$role.md" \
        --append-system-prompt "$TEAM_FILE" 2>&1)"; then
      return 0
    fi
    if grep -q agent_pane_busy <<<"$out"; then
      echo "  ($name: pane busy, retrying in 2s)"; sleep 2; wait_shell "$pane" || true
    else
      echo "  ✗ $name failed: $out" >&2; return 1
    fi
  done
  echo "  ✗ $name failed after retries: $out" >&2; return 1
}

FAILED=0
for r in "${ROLES[@]}"; do
  start_agent "$r" &
done
for job in $(jobs -p); do wait "$job" || FAILED=1; done

if [[ $FAILED -ne 0 ]]; then
  echo "✗ some agents failed to start. Fix: click the empty pane and run:  herdr agent start <role> --kind pi --pane <id> -- --name <role> --append-system-prompt $ROLES_DIR/<role>.md" >&2
  exit 1
fi

# ---- brief the orchestrator --------------------------------------------------
"$H" agent focus "${PREFIX}orchestrator" >/dev/null || true

if [[ -n "$GOAL" ]]; then
  "$H" agent prompt "${PREFIX}orchestrator" "$GOAL" >/dev/null
  echo "▶ goal handed to ${PREFIX}orchestrator"
else
  echo "▶ swarm ready in tab $TAB. Type your goal into the '${PREFIX}orchestrator' pane."
fi
