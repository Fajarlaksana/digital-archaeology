#!/usr/bin/env bash
# Encrypted backup of both databases (Phase 14, ADR-028).
#   - pg_dump (custom format) of digital_archaeology and da_vault + roles (globals)
#   - streamed straight into age: no plaintext dump ever touches the disk
#   - SHA256SUMS + MANIFEST, written to <BACKUP_DIR>/<UTC timestamp>/ (atomic rename when complete)
#   - local rotation after RETENTION_DAYS; optional offsite copy with rclone (verified)
# The vault dump holds only ciphertext (envelope encryption, ADR-008) but is encrypted again here:
# a backup is useless without the age identity, which is kept offline, not on this server.
set -euo pipefail
umask 077

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
export PGHOST PGUSER PGPASSWORD PGPORT="${PGPORT:-5432}"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RECIPIENTS="${AGE_RECIPIENTS_FILE:-/config/age-recipients.txt}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/config/rclone/rclone.conf}"
APP_DB_NAME="${APP_DB_NAME:-digital_archaeology}"
VAULT_DB_NAME="${VAULT_DB_NAME:-da_vault}"

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && ((RETENTION_DAYS >= 1)) || fail "RETENTION_DAYS must be a positive integer"
[[ -r "$RECIPIENTS" ]] || fail "age recipients file not readable: $RECIPIENTS"
grep -qE '^age1[0-9a-z]{58}$' "$RECIPIENTS" || fail "no age public key (age1...) in $RECIPIENTS"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/$stamp"
work="$BACKUP_DIR/.partial-$stamp"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"

encrypt() { age --encrypt --recipients-file "$RECIPIENTS" --output "$1"; }

# Read BEFORE dumping: the dump's snapshot is newer, so a good restore must contain this exact row.
audit_head="$(psql -Atq -d "$APP_DB_NAME" \
  -c "SELECT \"sequence\" || ' ' || \"hash\" FROM audit_logs ORDER BY \"sequence\" DESC LIMIT 1")"

log "dumping roles"
pg_dumpall --globals-only | encrypt "$work/globals.sql.age"

log "dumping $APP_DB_NAME"
pg_dump --format=custom --compress=6 --dbname="$APP_DB_NAME" | encrypt "$work/app.dump.age"
log "dumping $VAULT_DB_NAME"
pg_dump --format=custom --compress=6 --dbname="$VAULT_DB_NAME" | encrypt "$work/vault.dump.age"

server_version="$(psql -Atqc 'SHOW server_version' -d postgres)"
{
  echo "created_at=$stamp"
  echo "postgres_server_version=$server_version"
  echo "pg_dump_version=$(pg_dump --version | awk '{print $NF}')"
  echo "app_db=$APP_DB_NAME"
  echo "vault_db=$VAULT_DB_NAME"
  # restore-check.sh requires this row; also compare it with the anchored audit head (runbook §14).
  echo "audit_head=${audit_head:-none}"
} >"$work/MANIFEST"

(cd "$work" && sha256sum -- *.age MANIFEST >SHA256SUMS)
mv "$work" "$final"
trap - EXIT
log "written $final ($(du -sh "$final" | awk '{print $1}'))"

# Local rotation: only complete backups older than RETENTION_DAYS; the newest is never removed.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+$RETENTION_DAYS" ! -path "$final" -print |
  while read -r old; do
    log "removing expired $(basename "$old")"
    rm -rf -- "$old"
  done
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.partial-*' -mmin +360 -exec rm -rf -- {} +

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  [[ -r "$RCLONE_CONFIG" ]] || fail "RCLONE_REMOTE is set but $RCLONE_CONFIG is not readable"
  log "copying offsite"
  # Offsite retention is the bucket's job (lifecycle / object lock): this server never deletes there.
  rclone --config "$RCLONE_CONFIG" copy "$final" "$RCLONE_REMOTE/$stamp" --immutable
  rclone --config "$RCLONE_CONFIG" check "$final" "$RCLONE_REMOTE/$stamp" --one-way
  log "offsite copy verified"
fi

log "OK $stamp"
