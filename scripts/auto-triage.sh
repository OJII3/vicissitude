#!/usr/bin/env bash
set -uo pipefail

PROJECT_DIR="/home/ojii3/src/github.com/ojii3/vicissitude"
LOG_DIR="${PROJECT_DIR}/logs/auto-triage"
MAX_BUDGET_USD=10
INTERVAL_SEC=$((2 * 60 * 60))  # 2 hours

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

run_once() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local log_file="${LOG_DIR}/${timestamp}.log"
  local json_log="${LOG_DIR}/${timestamp}.jsonl"

  echo "[${timestamp}] auto-triage starting" | tee "$log_file"

  # main を最新化（worktree のベースになる）
  git fetch origin main 2>&1 | tee -a "$log_file"

  # --worktree で独立したワーキングツリーで作業（main を汚さない）
  claude -p "/auto-triage" \
    --dangerously-skip-permissions \
    --max-budget-usd "$MAX_BUDGET_USD" \
    --no-session-persistence \
    --output-format stream-json \
    --verbose \
    --worktree \
    2>>"$log_file" \
    | tee "$json_log" \
    | jq -r --unbuffered 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text // empty' \
    | tee -a "$log_file"

  local exit_code
  exit_code=${PIPESTATUS[0]}
  echo "[$(date +%Y%m%d-%H%M%S)] auto-triage finished (exit: ${exit_code})" | tee -a "$log_file"
  return "$exit_code"
}

echo "auto-triage loop: every ${INTERVAL_SEC}s ($(( INTERVAL_SEC / 3600 ))h)"
echo "logs: ${LOG_DIR}/"
echo "pid: $$"
echo "---"

while true; do
  run_once || echo "[$(date +%Y%m%d-%H%M%S)] run failed (exit $?), continuing..."
  echo "next run in ${INTERVAL_SEC}s ($(date -d "+${INTERVAL_SEC} seconds" +%H:%M))"
  sleep "$INTERVAL_SEC"
done
