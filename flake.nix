{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # llm-agents.nix は upstream の nixpkgs-unstable で electron 等の評価が
    # 壊れるため、26.05 stable を別途ピン留めして使う。
    llm-agents-nixpkgs.url = "github:NixOS/nixpkgs/26.05";
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "llm-agents-nixpkgs";
    };
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
          opencode = inputs.llm-agents.packages.${system}.opencode;
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
          runtimePackages = baseRuntimePackages ++ lib.optionals stdenv.isLinux linuxRuntimePackages;
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
            packages = runtimePackages;
            shellHook = lib.optionalString stdenv.isLinux ''
              export LD_LIBRARY_PATH="${linuxLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export CXXFLAGS="-include cstdint''${CXXFLAGS:+ $CXXFLAGS}"
            '';
          };
        };
    };
}
