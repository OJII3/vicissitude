{
  description = "Vicissitude AI character platform";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      perSystem =
        {
          config,
          pkgs,
          system,
          ...
        }:
        {
          devShells =
            let
              base = with pkgs; [
                nodejs_24
                pnpm_11
                postgresql_17
              ];
            in
            {
              ci = pkgs.mkShell { packages = base; };
              default = pkgs.mkShell { packages = base ++ [ pkgs.pi-coding-agent ]; };
            };
          formatter = pkgs.nixfmt;
          packages.default = pkgs.callPackage ./nix/package.nix { };
          checks = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            staging-db-rehearsal = pkgs.callPackage ./nix/db-rehearsal.nix {
              package = config.packages.default;
            };
          };
          apps = {
            vicissitude-gateway = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-gateway";
              meta.description = "Run the Vicissitude Discord gateway";
            };
            vicissitude-worker = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-worker";
              meta.description = "Run the Vicissitude cognition worker";
            };
            vicissitude-admin = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-admin";
              meta.description = "Run the Vicissitude administration CLI";
            };
          };
        };
    };
}
