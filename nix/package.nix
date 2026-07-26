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
    pnpm prune --prod --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/vicissitude
    cp -r dist node_modules package.json migrations $out/lib/vicissitude/
    mkdir -p $out/lib/vicissitude/config
    cp config/model-routes.example.json $out/lib/vicissitude/config/model-routes.json
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-gateway \
      --add-flags $out/lib/vicissitude/dist/apps/discord-gateway.js \
      --set-default VICISSITUDE_MIGRATIONS_DIR $out/lib/vicissitude/migrations \
      --set-default VICISSITUDE_MODEL_ROUTES_PATH $out/lib/vicissitude/config/model-routes.json
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-worker \
      --add-flags $out/lib/vicissitude/dist/apps/cognition-worker.js \
      --set-default VICISSITUDE_MIGRATIONS_DIR $out/lib/vicissitude/migrations \
      --set-default VICISSITUDE_MODEL_ROUTES_PATH $out/lib/vicissitude/config/model-routes.json
    makeWrapper ${nodejs_24}/bin/node $out/bin/vicissitude-admin \
      --add-flags $out/lib/vicissitude/dist/apps/admin-cli.js \
      --set-default VICISSITUDE_MIGRATIONS_DIR $out/lib/vicissitude/migrations \
      --set-default VICISSITUDE_MODEL_ROUTES_PATH $out/lib/vicissitude/config/model-routes.json
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test -x $out/bin/vicissitude-gateway
    test -x $out/bin/vicissitude-worker
    test -x $out/bin/vicissitude-admin
    test -f $out/lib/vicissitude/config/model-routes.json
    test -d $out/lib/vicissitude/migrations
    for wrapper in gateway worker admin; do
      grep -F -- $out/lib/vicissitude/migrations $out/bin/vicissitude-$wrapper
      grep -F -- $out/lib/vicissitude/config/model-routes.json $out/bin/vicissitude-$wrapper
      grep -F -- 'VICISSITUDE_MIGRATIONS_DIR-' $out/bin/vicissitude-$wrapper
      grep -F -- 'VICISSITUDE_MODEL_ROUTES_PATH-' $out/bin/vicissitude-$wrapper
    done
    test ! -e $out/lib/vicissitude/node_modules/typescript
    test ! -e $out/lib/vicissitude/node_modules/vitest
    cd $TMPDIR
    node --input-type=module -e "await import('$out/lib/vicissitude/dist/apps/discord-gateway.js'); await import('$out/lib/vicissitude/dist/apps/cognition-worker.js'); await import('$out/lib/vicissitude/dist/apps/admin-cli.js')"
    runHook postInstallCheck
  '';

  meta = {
    description = "Vicissitude AI character platform";
    license = lib.licenses.mit;
    mainProgram = "vicissitude-gateway";
  };

})
