#!/usr/bin/env bash

vicissitude_find_nix() {
	if command -v nix >/dev/null 2>&1; then
		command -v nix
		return 0
	fi

	local candidate
	for candidate in \
		"${HOME}/.nix-profile/bin/nix" \
		"/nix/var/nix/profiles/default/bin/nix" \
		"/run/current-system/sw/bin/nix"
	do
		if [[ -x "$candidate" ]]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done

	return 1
}

vicissitude_require_nix() {
	local nix_bin
	if ! nix_bin="$(vicissitude_find_nix)"; then
		echo "[bare-deploy] nix コマンドが見つかりません。PATH または標準 profile を確認してください。" >&2
		return 1
	fi

	export PATH
	PATH="$(dirname "$nix_bin")${PATH:+:$PATH}"
	printf '%s\n' "$nix_bin"
}
