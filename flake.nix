{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      imports = [
        inputs.git-hooks.flakeModule
      ];

      perSystem =
        { pkgs, config, ... }:
        let
          claude-loop = pkgs.writeShellScriptBin "claude-loop" ''
            set -euo pipefail
            REPO_DIR="$(cd "$(dirname "$0")/../.."; pwd)"
            cd "${toString ./.}"

            SESSION_NAME="vicissitude-claude"
            INTERVAL="''${1:-2h}"
            PROMPT_FILE=".claude/prompts/cron.md"

            if ! command -v claude &>/dev/null; then
              echo "Error: claude command not found" >&2
              exit 1
            fi

            if ! command -v tmux &>/dev/null; then
              echo "Error: tmux command not found" >&2
              exit 1
            fi

            if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
              echo "Session '$SESSION_NAME' already exists. Attach with: tmux attach -t $SESSION_NAME"
              exit 0
            fi

            tmux new-session -d -s "$SESSION_NAME" "while true; do echo \"[$(date)] Starting claude task...\"; claude -p \"\$(cat $PROMPT_FILE)\" --permission-mode auto --max-budget-usd 10; echo \"[$(date)] Done. Sleeping $INTERVAL...\"; sleep $INTERVAL; done"
            echo "Started tmux session '$SESSION_NAME' (interval: $INTERVAL)"
            echo "  Attach:  tmux attach -t $SESSION_NAME"
            echo "  Stop:    tmux kill-session -t $SESSION_NAME"
          '';
        in
        {
          apps.claude-loop = {
            type = "app";
            program = "${claude-loop}/bin/claude-loop";
          };

          pre-commit.settings.hooks = {
            deps-graph = {
              enable = true;
              entry = "${pkgs.writeShellScript "deps-graph" ''
                ${pkgs.bun}/bin/bun run deps:graph >/dev/null 2>&1 && git add docs/DEPS.md src/*/DEPS.md 2>/dev/null
                true
              ''}";
              pass_filenames = false;
            };
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              jq
              nodejs-slim
              opencode
              podman
              python311
              podman-compose
            ];
            shellHook = config.pre-commit.installationScript;
          };
        };
    };
}
