-- Hand-written (ADR-010 / ADR-023). Do not remove when generating new migrations.

-- ─────────────────────────────────────────────────────────────
-- 1. Read-only access for the signer: it verifies approvals itself before signing.
--    Column-level SELECT only — no sessions, password hashes, MFA secrets or audit data.
--    Skipped when the role does not exist (created by docker/postgres/init/02-signer-readonly.sh).
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'da_signer_ro') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO da_signer_ro', current_database());
    GRANT USAGE ON SCHEMA public TO da_signer_ro;
    GRANT SELECT ("id", "address_id", "network_id", "status", "nonce", "unsigned_payload",
                  "unsigned_hash", "created_by") ON "transactions" TO da_signer_ro;
    GRANT SELECT ("id", "transaction_id", "subject_type", "decision", "decided_by", "decided_at",
                  "expires_at", "created_at") ON "approvals" TO da_signer_ro;
    GRANT SELECT ("id", "address") ON "addresses" TO da_signer_ro;
    GRANT SELECT ("id", "chain_id") ON "networks" TO da_signer_ro;
    GRANT SELECT ("id", "status") ON "users" TO da_signer_ro;
    GRANT SELECT ("user_id", "role") ON "user_roles" TO da_signer_ro;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────
-- 2. A signed transaction always carries its raw form and hash, and they never change.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_signed_present"
  CHECK ("status" NOT IN ('SIGNED', 'BROADCASTED', 'PENDING', 'CONFIRMED')
         OR ("signed_payload" IS NOT NULL AND "tx_hash" ~ '^0x[0-9a-f]{64}$'));

CREATE FUNCTION transactions_signed_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."signed_payload" IS NOT NULL AND (
       NEW."signed_payload" IS DISTINCT FROM OLD."signed_payload"
       OR NEW."tx_hash" IS DISTINCT FROM OLD."tx_hash") THEN
    RAISE EXCEPTION 'transactions: the signed transaction is immutable';
  END IF;
  IF NEW."signed_payload" IS NOT NULL AND OLD."signed_payload" IS NULL
     AND NOT (OLD."status"::text = 'APPROVED' AND NEW."status"::text = 'SIGNED') THEN
    RAISE EXCEPTION 'transactions: a signature can only be stored when an APPROVED transaction becomes SIGNED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_signed_immutable
  BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_signed_immutable();
