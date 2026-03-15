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
        {
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
            ];
            shellHook = config.pre-commit.installationScript;
          };
        };
    };
}
