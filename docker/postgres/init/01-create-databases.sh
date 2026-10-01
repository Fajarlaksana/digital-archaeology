#!/bin/sh
# Creates the application DB and the isolated vault DB (ADR-008), each owned by its own user.
# Runs only once, when the postgres volume is first initialised.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  CREATE USER ${APP_DB_USER} WITH PASSWORD '${APP_DB_PASSWORD}';
  CREATE DATABASE ${APP_DB_NAME} OWNER ${APP_DB_USER};
  REVOKE CONNECT ON DATABASE ${APP_DB_NAME} FROM PUBLIC;

  CREATE USER ${VAULT_DB_USER} WITH PASSWORD '${VAULT_DB_PASSWORD}';
  CREATE DATABASE ${VAULT_DB_NAME} OWNER ${VAULT_DB_USER};
  REVOKE CONNECT ON DATABASE ${VAULT_DB_NAME} FROM PUBLIC;
EOSQL

# Prisma `migrate dev` needs to create a shadow database.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
  ALTER USER ${APP_DB_USER} CREATEDB;
  ALTER USER ${VAULT_DB_USER} CREATEDB;
EOSQL
