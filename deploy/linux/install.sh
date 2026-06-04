#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
	echo "[bare-deploy] Linux 以外では install-linux を使えません。" >&2
	exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
CONFIG_DIR="${HOME}/.config/vicissitude"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${HOME}/.local/share/vicissitude"
RUNTIME_ENV="${CONFIG_DIR}/runtime.env"
SECRETS_ENV="${CONFIG_DIR}/secrets.env"

# shellcheck disable=SC1091
source "${REPO_ROOT}/deploy/common/nix.sh"

mkdir -p "$CONFIG_DIR" "$SYSTEMD_USER_DIR" "$BIN_DIR" "$DATA_DIR"

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

install -m 0644 "${REPO_ROOT}/deploy/linux/vicissitude-bot.service" "${SYSTEMD_USER_DIR}/vicissitude-bot.service"
install -m 0644 "${REPO_ROOT}/deploy/linux/vicissitude-web.service" "${SYSTEMD_USER_DIR}/vicissitude-web.service"

cd "$REPO_ROOT"
NIX_BIN="$(vicissitude_require_nix)"
"$NIX_BIN" run .#vicissitude-validate
"$NIX_BIN" run .#vicissitude-build-web

systemctl --user daemon-reload
systemctl --user enable --now vicissitude-bot.service vicissitude-web.service

if command -v loginctl >/dev/null 2>&1; then
	if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
		echo "[bare-deploy] ログアウト後も動かすなら: sudo loginctl enable-linger ${USER}"
	fi
fi

echo "[bare-deploy] installed. update は ${BIN_DIR}/vicissitude-update を使ってください。"
