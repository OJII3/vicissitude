{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_11,
  nodejs_24,
  makeWrapper,
}:

let
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.gitTracked ../.;
  };
in

stdenv.mkDerivation (finalAttrs: {
  pname = "vicissitude";
  version = "0.0.0";

  inherit src;

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-ROaLBdp08Bl4p6hns6u6l5t4wJROECCLxBFvkZcs9us=";
  };

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/vicissitude
    cp -r dist node_modules package.json config migrations $out/lib/vicissitude/
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-gateway \
      --add-flags $out/lib/vicissitude/dist/apps/discord-gateway.js
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-worker \
      --add-flags $out/lib/vicissitude/dist/apps/cognition-worker.js
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-admin \
      --add-flags $out/lib/vicissitude/dist/apps/admin-cli.js
    runHook postInstall
  '';

  meta = {
    description = "Vicissitude AI character platform";
    license = lib.licenses.mit;
    mainProgram = "vicissitude-gateway";
  };
})
