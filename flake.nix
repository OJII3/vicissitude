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
          apps = {
            gateway = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-gateway";
            };
            worker = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-worker";
            };
            admin = {
              type = "app";
              program = "${config.packages.default}/bin/vicissitude-admin";
            };
          };
        };
    };
}
