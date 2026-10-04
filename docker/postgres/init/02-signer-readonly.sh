#!/bin/sh
# Read-only login for the signer (ADR-023): it verifies approvals in the application DB itself.
# Table/column privileges are granted by the backend migration `signer_readonly_access`.
# Runs only once, when the postgres volume is first initialised. For an existing volume run:
#   docker compose exec postgres psql -U postgres -c "CREATE ROLE da_signer_ro LOGIN PASSWORD '...'"
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE ROLE ${SIGNER_RO_DB_USER} LOGIN PASSWORD '${SIGNER_RO_DB_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
EOSQL
