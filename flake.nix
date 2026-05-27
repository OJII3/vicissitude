{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, system, ... }:
        let
          opencodeVersion = "1.15.5";
          opencodePlatform = {
            x86_64-linux = {
              packageName = "opencode-linux-x64";
              hash = "sha256-taZkHun5OsGO6VQ3ZAnnCDne+bsaRRpfPExtrerNy8Q=";
            };
            aarch64-linux = {
              packageName = "opencode-linux-arm64";
              hash = "sha256-O2hVGCK+aRHjL87VOKww6yMnzcFFJbMZoarA6vNq+V8=";
            };
            aarch64-darwin = {
              packageName = "opencode-darwin-arm64";
              hash = "sha256-B+1EjtGts6FC06aYCqKcQ5wmVnrxorA60Np15OZfqXM=";
            };
          }.${system};
          opencode = pkgs.stdenvNoCC.mkDerivation {
            pname = "opencode";
            version = opencodeVersion;
            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/${opencodePlatform.packageName}/-/${opencodePlatform.packageName}-${opencodeVersion}.tgz";
              hash = opencodePlatform.hash;
            };
            dontBuild = true;
            unpackPhase = "tar -xzf $src";
            installPhase = ''
              runHook preInstall
              mkdir -p $out/bin
              install -m 755 package/bin/opencode $out/bin/opencode
              runHook postInstall
            '';
          };
        in
        {
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              jq
              nodejs-slim
              opencode
              podman
              python311
              podman-compose
            ] ++ lib.optionals stdenv.isLinux [
              slirp4netns
            ];
          };
        };
    };
}
