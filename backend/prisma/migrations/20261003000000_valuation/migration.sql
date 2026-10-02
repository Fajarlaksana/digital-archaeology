-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "price_id" TEXT;

-- AlterTable
ALTER TABLE "scans" ADD COLUMN     "trigger" "ScanTrigger" NOT NULL DEFAULT 'MANUAL';

