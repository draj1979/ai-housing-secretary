-- Field-level encryption at rest for resident PII (HLD Sec 15) —
-- security/fieldEncryption.ts, tools/residentsTool.ts.
--
-- SAFE ONLY FOR AN EMPTY `residents` TABLE (a fresh install, or this repo's
-- own scratch-Postgres dev/test workflow — see docs/security.md). If this
-- table already has rows when you run this: `phone_e164`/`emergency_contact`
-- are still plaintext at this point (nothing has encrypted them yet — that
-- only starts once application code goes through tools/residentsTool.ts on
-- writes), and the new `phone_e164_hash` column below is NOT NULL with no
-- default, so this migration will fail outright, loudly, rather than
-- silently leaving unhashed/unencrypted rows. A populated environment needs
-- a one-off backfill script (encrypt phone_e164/emergency_contact in place,
-- compute phone_e164_hash for every row) run *before* this migration —
-- not included here, since this repo has never had a real deployment with
-- real resident data (see CLAUDE.md's Status section).
DROP INDEX IF EXISTS "residents_phone_e164_idx";--> statement-breakpoint
ALTER TABLE "residents" ALTER COLUMN "phone_e164" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "residents" ALTER COLUMN "emergency_contact" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "phone_e164_hash" varchar(64) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "residents_phone_e164_hash_idx" ON "residents" USING btree ("phone_e164_hash");
