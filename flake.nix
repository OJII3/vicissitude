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
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        { pkgs, system, ... }:
        let
          inherit (pkgs) lib stdenv;
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
            x86_64-darwin = {
              packageName = "opencode-darwin-x64";
              hash = "sha256-+KxzBty9aCKS72WzKouy5r3LvSrAWZCOHUvwBAWrv0Y=";
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
          baseRuntimePackages = with pkgs; [
            bun
            ni
            jq
            nodejs-slim
            opencode
            ollama
            git
            gh
            ripgrep
            fd
            sqlite
            python311
            pkg-config
          ];
          linuxRuntimePackages = with pkgs; [
            podman
            slirp4netns
            cairo
            pango
            libjpeg
            giflib
            librsvg
            libGL
            libxi
            xauth
            xorg-server
          ];
          runtimePackages =
            baseRuntimePackages
            ++ lib.optionals stdenv.isLinux linuxRuntimePackages;
          linuxLibraryPath = lib.makeLibraryPath [
            pkgs.stdenv.cc.cc.lib
            pkgs.cairo
            pkgs.pango
            pkgs.libjpeg
            pkgs.giflib
            pkgs.librsvg
            pkgs.libGL
            pkgs.libxi
          ];
          makeRepoShellApp =
            name: text:
            pkgs.writeShellApplication {
              inherit name;
              runtimeInputs = runtimePackages;
              text = ''
                if [ ! -f package.json ]; then
                  echo "[nix-app] package.json が見つかりません。repo root で実行してください。" >&2
                  exit 1
                fi

                ${lib.optionalString stdenv.isLinux ''
                  export LD_LIBRARY_PATH="${linuxLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
                  export CXXFLAGS="-include cstdint''${CXXFLAGS:+ $CXXFLAGS}"
                ''}

                ${text}
              '';
            };
          botApp = makeRepoShellApp "vicissitude-bot" ''
            exec nr bare:run "$@"
          '';
          bareStartApp = makeRepoShellApp "vicissitude-start" ''
            exec nr bare:start "$@"
          '';
          bareStopApp = makeRepoShellApp "vicissitude-stop" ''
            exec nr bare:stop "$@"
          '';
          bareStatusApp = makeRepoShellApp "vicissitude-status" ''
            exec nr bare:status "$@"
          '';
          bareRestartApp = makeRepoShellApp "vicissitude-restart" ''
            exec nr bare:restart "$@"
          '';
          webApp = makeRepoShellApp "vicissitude-web" ''
            exec nr start:web "$@"
          '';
          buildWebApp = makeRepoShellApp "vicissitude-build-web" ''
            bun install --frozen-lockfile
            exec nr build:web "$@"
          '';
          validateApp = makeRepoShellApp "vicissitude-validate" ''
            bun install --frozen-lockfile
            exec nr validate "$@"
          '';
        in
        {
          packages = {
            inherit
              opencode
              botApp
              bareStartApp
              bareStopApp
              bareStatusApp
              bareRestartApp
              webApp
              buildWebApp
              validateApp
              ;
          };

          apps = {
            vicissitude = {
              type = "app";
              program = "${botApp}/bin/vicissitude-bot";
              meta.description = "Run the Vicissitude Discord bot in foreground with single-instance protection";
            };
            vicissitude-start = {
              type = "app";
              program = "${bareStartApp}/bin/vicissitude-start";
              meta.description = "Start the Vicissitude bare instance in background";
            };
            vicissitude-stop = {
              type = "app";
              program = "${bareStopApp}/bin/vicissitude-stop";
              meta.description = "Stop the Vicissitude bare instance";
            };
            vicissitude-status = {
              type = "app";
              program = "${bareStatusApp}/bin/vicissitude-status";
              meta.description = "Show Vicissitude bare instance status";
            };
            vicissitude-restart = {
              type = "app";
              program = "${bareRestartApp}/bin/vicissitude-restart";
              meta.description = "Restart the Vicissitude bare instance";
            };
            vicissitude-web = {
              type = "app";
              program = "${webApp}/bin/vicissitude-web";
              meta.description = "Serve the Vicissitude web UI on bare metal";
            };
            vicissitude-build-web = {
              type = "app";
              program = "${buildWebApp}/bin/vicissitude-build-web";
              meta.description = "Build the Vicissitude web UI";
            };
            vicissitude-validate = {
              type = "app";
              program = "${validateApp}/bin/vicissitude-validate";
              meta.description = "Validate the Vicissitude workspace under the Nix runtime";
            };
          };

          devShells.default = pkgs.mkShell {
            packages = runtimePackages ++ lib.optionals stdenv.isLinux [ pkgs.podman-compose ];
            shellHook = lib.optionalString stdenv.isLinux ''
              export LD_LIBRARY_PATH="${linuxLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export CXXFLAGS="-include cstdint''${CXXFLAGS:+ $CXXFLAGS}"
            '';
          };
        };
    };
}
