{ pkgs, package }:
pkgs.runCommand "staging-db-rehearsal"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.gnused
      pkgs.jq
      pkgs.postgresql_17
    ];
    script = ./db-rehearsal.sh;
    sql_dir = pkgs.linkFarm "staging-sql" [
      {
        name = "runtime-acl.sql";
        path = ./sql/runtime-acl.sql;
      }
      {
        name = "fixture.sql";
        path = ./sql/fixture.sql;
      }
      {
        name = "privilege-matrix.sql";
        path = ./sql/privilege-matrix.sql;
      }
      {
        name = "catalog-assertions.sql";
        path = ./sql/catalog-assertions.sql;
      }
    ];
    inherit package;
  }
  ''
    sql_dir="$sql_dir" package="$package" ${pkgs.bash}/bin/bash "$script"
  ''
