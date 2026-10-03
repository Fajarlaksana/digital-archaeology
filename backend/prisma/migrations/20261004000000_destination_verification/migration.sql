-- AlterTable
ALTER TABLE "destinations" ADD COLUMN     "control_verified_at" TIMESTAMP(3),
ADD COLUMN     "control_verified_by" UUID,
ADD COLUMN     "status_reason" TEXT;

-- CreateTable
CREATE TABLE "destination_challenges" (
    "id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "method" "ChallengeMethod",
    "issued_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "signature" TEXT,
    "result" "ChallengeResult" NOT NULL DEFAULT 'PENDING',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "destination_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "destination_challenges_nonce_key" ON "destination_challenges"("nonce");

-- CreateIndex
CREATE INDEX "destination_challenges_destination_id_idx" ON "destination_challenges"("destination_id");

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_control_verified_by_fkey" FOREIGN KEY ("control_verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_challenges" ADD CONSTRAINT "destination_challenges_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destination_challenges" ADD CONSTRAINT "destination_challenges_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────
-- Hand-written guards (ADR-010 / ADR-020). Do not remove when generating new migrations.
-- ─────────────────────────────────────────────────────────────

-- A destination can only be APPROVED after its owner proved control with a signature.
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_approved_requires_proof"
  CHECK ("status" <> 'APPROVED' OR ("control_verified_at" IS NOT NULL AND "control_verified_by" IS NOT NULL));

-- Rejections and disabling always carry a reason.
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_reason_when_closed"
  CHECK ("status" NOT IN ('REJECTED', 'DISABLED') OR btrim(coalesce("status_reason", '')) <> '');

ALTER TABLE "destinations" ADD CONSTRAINT "destinations_label_not_blank"
  CHECK (btrim("label") <> '');

-- The address and network of a destination never change: approvals refer to exactly them.
CREATE FUNCTION destinations_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."address" IS DISTINCT FROM OLD."address" OR NEW."network_id" IS DISTINCT FROM OLD."network_id" THEN
    RAISE EXCEPTION 'destinations.address and network_id are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER destinations_identity_immutable
  BEFORE UPDATE ON "destinations"
  FOR EACH ROW EXECUTE FUNCTION destinations_identity_immutable();
