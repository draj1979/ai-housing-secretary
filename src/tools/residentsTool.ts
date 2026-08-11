/**
 * tools/residentsTool.ts
 *
 * Resident PII access (HLD Sec 15). The *only* code in this repo allowed
 * to read or write `residents.phone_e164` / `residents.emergency_contact`
 * directly — every other module/tool that needs a resident's phone number
 * or emergency contact goes through here, so there is exactly one place
 * that knows the field-level-encryption format (security/fieldEncryption.ts)
 * and the phone-number blind-index lookup (`phone_e164_hash`).
 *
 * Why a lookup can't just query the encrypted column: AES-GCM encryption
 * is non-deterministic (a fresh IV per call), so the same phone number
 * produces different ciphertext each time it's encrypted — correct for
 * "an attacker with DB access can't correlate rows," but it means
 * `WHERE phone_e164 = <ciphertext>` can never match. `findIdByPhone`
 * queries `phone_e164_hash` (a deterministic HMAC) instead; the encrypted
 * column itself is only ever decrypted after the row is already found.
 */
import { eq } from 'drizzle-orm';
import { residents } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';
import type { FieldEncryption } from '../security/fieldEncryption.js';

type ResidentRow = typeof residents.$inferSelect;

export interface ResidentContact {
  id: string;
  name: string;
  flatNumber: string;
  phoneE164: string;
  emergencyContact: string | null;
}

export interface UpsertResidentInput {
  flatNumber: string;
  name: string;
  phoneE164: string;
  vehicles: string[];
  emergencyContact?: string;
}

export interface ResidentsTool {
  /** Resolves a resident id from a plaintext phone number via the blind index — never queries the encrypted column. */
  findIdByPhone(phoneE164: string): Promise<string | undefined>;
  /** Looks up a resident by id and decrypts phone_e164/emergency_contact for display/notification use. */
  getContactById(residentId: string): Promise<ResidentContact | null>;
  /** Decrypted phone numbers for every resident — tools/broadcastTool.ts's recipient list. */
  listAllPhones(): Promise<string[]>;
  /** Every resident, decrypted — gateway/adminResidentsRoutes.ts's dashboard list (small society rosters; no pagination yet). */
  listAll(): Promise<ResidentContact[]>;
  /** Insert-or-update by phone number (scripts/seed.ts) — encrypts and hashes before writing. */
  upsert(input: UpsertResidentInput): Promise<{ id: string; phoneE164: string }>;
  /** Removes a resident by id. Returns false if no such resident existed (idempotent from the caller's view). */
  remove(residentId: string): Promise<boolean>;
}

export interface ResidentsToolDeps {
  db?: Database;
  fieldEncryption: FieldEncryption;
}

function toContact(row: ResidentRow, enc: FieldEncryption): ResidentContact {
  return {
    id: row.id,
    name: row.name,
    flatNumber: row.flatNumber,
    phoneE164: enc.decrypt(row.phoneE164),
    emergencyContact: row.emergencyContact ? enc.decrypt(row.emergencyContact) : null,
  };
}

export function createResidentsTool(deps: ResidentsToolDeps): ResidentsTool {
  const db = deps.db ?? getPostgresClient();
  const enc = deps.fieldEncryption;

  return {
    async findIdByPhone(phoneE164) {
      const hash = enc.hashForLookup(phoneE164);
      const [row] = await db
        .select({ id: residents.id })
        .from(residents)
        .where(eq(residents.phoneE164Hash, hash))
        .limit(1);
      return row?.id;
    },

    async getContactById(residentId) {
      const [row] = await db.select().from(residents).where(eq(residents.id, residentId)).limit(1);
      return row ? toContact(row, enc) : null;
    },

    async listAllPhones() {
      const rows = await db.select({ phoneE164: residents.phoneE164 }).from(residents);
      return rows.map((row) => enc.decrypt(row.phoneE164));
    },

    async listAll() {
      const rows = await db.select().from(residents);
      return rows.map((row) => toContact(row, enc));
    },

    async upsert(input) {
      const phoneCiphertext = enc.encrypt(input.phoneE164);
      const phoneHash = enc.hashForLookup(input.phoneE164);

      const [row] = await db
        .insert(residents)
        .values({
          flatNumber: input.flatNumber,
          name: input.name,
          phoneE164: phoneCiphertext,
          phoneE164Hash: phoneHash,
          vehicles: input.vehicles,
          ...(input.emergencyContact
            ? { emergencyContact: enc.encrypt(input.emergencyContact) }
            : {}),
        })
        .onConflictDoUpdate({
          target: residents.phoneE164Hash,
          set: {
            flatNumber: input.flatNumber,
            name: input.name,
            vehicles: input.vehicles,
            ...(input.emergencyContact
              ? { emergencyContact: enc.encrypt(input.emergencyContact) }
              : {}),
          },
        })
        .returning({ id: residents.id });
      if (!row) throw new Error('Failed to upsert resident.');

      return { id: row.id, phoneE164: input.phoneE164 };
    },

    async remove(residentId) {
      const deleted = await db
        .delete(residents)
        .where(eq(residents.id, residentId))
        .returning({ id: residents.id });
      return deleted.length > 0;
    },
  };
}
