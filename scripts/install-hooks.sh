#!/usr/bin/env bash
# git hooks をインストールするスクリプト
# bun install 時に自動実行される（package.json の prepare スクリプト）

HOOKS_DIR="$(git rev-parse --show-toplevel)/.githooks"
if [ -d "$HOOKS_DIR" ]; then
  git config core.hooksPath .githooks
  echo "Git hooks installed from .githooks/"
fi
