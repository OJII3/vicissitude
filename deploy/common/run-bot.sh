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

if [[ -f "$SECRETS_ENV" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$SECRETS_ENV"
	set +a
fi

mkdir -p \
	"$XDG_CONFIG_HOME/vicissitude" \
	"$XDG_DATA_HOME/opencode" \
	"$XDG_DATA_HOME/vicissitude" \
	"$APP_ROOT/data"

cd "$APP_ROOT"
exec nix run .#vicissitude -- "$@"
