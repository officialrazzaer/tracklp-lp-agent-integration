#!/bin/bash
# Agent V2 — LLM ranker orchestrator. Designed to run once per minute
# from a host crontab, ~30 seconds before the entry-execute stage fires.
#
# Three phases:
#
#   Phase A (deterministic, fast): pull pending gate-passed decision rows
#                                  into $INPUT_FILE
#   Phase B (LLM):                 send a prompt to a long-lived Claude
#                                  tmux session; it reads $INPUT_FILE and
#                                  writes $OUTPUT_FILE
#   Phase C (deterministic, fast): apply $OUTPUT_FILE to
#                                  agent_entry_decisions + write one
#                                  agent_llm_calls audit row
#
# Hard rules:
#   - flock against $LOCK_FILE so multiple ranker runs (or any other
#     house cron sharing the same Claude session) can't race
#   - $TIMEOUT_S tmux response timeout — if no output by then, exit with
#     status='timeout' and let your executor fall back to consensus order
#   - The LLM is NEVER on the hot path. Your entry-execute stage reads
#     the DB directly. If this script never runs, the bot still trades;
#     it just trades in pure consensus order.
#
# Configuration: every CAPS_VAR below can be overridden by exporting it
# before invocation, e.g. WORKING_DIR=/srv/myapp RUN_AS_USER=app ./rank.sh

set -u

WORKING_DIR="${WORKING_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
TMUX_SESSION="${TMUX_SESSION:-agent}"
INPUT_FILE="${INPUT_FILE:-/tmp/agent-v2-rank-input.json}"
OUTPUT_FILE="${OUTPUT_FILE:-/tmp/agent-v2-rank-output.json}"
LOCK_FILE="${LOCK_FILE:-/tmp/agent-claude.lock}"
TIMEOUT_S="${TIMEOUT_S:-15}"
LOG_PREFIX="${LOG_PREFIX:-[agent-v2-rank]}"
# Optional. If set, prepare/apply run under `su - $RUN_AS_USER`. Unset
# (default) runs as the current user.
RUN_AS_USER="${RUN_AS_USER:-}"

# Wraps a command so it runs under RUN_AS_USER if set, or current user
# otherwise. We use this for the two npx tsx invocations + tmux ops.
run_user() {
  if [ -n "$RUN_AS_USER" ]; then
    su - "$RUN_AS_USER" -c "$1"
  else
    bash -c "$1"
  fi
}

# Acquire shared lock with any other Claude house cron. Non-blocking —
# if held, exit cleanly and try again next minute.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$LOG_PREFIX another claude operation in progress — skipping this tick"
  exit 0
fi

is_claude_running() {
  if [ -n "$RUN_AS_USER" ]; then
    pgrep -u "$RUN_AS_USER" -f 'claude' > /dev/null 2>&1
  else
    pgrep -f 'claude' > /dev/null 2>&1
  fi
}

# Phase A: prepare input JSON
prepare() {
  rm -f "$INPUT_FILE" "$OUTPUT_FILE"
  timeout 60 run_user "cd $WORKING_DIR && npx tsx --env-file=.env agent-v2/rankPrepare.ts --out $INPUT_FILE" 2>&1
  if [ ! -s "$INPUT_FILE" ]; then
    echo "$LOG_PREFIX Phase A: prepare produced no input"
    return 1
  fi
  local count
  count=$(python3 -c "import json; print(len(json.load(open('$INPUT_FILE'))))" 2>/dev/null || echo 0)
  if [ "$count" = "0" ]; then
    echo "$LOG_PREFIX Phase A: 0 candidates to rank — exiting"
    return 1
  fi
  echo "$LOG_PREFIX Phase A: $count candidates queued"
  return 0
}

# Phase B: send rank prompt to the Claude tmux session
send_rank() {
  local prompt
  prompt=$(cat <<EOF
You are the agent V2 ranker. Read $INPUT_FILE — each item is a gate-passed entry candidate with consensusScore, proposedStrategy, leaders, gates, tokenPair. Rank them 1..N (1 = best LP risk-adjusted bet right now), and write a one-line thesis per candidate (<=200 chars: which leaders matter, why this regime, what could break it). Output a JSON array ONLY to $OUTPUT_FILE. No prose. Schema: [{ "decisionId": "uuid", "rank": int, "thesis": "string", "confidence": 0..1 }]. Do not call any tools beyond Read and Write. Do not run code. Done = file written.
EOF
)
  echo "$LOG_PREFIX Phase B: sending rank prompt to tmux session '$TMUX_SESSION'"
  run_user "tmux send-keys -t $TMUX_SESSION '/clear' Enter"
  sleep 2
  run_user "tmux send-keys -t $TMUX_SESSION -- $(printf '%q' "$prompt") Enter"
  return 0
}

# Phase C: poll for output, apply
apply_output() {
  local elapsed=0
  local status="timeout"
  while [ "$elapsed" -lt "$TIMEOUT_S" ]; do
    if [ -s "$OUTPUT_FILE" ]; then
      status="ok"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  local duration_ms=$((elapsed * 1000))
  echo "$LOG_PREFIX Phase C: polling done status=$status duration_ms=$duration_ms"
  timeout 30 run_user "cd $WORKING_DIR && npx tsx --env-file=.env agent-v2/rankApply.ts --input $INPUT_FILE --output $OUTPUT_FILE --duration-ms $duration_ms --status $status" 2>&1
}

# --- Main ---

echo "$LOG_PREFIX Starting at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

if ! prepare; then
  exit 0
fi

if ! is_claude_running; then
  echo "$LOG_PREFIX Claude session '$TMUX_SESSION' has no claude process. Start it manually before this cron fires:"
  echo "$LOG_PREFIX   tmux new -s $TMUX_SESSION"
  echo "$LOG_PREFIX   claude --model opus"
  echo "$LOG_PREFIX Skipping this tick."
  exit 0
fi

send_rank
apply_output

echo "$LOG_PREFIX Done at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
