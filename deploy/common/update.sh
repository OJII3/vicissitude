#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_ENV="${HOME}/.config/vicissitude/runtime.env"
SECRETS_ENV="${HOME}/.config/vicissitude/secrets.env"

if [[ -f "$RUNTIME_ENV" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$RUNTIME_ENV"
	set +a
fi

export APP_ROOT="${APP_ROOT:-$REPO_ROOT}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export VICISSITUDE_CONFIG_PATH="${VICISSITUDE_CONFIG_PATH:-$APP_ROOT/config/default.json}"
export WEB_DIST_DIR="${WEB_DIST_DIR:-$APP_ROOT/apps/web/dist}"

if [[ -f "$SECRETS_ENV" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$SECRETS_ENV"
	set +a
fi

cd "$APP_ROOT"

branch="$(git branch --show-current)"
if [[ "$branch" != "main" ]]; then
	echo "[bare-deploy] update は main ブランチから実行してください: current=${branch}" >&2
	exit 1
fi

worktree_status="$(git status --porcelain)"
if [[ -n "$worktree_status" ]]; then
	echo "[bare-deploy] update 元に未コミット変更があります。clean worktree にしてください。" >&2
	exit 1
fi

git fetch origin refs/heads/main:refs/remotes/origin/main
git pull --ff-only origin main

nix run .#vicissitude-validate
nix run .#vicissitude-build-web

if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files >/dev/null 2>&1; then
	systemctl --user restart vicissitude-web.service vicissitude-bot.service
	exit 0
fi

if command -v launchctl >/dev/null 2>&1; then
	uid="$(id -u)"
	launchctl kickstart -k "gui/${uid}/dev.ojii3.vicissitude.web" >/dev/null 2>&1 || true
	launchctl kickstart -k "gui/${uid}/dev.ojii3.vicissitude.bot" >/dev/null 2>&1 || true
	exit 0
fi

echo "[bare-deploy] update 完了。service の再起動は手動で行ってください。"
