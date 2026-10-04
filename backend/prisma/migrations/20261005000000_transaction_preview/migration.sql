-- AlterEnum
ALTER TYPE "TransactionStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "gas_limit" DECIMAL(78,0),
ADD COLUMN     "max_fee_per_gas" DECIMAL(78,0),
ADD COLUMN     "max_priority_fee_per_gas" DECIMAL(78,0),
ADD COLUMN     "recipient" TEXT,
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "sweep" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "value_simulated" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────
-- Hand-written guards (ADR-010 / ADR-022). Do not remove when generating new migrations.
-- ─────────────────────────────────────────────────────────────

-- At most one transaction in flight per address: two would race for the same nonce.
CREATE UNIQUE INDEX "transactions_one_active_per_address" ON "transactions" ("address_id")
  WHERE "status" IN ('CREATED', 'APPROVED', 'SIGNED', 'BROADCASTED', 'PENDING');

-- Every transaction is born from a preview: payload + signing hash always present.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_unsigned_present"
  CHECK ("unsigned_payload" IS NOT NULL AND "unsigned_hash" ~ '^0x[0-9a-f]{64}$');

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0);

-- The approved maximum fee is exactly gas limit × max fee per gas.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fee_consistent"
  CHECK ("gas_limit" IS NULL OR "max_fee_per_gas" IS NULL OR "network_fee" = "gas_limit" * "max_fee_per_gas");

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reason_when_closed"
  CHECK ("status" NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED') OR btrim(coalesce("status_reason", '')) <> '');

-- What was previewed is what gets approved and signed: the core of a transaction never changes,
-- and the status only moves forward. APPROVED requires an APPROVED decision by someone other
-- than the creator (maker-checker at the database level, ADR-007).
CREATE FUNCTION transactions_guard() RETURNS trigger AS $$
DECLARE
  allowed text[];
BEGIN
  IF ROW(NEW."address_id", NEW."network_id", NEW."asset_id", NEW."destination_id", NEW."amount",
         NEW."network_fee", NEW."nonce", NEW."unsigned_payload", NEW."unsigned_hash", NEW."gas_limit",
         NEW."max_fee_per_gas", NEW."max_priority_fee_per_gas", NEW."recipient", NEW."sweep", NEW."created_by")
     IS DISTINCT FROM
     ROW(OLD."address_id", OLD."network_id", OLD."asset_id", OLD."destination_id", OLD."amount",
         OLD."network_fee", OLD."nonce", OLD."unsigned_payload", OLD."unsigned_hash", OLD."gas_limit",
         OLD."max_fee_per_gas", OLD."max_priority_fee_per_gas", OLD."recipient", OLD."sweep", OLD."created_by") THEN
    RAISE EXCEPTION 'transactions: previewed fields are immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    allowed := CASE OLD."status"::text
      WHEN 'CREATED'     THEN ARRAY['APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']
      WHEN 'APPROVED'    THEN ARRAY['SIGNED', 'CANCELLED', 'EXPIRED']
      WHEN 'SIGNED'      THEN ARRAY['BROADCASTED', 'FAILED', 'CANCELLED', 'EXPIRED']
      WHEN 'BROADCASTED' THEN ARRAY['PENDING', 'CONFIRMED', 'FAILED']
      WHEN 'PENDING'     THEN ARRAY['CONFIRMED', 'FAILED']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW."status"::text = ANY (allowed)) THEN
      RAISE EXCEPTION 'transactions: status % -> % is not allowed', OLD."status", NEW."status";
    END IF;
    IF NEW."status"::text = 'APPROVED' AND NOT EXISTS (
      SELECT 1 FROM "approvals" a
      WHERE a."transaction_id" = NEW."id" AND a."decision" = 'APPROVED'
        AND a."decided_by" IS NOT NULL AND a."decided_by" <> NEW."created_by"
    ) THEN
      RAISE EXCEPTION 'transactions: APPROVED needs an approval by someone other than the creator';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_guard
  BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_guard();
