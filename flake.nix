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
          ...
        }:
        {
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              pnpm
              postgresql_17
            ];
          };
          formatter = pkgs.nixfmt-rfc-style;
           packages.default = pkgs.callPackage ./nix/package.nix { };
           checks = pkgs.lib.optionalAttrs (pkgs.system == "x86_64-linux") {
             staging-db-rehearsal = pkgs.callPackage ./nix/db-rehearsal.nix {
               package = config.packages.default;
             };
           };
           apps = {
            vicissitude-gateway = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-gateway";
            };
            vicissitude-worker = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-worker";
            };
            vicissitude-admin = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-admin";
            };
          };
        };
    };
}
