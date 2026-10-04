-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "block_number" BIGINT,
ADD COLUMN     "fee_paid" DECIMAL(78,0),
ADD COLUMN     "gas_used" DECIMAL(78,0),
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "stuck_since" TIMESTAMP(3);


-- ─────────────────────────────────────────────────────────────
-- Hand-written guards (ADR-010 / ADR-024). Do not remove when generating new migrations.
-- ─────────────────────────────────────────────────────────────

-- Once sent, a transaction always records when.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_broadcast_recorded"
  CHECK ("status" NOT IN ('BROADCASTED', 'PENDING', 'CONFIRMED') OR "broadcast_at" IS NOT NULL);

-- CONFIRMED means: in a block, with its confirmation time and actual cost.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_confirmed_recorded"
  CHECK ("status" <> 'CONFIRMED' OR ("confirmed_at" IS NOT NULL AND "block_number" IS NOT NULL AND "confirmations" > 0));

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_chain_numbers_non_negative"
  CHECK ("confirmations" >= 0 AND ("block_number" IS NULL OR "block_number" >= 0)
         AND ("gas_used" IS NULL OR "gas_used" >= 0) AND ("fee_paid" IS NULL OR "fee_paid" >= 0));
