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
export WEB_DIST_DIR="${WEB_DIST_DIR:-$APP_ROOT/apps/web/dist}"
export WEB_PORT="${WEB_PORT:-4000}"

if [[ -f "$SECRETS_ENV" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$SECRETS_ENV"
	set +a
fi

mkdir -p "$XDG_CONFIG_HOME/vicissitude" "$XDG_DATA_HOME/vicissitude"

cd "$APP_ROOT"
if [[ ! -f "$WEB_DIST_DIR/index.html" ]]; then
	nix run .#vicissitude-build-web
fi

exec nix run .#vicissitude-web -- "$@"
