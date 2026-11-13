#!/bin/sh
# Se ejecuta solo la primera vez que se crea el volumen.
# Crea la base de tests (<POSTGRES_DB>_test) con el mismo usuario dueño.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE "${POSTGRES_DB}_test" OWNER "$POSTGRES_USER";
EOSQL
