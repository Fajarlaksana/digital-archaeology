-- AlterTable
ALTER TABLE "authorizations" ADD COLUMN     "document_name" TEXT;


-- Hand-written: a document fingerprint is a lower-case SHA-256 hex digest.
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_document_sha256_format"
  CHECK ("document_sha256" IS NULL OR "document_sha256" ~ '^[0-9a-f]{64}$');
-- At most one challenge result per nonce is already guaranteed by the unique nonce.
