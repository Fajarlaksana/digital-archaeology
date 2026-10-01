-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ChainType" AS ENUM ('EVM', 'BITCOIN');

-- CreateEnum
CREATE TYPE "NetworkStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ActivityStatus" AS ENUM ('UNKNOWN', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "BalanceStatus" AS ENUM ('UNKNOWN', 'EMPTY', 'HAS_BALANCE');

-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('NONE', 'NOT_ELIGIBLE', 'NOT_ECONOMIC', 'READY', 'IN_PROGRESS', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'AUDITOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "AuthorizationType" AS ENUM ('SELF', 'MANDATE', 'CONTRACT');

-- CreateEnum
CREATE TYPE "ChallengeMethod" AS ENUM ('VAULT', 'WALLET', 'MANUAL');

-- CreateEnum
CREATE TYPE "ChallengeResult" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DestinationStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ApprovalSubject" AS ENUM ('DESTINATION', 'TRANSACTION');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'APPROVED', 'REJECTED', 'SIGNED', 'BROADCASTED', 'PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateTable
CREATE TABLE "networks" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "chain_type" "ChainType" NOT NULL DEFAULT 'EVM',
    "chain_id" INTEGER,
    "is_testnet" BOOLEAN NOT NULL,
    "rpc_url_env" TEXT,
    "explorer_url" TEXT,
    "status" "NetworkStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "contract_address" TEXT,
    "is_native" BOOLEAN NOT NULL DEFAULT false,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "fiat_currency" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "source" TEXT NOT NULL,
    "priced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "owner_reference" TEXT NOT NULL,
    "activity_status" "ActivityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "balance_status" "BalanceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "authorization_status" "AuthorizationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "recovery_status" "RecoveryStatus" NOT NULL DEFAULT 'NONE',
    "recovery_reason" TEXT,
    "review_flag" BOOLEAN NOT NULL DEFAULT false,
    "review_note" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "last_incoming_at" TIMESTAMP(3),
    "last_outgoing_at" TIMESTAMP(3),
    "inactive_days" INTEGER,
    "last_scanned_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "quantity" DECIMAL(78,0) NOT NULL,
    "fiat_value" DECIMAL(38,8),
    "price_snapshot_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "threshold_days" INTEGER NOT NULL,
    "minimum_balance" DECIMAL(78,0),
    "maximum_balance" DECIMAL(78,0),
    "total_addresses" INTEGER NOT NULL DEFAULT 0,
    "total_inactive" INTEGER NOT NULL DEFAULT 0,
    "total_failed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_by" UUID,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_results" (
    "id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "activity_status" "ActivityStatus" NOT NULL,
    "balance_status" "BalanceStatus" NOT NULL,
    "last_activity_at" TIMESTAMP(3),
    "last_incoming_at" TIMESTAMP(3),
    "last_outgoing_at" TIMESTAMP(3),
    "inactive_days" INTEGER,
    "incoming_tx_count" INTEGER,
    "outgoing_tx_count" INTEGER,
    "nonce" INTEGER,
    "review_flag" BOOLEAN NOT NULL DEFAULT false,
    "balances" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "mfa_secret_encrypted" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "authorizations" (
    "id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "type" "AuthorizationType" NOT NULL,
    "reference" TEXT NOT NULL,
    "document_sha256" TEXT,
    "document_path" TEXT,
    "verification_status" "AuthorizationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownership_challenges" (
    "id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "authorization_id" UUID,
    "nonce" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "method" "ChallengeMethod",
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "signature" TEXT,
    "result" "ChallengeResult" NOT NULL DEFAULT 'PENDING',
    "created_by" UUID,

    CONSTRAINT "ownership_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destinations" (
    "id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "DestinationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "subject_type" "ApprovalSubject" NOT NULL,
    "destination_id" UUID,
    "transaction_id" UUID,
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision" "ApprovalDecision",
    "reason" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "amount" DECIMAL(78,0) NOT NULL,
    "network_fee" DECIMAL(78,0),
    "estimated_value" DECIMAL(38,8),
    "nonce" INTEGER,
    "unsigned_payload" JSONB,
    "unsigned_hash" TEXT,
    "signed_payload" TEXT,
    "tx_hash" TEXT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "broadcast_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "result" "AuditResult" NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,
    "prev_hash" TEXT,
    "hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "networks_name_key" ON "networks"("name");

-- CreateIndex
CREATE UNIQUE INDEX "networks_chain_type_chain_id_key" ON "networks"("chain_type", "chain_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_network_id_contract_address_key" ON "assets"("network_id", "contract_address");

-- CreateIndex
CREATE INDEX "price_snapshots_asset_id_fiat_currency_priced_at_idx" ON "price_snapshots"("asset_id", "fiat_currency", "priced_at");

-- CreateIndex
CREATE INDEX "addresses_activity_status_idx" ON "addresses"("activity_status");

-- CreateIndex
CREATE INDEX "addresses_recovery_status_idx" ON "addresses"("recovery_status");

-- CreateIndex
CREATE UNIQUE INDEX "addresses_network_id_address_key" ON "addresses"("network_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "balances_address_id_asset_id_key" ON "balances"("address_id", "asset_id");

-- CreateIndex
CREATE INDEX "scans_status_idx" ON "scans"("status");

-- CreateIndex
CREATE UNIQUE INDEX "scan_results_scan_id_address_id_key" ON "scan_results"("scan_id", "address_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ownership_challenges_nonce_key" ON "ownership_challenges"("nonce");

-- CreateIndex
CREATE INDEX "ownership_challenges_address_id_idx" ON "ownership_challenges"("address_id");

-- CreateIndex
CREATE UNIQUE INDEX "destinations_network_id_address_key" ON "destinations"("network_id", "address");

-- CreateIndex
CREATE INDEX "approvals_destination_id_idx" ON "approvals"("destination_id");

-- CreateIndex
CREATE INDEX "approvals_transaction_id_idx" ON "approvals"("transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_tx_hash_key" ON "transactions"("tx_hash");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_sequence_key" ON "audit_logs"("sequence");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_price_snapshot_id_fkey" FOREIGN KEY ("price_snapshot_id") REFERENCES "price_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_results" ADD CONSTRAINT "scan_results_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_results" ADD CONSTRAINT "scan_results_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_challenges" ADD CONSTRAINT "ownership_challenges_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_challenges" ADD CONSTRAINT "ownership_challenges_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_challenges" ADD CONSTRAINT "ownership_challenges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Audit log is append-only (ADR / CLAUDE.md): block UPDATE, DELETE and TRUNCATE
-- at the database level, so even a bug or a compromised app user cannot rewrite history.
-- (Hand-written; not generated by Prisma.)
-- ─────────────────────────────────────────────────────────────
CREATE FUNCTION "audit_logs_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_block_mutation"();

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_block_mutation"();

-- ─────────────────────────────────────────────────────────────
-- Integrity guards the Prisma schema language cannot express. (Hand-written.)
-- ─────────────────────────────────────────────────────────────

-- CLAUDE.md rule 7: every address must name its owner / mandate.
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_owner_reference_not_blank"
  CHECK (btrim("owner_reference") <> '');

-- Base-unit amounts are never negative.
ALTER TABLE "balances" ADD CONSTRAINT "balances_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_network_fee_non_negative"
  CHECK ("network_fee" IS NULL OR "network_fee" >= 0);
ALTER TABLE "scans" ADD CONSTRAINT "scans_balance_bounds_valid"
  CHECK ("minimum_balance" IS NULL OR "maximum_balance" IS NULL OR "minimum_balance" <= "maximum_balance");

-- Token decimals within what the money helpers support.
ALTER TABLE "assets" ADD CONSTRAINT "assets_decimals_range" CHECK ("decimals" BETWEEN 0 AND 36);

-- Exactly one native asset per network (Prisma cannot express partial unique indexes).
CREATE UNIQUE INDEX "assets_one_native_per_network" ON "assets" ("network_id") WHERE "is_native";

-- Native assets have no contract address; tokens must have one.
ALTER TABLE "assets" ADD CONSTRAINT "assets_native_xor_contract"
  CHECK (("is_native" AND "contract_address" IS NULL) OR (NOT "is_native" AND "contract_address" IS NOT NULL));

-- An approval targets exactly one subject, matching its subject_type.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_single_subject" CHECK (
  ("subject_type" = 'DESTINATION' AND "destination_id" IS NOT NULL AND "transaction_id" IS NULL) OR
  ("subject_type" = 'TRANSACTION' AND "transaction_id" IS NOT NULL AND "destination_id" IS NULL)
);

-- Maker-checker (ADR-007): the decider can never be the requester.
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decider_not_requester"
  CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by");
