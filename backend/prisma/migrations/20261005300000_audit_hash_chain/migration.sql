-- Hand-written (ADR-010 / ADR-025). Do not remove when generating new migrations.
-- Tamper-evident audit log: every row carries SHA-256(row content + previous row's hash).

-- One definition of a row's hash, used by the insert trigger AND by verification.
-- Fields are joined with the ASCII unit separator; jsonb has a canonical text form.
CREATE FUNCTION audit_log_row_hash(
  p_sequence bigint, p_id uuid, p_user_id uuid, p_action text, p_resource_type text,
  p_resource_id text, p_result text, p_ip text, p_user_agent text, p_request_id text,
  p_metadata jsonb, p_created_at timestamp, p_prev_hash text
) RETURNS text AS $$
  SELECT encode(sha256(convert_to(concat_ws(chr(31),
    p_sequence::text, p_id::text, coalesce(p_user_id::text, ''), p_action,
    coalesce(p_resource_type, ''), coalesce(p_resource_id, ''), p_result,
    coalesce(p_ip, ''), coalesce(p_user_agent, ''), coalesce(p_request_id, ''),
    coalesce(p_metadata::text, ''), to_char(p_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
    p_prev_hash), 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE;

-- Inserts are chained one at a time: the advisory lock (held until commit) orders writers, and
-- the sequence is taken UNDER the lock, so chain order = sequence order even with concurrency.
CREATE FUNCTION audit_logs_chain() RETURNS trigger AS $$
DECLARE
  previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_logs_chain'));
  NEW."sequence" := nextval(pg_get_serial_sequence('audit_logs', 'sequence'));
  SELECT "hash" INTO previous FROM "audit_logs" ORDER BY "sequence" DESC LIMIT 1;
  NEW."prev_hash" := coalesce(previous, repeat('0', 64));
  NEW."hash" := audit_log_row_hash(NEW."sequence", NEW."id", NEW."user_id", NEW."action",
    NEW."resource_type", NEW."resource_id", NEW."result"::text, NEW."ip_address", NEW."user_agent",
    NEW."request_id", NEW."metadata", NEW."created_at", NEW."prev_hash");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill rows written before the chain existed (the append-only trigger is paused only here).
ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_no_update_delete";
DO $$
DECLARE
  r record;
  previous text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM "audit_logs" ORDER BY "sequence" LOOP
    UPDATE "audit_logs"
       SET "prev_hash" = previous,
           "hash" = audit_log_row_hash(r."sequence", r."id", r."user_id", r."action",
             r."resource_type", r."resource_id", r."result"::text, r."ip_address", r."user_agent",
             r."request_id", r."metadata", r."created_at", previous)
     WHERE "id" = r."id"
    RETURNING "hash" INTO previous;
  END LOOP;
END
$$;
ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_no_update_delete";

CREATE TRIGGER audit_logs_chain
  BEFORE INSERT ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_hash_format"
  CHECK ("hash" ~ '^[0-9a-f]{64}$' AND "prev_hash" ~ '^[0-9a-f]{64}$');
