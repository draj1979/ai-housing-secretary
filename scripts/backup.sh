#!/usr/bin/env bash
# scripts/backup.sh
#
# Daily encrypted PostgreSQL backup to Cloud Storage (HLD Sec 15, 17: Daily
# Backup, 90-day log retention). Intended to run on BACKUP_SCHEDULE_CRON
# (config/env.ts, default "0 2 * * *") via cron or a GCP Cloud Scheduler +
# Cloud Run job — see docs/runbooks/backup-restore.md for the restore side
# of this and the scheduling setup.
#
# Pipeline: pg_dump (custom format, -Fc) -> gzip -> openssl aes-256-cbc
# (BACKUP_ENCRYPTION_KEY) -> gsutil cp to BACKUP_GCS_BUCKET. The dump is
# never written to disk unencrypted — pg_dump streams into gzip streams
# into openssl streams into the uploaded file directly.
#
# Required environment (same names as config/env.ts, read directly here
# since this is a shell script, not a Node process — see that file's doc
# comment on why BACKUP_ENCRYPTION_KEY is declared there too):
#   DATABASE_URL          postgresql://user:pass@host:port/dbname
#   BACKUP_GCS_BUCKET      gs://bucket-name (no trailing slash)
#   BACKUP_ENCRYPTION_KEY  passphrase for openssl aes-256-cbc
#
# Usage:
#   ./scripts/backup.sh
#
# Exit codes: non-zero on any pipeline failure (set -o pipefail below) —
# a partial/corrupt upload must never look like a successful backup.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_GCS_BUCKET:?BACKUP_GCS_BUCKET is required (e.g. gs://ai-housing-secretary-backups)}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required}"

command -v pg_dump >/dev/null || { echo "pg_dump not found on PATH." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl not found on PATH." >&2; exit 1; }
command -v gsutil >/dev/null || { echo "gsutil not found on PATH (install the Cloud SDK)." >&2; exit 1; }

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="ai-housing-secretary-${TIMESTAMP}.dump.gz.enc"
DEST="${BACKUP_GCS_BUCKET%/}/${FILENAME}"

echo "Backing up ${DATABASE_URL%%@*}@... -> ${DEST}"

# -Fc: pg_dump's custom compressed format (restorable with pg_restore, not
# a plain SQL file) — smaller and supports selective/parallel restore.
# The whole pipeline streams to a local temp file first (gsutil needs a
# seekable source or a known content-length for a single-shot upload);
# the temp file is encrypted, never plaintext, and is always removed.
TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

pg_dump -Fc --no-owner --no-privileges "${DATABASE_URL}" \
  | gzip -c \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:${BACKUP_ENCRYPTION_KEY}" \
  > "${TMP_FILE}"

gsutil -q cp "${TMP_FILE}" "${DEST}"

echo "Backup complete: ${DEST}"

# Retention: keep 90 days (config/constants.ts NFR_TARGETS.logRetentionDays
# — reused here as the backup retention window too, one number for both
# rather than a second config knob). Best-effort: a failure to prune old
# backups doesn't fail this run — a successful backup that skipped cleanup
# is still a successful backup.
CUTOFF_DATE="$(date -u -d '90 days ago' +%Y%m%d 2>/dev/null || date -u -v-90d +%Y%m%d)"
gsutil ls "${BACKUP_GCS_BUCKET%/}/ai-housing-secretary-*.dump.gz.enc" 2>/dev/null | while read -r OBJECT; do
  OBJECT_DATE="$(basename "${OBJECT}" | sed -n 's/^ai-housing-secretary-\([0-9]\{8\}\)T.*/\1/p')"
  if [[ -n "${OBJECT_DATE}" && "${OBJECT_DATE}" < "${CUTOFF_DATE}" ]]; then
    echo "Pruning backup older than 90 days: ${OBJECT}"
    gsutil -q rm "${OBJECT}" || echo "Warning: failed to prune ${OBJECT}" >&2
  fi
done || true
