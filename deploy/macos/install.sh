#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "[bare-deploy] macOS 以外では install-macos を使えません。" >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG_DIR="${HOME}/.config/vicissitude"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/vicissitude"
RUNTIME_ENV="${CONFIG_DIR}/runtime.env"
SECRETS_ENV="${CONFIG_DIR}/secrets.env"
BOT_PLIST="${LAUNCH_AGENTS_DIR}/dev.ojii3.vicissitude.bot.plist"
WEB_PLIST="${LAUNCH_AGENTS_DIR}/dev.ojii3.vicissitude.web.plist"

mkdir -p "$CONFIG_DIR" "$LAUNCH_AGENTS_DIR" "$BIN_DIR" "$DATA_DIR/logs"

cat >"$RUNTIME_ENV" <<EOF
APP_ROOT=${REPO_ROOT}
VICISSITUDE_CONFIG_PATH=${REPO_ROOT}/config/default.json
WEB_DIST_DIR=${REPO_ROOT}/apps/web/dist
XDG_CONFIG_HOME=${HOME}/.config
XDG_DATA_HOME=${HOME}/.local/share
WEB_PORT=4000
EOF

if [[ ! -f "$SECRETS_ENV" ]]; then
	cat >"$SECRETS_ENV" <<EOF
DISCORD_TOKEN=
# Optional: GitHub integration
# GITHUB_TOKEN=
# GITHUB_OWNER=
# GITHUB_REPO=
# Optional: shell workspace / GitHub auth
# HUA_GITHUB_TOKEN=
EOF
fi

ln -sfn "${REPO_ROOT}/deploy/common/run-bot.sh" "${BIN_DIR}/vicissitude-bot"
ln -sfn "${REPO_ROOT}/deploy/common/run-web.sh" "${BIN_DIR}/vicissitude-web"
ln -sfn "${REPO_ROOT}/deploy/common/update.sh" "${BIN_DIR}/vicissitude-update"

sed \
	-e "s|__HOME__|${HOME}|g" \
	"${REPO_ROOT}/deploy/macos/dev.ojii3.vicissitude.bot.plist.template" >"$BOT_PLIST"
sed \
	-e "s|__HOME__|${HOME}|g" \
	"${REPO_ROOT}/deploy/macos/dev.ojii3.vicissitude.web.plist.template" >"$WEB_PLIST"

cd "$REPO_ROOT"
nix run .#vicissitude-validate
nix run .#vicissitude-build-web

uid="$(id -u)"
launchctl bootout "gui/${uid}" "$BOT_PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/${uid}" "$WEB_PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${uid}" "$BOT_PLIST"
launchctl bootstrap "gui/${uid}" "$WEB_PLIST"
launchctl kickstart -k "gui/${uid}/dev.ojii3.vicissitude.bot"
launchctl kickstart -k "gui/${uid}/dev.ojii3.vicissitude.web"

echo "[bare-deploy] installed. update は ${BIN_DIR}/vicissitude-update を使ってください。"
