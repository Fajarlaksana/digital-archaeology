-- Local development setup for a NATIVE PostgreSQL install (alternative to docker-compose).
-- Creates the app DB and the isolated vault DB (ADR-008), each with its own user.
-- Passwords match .env.example and are for LOCAL DEVELOPMENT ONLY.
--
-- Run once, as the postgres superuser (you will be asked for its password):
--   psql -U postgres -h 127.0.0.1 -p 5433 -f scripts/db/native-setup.sql
-- Safe to re-run: existing users/databases are left untouched.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'da') THEN
    CREATE USER da WITH PASSWORD 'da_dev_only' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'da_vault') THEN
    CREATE USER da_vault WITH PASSWORD 'vault_dev_only' CREATEDB;
  END IF;
END
$$;

SELECT 'CREATE DATABASE digital_archaeology OWNER da'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'digital_archaeology') \gexec

SELECT 'CREATE DATABASE da_vault OWNER da_vault'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'da_vault') \gexec

REVOKE CONNECT ON DATABASE digital_archaeology FROM PUBLIC;
REVOKE CONNECT ON DATABASE da_vault FROM PUBLIC;
GRANT CONNECT ON DATABASE digital_archaeology TO da;
GRANT CONNECT ON DATABASE da_vault TO da_vault;
