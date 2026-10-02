-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VaultKeyType" AS ENUM ('PRIVATE_KEY', 'DERIVED_FROM_MNEMONIC');

-- CreateEnum
CREATE TYPE "VaultEventType" AS ENUM ('INIT', 'UNLOCK', 'UNLOCK_FAILED', 'LOCK', 'AUTO_LOCK', 'PASSPHRASE_CHANGED', 'RECOVERED', 'RECOVERY_FAILED', 'KEY_IMPORTED', 'KEY_REVEALED', 'REVEAL_FAILED', 'MESSAGE_SIGNED', 'TRANSACTION_SIGNED');

-- CreateTable
CREATE TABLE "vault_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "format_version" INTEGER NOT NULL DEFAULT 1,
    "kdf_algorithm" TEXT NOT NULL,
    "kdf_memory_cost" INTEGER NOT NULL,
    "kdf_time_cost" INTEGER NOT NULL,
    "kdf_parallelism" INTEGER NOT NULL,
    "main_salt" BYTEA NOT NULL,
    "main_wrapped_key" BYTEA NOT NULL,
    "recovery_salt" BYTEA NOT NULL,
    "recovery_wrapped_key" BYTEA NOT NULL,
    "initialized_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_keys" (
    "id" UUID NOT NULL,
    "chain_type" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "key_type" "VaultKeyType" NOT NULL,
    "derivation_path" TEXT,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "imported_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "vault_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_events" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "type" "VaultEventType" NOT NULL,
    "actor" TEXT,
    "address" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vault_keys_chain_type_address_key" ON "vault_keys"("chain_type", "address");

-- CreateIndex
CREATE UNIQUE INDEX "vault_events_sequence_key" ON "vault_events"("sequence");

-- CreateIndex
CREATE INDEX "vault_events_type_created_at_idx" ON "vault_events"("type", "created_at");


-- ─────────────────────────────────────────────────────────────
-- Hand-written guards (not expressible in Prisma).
-- ─────────────────────────────────────────────────────────────

-- Exactly one vault configuration row.
ALTER TABLE "vault_config" ADD CONSTRAINT "vault_config_singleton" CHECK ("id" = 1);

-- Sanity of stored crypto material (AES-GCM: 12-byte IV, 16-byte tag; 16-byte salts).
ALTER TABLE "vault_config" ADD CONSTRAINT "vault_config_salt_lengths"
  CHECK (length("main_salt") = 16 AND length("recovery_salt") = 16);
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_gcm_lengths"
  CHECK (length("iv") = 12 AND length("auth_tag") = 16 AND length("ciphertext") > 0);

-- Addresses are stored canonical lower-case (they are part of the AAD).
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_address_lowercase"
  CHECK ("address" = lower("address"));

-- vault_events is append-only, like audit_logs in the application database.
CREATE FUNCTION "vault_events_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'vault_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "vault_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "vault_events"
  FOR EACH ROW EXECUTE FUNCTION "vault_events_block_mutation"();

CREATE TRIGGER "vault_events_no_truncate"
  BEFORE TRUNCATE ON "vault_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "vault_events_block_mutation"();
