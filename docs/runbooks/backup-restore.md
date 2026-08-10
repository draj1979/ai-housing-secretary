# Runbook: Backup & Restore

Implements HLD Sec 15 ("Daily backup") and Sec 17 (backup interval NFR —
`config/constants.ts` `NFR_TARGETS.databaseBackupIntervalHours: 24`).

## How backups work (`scripts/backup.sh`)

```
pg_dump -Fc  →  gzip  →  openssl aes-256-cbc (BACKUP_ENCRYPTION_KEY)  →  gsutil cp  →  BACKUP_GCS_BUCKET
```

- **`-Fc`** — pg_dump's custom compressed format, not a plain `.sql` file.
  Restorable with `pg_restore`, and supports selective/parallel restore
  (see below) rather than replaying one giant SQL script.
- **Encrypted before it ever touches disk unencrypted.** The pipeline
  streams straight from `pg_dump` through `gzip` and `openssl` into a temp
  file — that temp file is always the encrypted form, and is deleted
  (`trap ... EXIT`) whether the script succeeds or fails.
- **`openssl enc -aes-256-cbc -pbkdf2`** — a symmetric passphrase
  (`BACKUP_ENCRYPTION_KEY`), not a asymmetric keypair — simplest correct
  choice for "one machine writes, one machine (or the same one) later
  reads," which is this app's actual restore scenario. `-pbkdf2` derives
  the actual AES key from the passphrase with a proper KDF rather than
  OpenSSL's legacy (weak) key derivation.
- **90-day retention**, pruning objects older than that from
  `BACKUP_GCS_BUCKET` after each successful upload — reuses
  `NFR_TARGETS.logRetentionDays` (`config/constants.ts`) as the same number
  rather than a second config knob, since this repo doesn't have a
  documented reason for the two windows to differ.

### Required environment

Same three vars scripts/backup.sh reads directly from the shell
environment (not through `config/env.ts`, since this is a bash script —
but declared there too, `BACKUP_ENCRYPTION_KEY`, so it's discoverable
alongside every other secret and can be sourced from GCP Secret Manager the
same way as the rest — see CLAUDE.md's "Secrets" section):

| Variable                | Example                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgresql://user:pass@host:5432/dbname`                                                          |
| `BACKUP_GCS_BUCKET`     | `gs://ai-housing-secretary-backups`                                                                |
| `BACKUP_ENCRYPTION_KEY` | a long random passphrase (not the same key as `FIELD_ENCRYPTION_KEY` — see "Key separation" below) |

### Scheduling

Run on `BACKUP_SCHEDULE_CRON` (`config/env.ts`, default `0 2 * * *` — 2am
daily). Two ways to wire that up on the Sec 13/14 GCP Compute Engine
deployment:

- **A system cron job** on the VM: `0 2 * * * /path/to/scripts/backup.sh >> /var/log/ai-housing-secretary-backup.log 2>&1`, with the three env vars above exported in the crontab or a sourced env file (not the app's `.env` — see "Key separation" below).
- **GCP Cloud Scheduler** triggering a Cloud Run Job (or an SSH-command
  Compute Engine trigger) — preferred if backups should survive the VM
  itself being rebuilt, since Cloud Scheduler's config lives outside it.

### Manual run

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_housing_secretary \
BACKUP_GCS_BUCKET=gs://ai-housing-secretary-backups \
BACKUP_ENCRYPTION_KEY="$(cat /path/to/backup-passphrase)" \
./scripts/backup.sh
```

## Restore steps

**1. Download and decrypt the backup:**

```bash
gsutil cp gs://ai-housing-secretary-backups/ai-housing-secretary-<TIMESTAMP>.dump.gz.enc ./backup.dump.gz.enc

openssl enc -d -aes-256-cbc -pbkdf2 -salt \
  -pass "pass:${BACKUP_ENCRYPTION_KEY}" \
  -in backup.dump.gz.enc \
  | gunzip -c > backup.dump
```

A wrong `BACKUP_ENCRYPTION_KEY` fails loudly here (`openssl`'s "bad
decrypt") rather than silently producing garbage — verified live (see
"Verified live" below).

**2. Restore into a target database.** Two scenarios:

- **Disaster recovery (replace everything)** — a fresh/empty database:
  ```bash
  createdb -h <host> -U <user> ai_housing_secretary_restored
  psql -h <host> -U <user> -d ai_housing_secretary_restored -c "CREATE EXTENSION IF NOT EXISTS vector;"
  pg_restore -h <host> -U <user> -d ai_housing_secretary_restored --no-owner --no-privileges backup.dump
  ```
  The `vector` extension (pgvector, for `knowledge_chunks` — see
  [`docs/db-schema.md`](../db-schema.md)) must exist in the target database
  _before_ restoring — `pg_restore` doesn't create extensions for you
  unless `CREATE EXTENSION` was captured in the dump and superuser
  privileges are available; explicitly creating it first sidesteps that
  entirely.
- **Selective restore (e.g. just recover the `escalations` table after an
  accidental delete)** — `-Fc`'s whole point:
  ```bash
  pg_restore -l backup.dump | grep escalations   # find the item's line number
  pg_restore -h <host> -U <user> -d ai_housing_secretary -L <(pg_restore -l backup.dump | grep escalations) backup.dump
  ```

**3. Point the app at the restored database** (if this was a full
disaster-recovery restore, not a selective one): update `DATABASE_URL`
(directly, or via GCP Secret Manager's `database-url` secret if
`SECRETS_SOURCE=gcp`) and restart the gateway/worker processes.

**4. Verify.** At minimum: `SELECT count(*) FROM residents;` and `SELECT
count(*) FROM knowledge_chunks;` against the restored database, and one
real inbound WhatsApp message end-to-end once the app is pointed at it.

## Key separation

`BACKUP_ENCRYPTION_KEY` (backup file encryption) and `FIELD_ENCRYPTION_KEY`
(resident PII column encryption — [`docs/security.md`](../security.md))
are **deliberately different secrets**, even though a `pg_dump` of
`residents` will contain the `FIELD_ENCRYPTION_KEY`-encrypted
`phone_e164`/`emergency_contact` ciphertext either way. Two independent
keys means a leak of one doesn't automatically compromise the other layer
— an attacker with only `BACKUP_ENCRYPTION_KEY` can decrypt the _dump
file_ but still can't read the resident PII columns inside it without
`FIELD_ENCRYPTION_KEY` too.

## Verified live (this session, not part of `pnpm test`)

Against a throwaway Postgres (Docker, seeded with the usual 5 residents,
field-level encrypted):

- **Full pipeline, byte-for-byte**: `pg_dump -Fc` → `gzip` → `openssl enc`
  → `openssl enc -d` → `gunzip` reproduced the exact original `pg_dump`
  output (`diff` reported no differences).
- **Wrong passphrase fails loudly**: decrypting with an incorrect
  `BACKUP_ENCRYPTION_KEY` exited non-zero with OpenSSL's "bad decrypt" —
  never silently produced corrupt/garbage output.
- **Restores into a real, separate database**: the decrypted dump was
  `pg_restore`d into a fresh `restore_test` database (after creating the
  `vector` extension there first) — `residents` came back with all 5 rows,
  and `phone_e164_hash` values matched the source database exactly
  (confirming the encrypted/hashed columns round-trip through backup/restore
  intact, not just plaintext columns).

The scratch container (and its `restore_test` database) were removed
afterward; `gsutil cp`/`rm` themselves were not exercised (no real GCS
bucket/credentials in this sandbox) — the parts that are security-critical
(encrypt/decrypt correctness, restore correctness) were verified directly
against the local encrypted file instead.
