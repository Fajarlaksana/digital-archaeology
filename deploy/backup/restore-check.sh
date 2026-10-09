#!/usr/bin/env bash
# Restore check (Phase 14, ADR-028): proves a backup can actually be restored.
#   restore-check.sh <backup directory name, e.g. 20261009T020000Z>
# Needs the OFFLINE age identity, mounted only for this run at $AGE_IDENTITY_FILE.
# Decrypts in a stream (no plaintext on disk), restores into fresh scratch databases, then checks:
#   checksums · migrations complete · audit hash chain intact and containing the MANIFEST head ·
#   vault_config present · roles present in the globals dump.
# The scratch databases are dropped afterwards; KEEP=1 keeps them for the vault recovery drill.
set -euo pipefail
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
export PGHOST PGUSER PGPASSWORD PGPORT="${PGPORT:-5432}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
IDENTITY="${AGE_IDENTITY_FILE:-/config/age-identity.txt}"
name="${1:?usage: restore-check.sh <backup name>}"
[[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "invalid backup name: $name" >&2; exit 2; }
dir="$BACKUP_DIR/$name"

log() { printf '%s restore-check: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

[[ -d "$dir" ]] || fail "backup not found: $dir"
[[ -r "$IDENTITY" ]] || fail "age identity not readable: $IDENTITY (mount it from offline storage)"

log "verifying checksums"
(cd "$dir" && sha256sum --check --quiet SHA256SUMS) || fail "checksum mismatch"

# Random suffix ($$ is always 1 in a container); cleanup drops only databases THIS run created.
suffix="$(echo "$name" | tr 'A-Z' 'a-z')_$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
app_db="restore_check_app_$suffix"
vault_db="restore_check_vault_$suffix"
created=()
cleanup() {
  ((${#created[@]})) || return 0
  if [[ "${KEEP:-0}" == "1" ]]; then
    log "KEEP=1: scratch databases kept: ${created[*]} (drop them after the drill)"
    return
  fi
  for db in "${created[@]}"; do
    psql -qd postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

decrypt() { age --decrypt --identity "$IDENTITY" "$1"; }
q() { psql -Atq -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }

log "checking roles in globals"
roles="$(decrypt "$dir/globals.sql.age" | grep -oE 'CREATE ROLE [a-z_]+' | awk '{print $3}' | sort -u | tr '\n' ' ')" ||
  fail "cannot decrypt the backup (wrong age identity?)"
for role in da da_vault da_signer_ro; do
  [[ " $roles " == *" $role "* ]] || fail "role $role missing from globals dump"
done

restore() { # <dump file> <scratch db>
  q postgres "CREATE DATABASE \"$2\"" >/dev/null || fail "cannot create scratch database $2"
  created+=("$2")
  decrypt "$1" | pg_restore --dbname="$2" --no-owner --no-privileges --exit-on-error ||
    fail "restore into $2 failed"
}
log "restoring $(sed -n 's/^app_db=//p' "$dir/MANIFEST") -> $app_db"
restore "$dir/app.dump.age" "$app_db"
log "restoring $(sed -n 's/^vault_db=//p' "$dir/MANIFEST") -> $vault_db"
restore "$dir/vault.dump.age" "$vault_db"

unfinished='SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL'
[[ "$(q "$app_db" "$unfinished")" == "0" ]] || fail "app DB has unfinished migrations"
[[ "$(q "$vault_db" "$unfinished")" == "0" ]] || fail "vault DB has unfinished migrations"

# Same verification as AuditLogRepository.verifyChain (ADR-025).
broken="$(q "$app_db" "
  WITH chain AS (
    SELECT \"sequence\", \"hash\", \"prev_hash\",
           audit_log_row_hash(\"sequence\", \"id\", \"user_id\", \"action\", \"resource_type\",
             \"resource_id\", \"result\"::text, \"ip_address\", \"user_agent\", \"request_id\",
             \"metadata\", \"created_at\", \"prev_hash\") AS expected,
           lag(\"hash\") OVER (ORDER BY \"sequence\") AS previous
      FROM audit_logs)
  SELECT count(*) FROM chain
   WHERE \"hash\" IS DISTINCT FROM expected
      OR \"prev_hash\" IS DISTINCT FROM coalesce(previous, repeat('0', 64))")"
[[ "$broken" == "0" ]] || fail "audit hash chain broken ($broken row(s))"

manifest_head="$(sed -n 's/^audit_head=//p' "$dir/MANIFEST")"
if [[ -n "$manifest_head" && "$manifest_head" != "none" ]]; then
  read -r head_seq head_hash <<<"$manifest_head"
  [[ "$head_seq" =~ ^[0-9]+$ && "$head_hash" =~ ^[0-9a-f]{64}$ ]] || fail "malformed audit_head in MANIFEST"
  found="$(q "$app_db" "SELECT count(*) FROM audit_logs WHERE \"sequence\" = $head_seq AND \"hash\" = '$head_hash'")"
  [[ "$found" == "1" ]] || fail "restored audit log does not contain the MANIFEST head ($head_seq)"
fi

[[ "$(q "$vault_db" 'SELECT count(*) FROM vault_config')" == "1" ]] || fail "vault_config missing in vault backup (vault not initialised yet?)"

log "users=$(q "$app_db" 'SELECT count(*) FROM users')" \
  "addresses=$(q "$app_db" 'SELECT count(*) FROM addresses')" \
  "transactions=$(q "$app_db" 'SELECT count(*) FROM transactions')" \
  "audit_logs=$(q "$app_db" 'SELECT count(*) FROM audit_logs')" \
  "vault_keys=$(q "$vault_db" 'SELECT count(*) FROM vault_keys')"
log "audit head: $(q "$app_db" "SELECT \"sequence\" || ' ' || \"hash\" FROM audit_logs ORDER BY \"sequence\" DESC LIMIT 1")"
log "OK $name"
