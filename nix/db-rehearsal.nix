{ pkgs, package }:
pkgs.runCommand "staging-db-rehearsal" {
  nativeBuildInputs = [ pkgs.postgresql_17 pkgs.jq pkgs.coreutils pkgs.gnused pkgs.bash package ];
  script = ./db-rehearsal.sh;
  sql_dir = pkgs.linkFarm "staging-sql" [
    { name = "runtime-acl.sql"; path = ./sql/runtime-acl.sql; }
    { name = "fixture.sql"; path = ./sql/fixture.sql; }
    { name = "privilege-matrix.sql"; path = ./sql/privilege-matrix.sql; }
    { name = "catalog-assertions.sql"; path = ./sql/catalog-assertions.sql; }
  ];
  inherit package;
} ''
  install -Dm755 "$script" "$out/bin/run"
  sed -i '1c#!${pkgs.bash}/bin/bash' "$out/bin/run"
  sql_dir="$sql_dir" out="$out" package="$package" "$out/bin/run"
''
