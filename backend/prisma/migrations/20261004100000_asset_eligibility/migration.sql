-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "eligibility_checked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "asset_eligibility" (
    "id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "status" "RecoveryStatus" NOT NULL,
    "reason" TEXT,
    "quantity" DECIMAL(78,0) NOT NULL,
    "fee_estimate" DECIMAL(78,0),
    "value_fiat" DECIMAL(38,8),
    "fee_fiat" DECIMAL(38,8),
    "net_fiat" DECIMAL(38,8),
    "simulated" BOOLEAN NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_eligibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_eligibility_status_idx" ON "asset_eligibility"("status");

-- CreateIndex
CREATE UNIQUE INDEX "asset_eligibility_address_id_asset_id_key" ON "asset_eligibility"("address_id", "asset_id");

-- AddForeignKey
ALTER TABLE "asset_eligibility" ADD CONSTRAINT "asset_eligibility_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_eligibility" ADD CONSTRAINT "asset_eligibility_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Hand-written guards (ADR-010 / ADR-021). Do not remove when generating new migrations.
-- ─────────────────────────────────────────────────────────────

-- An evaluation result is one of the three eligibility outcomes, never a workflow state.
ALTER TABLE "asset_eligibility" ADD CONSTRAINT "asset_eligibility_status_outcome"
  CHECK ("status" IN ('READY', 'NOT_ELIGIBLE', 'NOT_ECONOMIC'));

-- READY carries no reason; the other outcomes always explain themselves.
ALTER TABLE "asset_eligibility" ADD CONSTRAINT "asset_eligibility_reason_matches_status"
  CHECK (("status" = 'READY') = ("reason" IS NULL));

ALTER TABLE "asset_eligibility" ADD CONSTRAINT "asset_eligibility_amounts_non_negative"
  CHECK ("quantity" >= 0 AND ("fee_estimate" IS NULL OR "fee_estimate" >= 0)
         AND ("value_fiat" IS NULL OR "value_fiat" >= 0) AND ("fee_fiat" IS NULL OR "fee_fiat" >= 0));
