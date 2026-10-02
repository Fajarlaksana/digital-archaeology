-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "addresses_archived_at_idx" ON "addresses"("archived_at");

