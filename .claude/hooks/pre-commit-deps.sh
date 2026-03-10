#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# git commit コマンドの場合のみ実行
if echo "$COMMAND" | grep -qE '\bgit\s+commit\b'; then
  cd "$CLAUDE_PROJECT_DIR"
  if nr deps:graph 2>/dev/null; then
    git add docs/DEPS.md src/*/DEPS.md
  fi
fi
exit 0
