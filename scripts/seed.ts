/**
 * scripts/seed.ts
 *
 * Seeds the database with sample data for local development / demos:
 *   - 5 residents (HLD Sec 7.5)
 *   - 2 complaints against two of them (HLD Sec 6.3, 11), one already
 *     escalated to show the escalations table in use.
 *
 * Idempotent: re-running upserts residents by phone_e164 and skips
 * complaints whose ticket_id already exists, so `pnpm db:seed` is safe to
 * run more than once against the same database.
 *
 * Usage:
 *   pnpm db:seed
 */
import { eq, sql } from 'drizzle-orm';
import { closePostgresClient, getPostgresClient } from '../src/memory/postgresAdapter.js';
import { complaints, escalations } from '../src/db/schema.js';
import { createResidentsTool } from '../src/tools/residentsTool.js';
import {
  createFieldEncryption,
  fieldEncryptionConfigFromEnv,
} from '../src/security/fieldEncryption.js';
import { loadEnv, loadEnvAsync } from '../src/config/env.js';

interface SeedResident {
  flatNumber: string;
  name: string;
  phoneE164: string;
  vehicles: string[];
  emergencyContact: string;
}

const SEED_RESIDENTS: SeedResident[] = [
  {
    flatNumber: 'A-101',
    name: 'Anita Deshmukh',
    phoneE164: '+919820011001',
    vehicles: ['MH12AB1001'],
    emergencyContact: '+919820099001',
  },
  {
    flatNumber: 'A-403',
    name: 'Ravi Kulkarni',
    phoneE164: '+919820011002',
    vehicles: ['MH12AB1002', 'MH12CD2002'],
    emergencyContact: '+919820099002',
  },
  {
    flatNumber: 'B-204',
    name: 'Sunita Rao',
    phoneE164: '+919820011003',
    vehicles: [],
    emergencyContact: '+919820099003',
  },
  {
    flatNumber: 'B-702',
    name: 'Imran Sheikh',
    phoneE164: '+919820011004',
    vehicles: ['MH12EF4004'],
    emergencyContact: '+919820099004',
  },
  {
    flatNumber: 'C-305',
    name: 'Priya Nair',
    phoneE164: '+919820011005',
    vehicles: ['MH12GH5005'],
    emergencyContact: '+919820099005',
  },
];

async function seedResidents(db: ReturnType<typeof getPostgresClient>) {
  // HLD Sec 15: phone_e164/emergency_contact are field-level encrypted at
  // rest — seeding goes through tools/residentsTool.ts like every other
  // write path, rather than inserting plaintext directly.
  const residentsTool = createResidentsTool({
    db,
    fieldEncryption: createFieldEncryption(fieldEncryptionConfigFromEnv(loadEnv())),
  });
  const inserted: Record<string, string> = {};

  for (const resident of SEED_RESIDENTS) {
    const row = await residentsTool.upsert(resident);
    inserted[row.phoneE164] = row.id;
  }

  return inserted;
}

/** Generates the next human-readable ticket id, e.g. TCK-2026-0001. */
async function nextTicketId(db: ReturnType<typeof getPostgresClient>, year: number) {
  const prefix = `TCK-${year}-`;
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(complaints)
    .where(sql`${complaints.ticketId} like ${prefix + '%'}`);
  // pg returns count(*) as a string (bigint) — coerce before arithmetic, or
  // "1" + 1 silently string-concatenates to "11" instead of adding to 2.
  const nextSeq = Number(row?.count ?? 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

async function seedComplaints(
  db: ReturnType<typeof getPostgresClient>,
  residentIdsByPhone: Record<string, string>,
) {
  const year = new Date().getFullYear();

  const seedData = [
    {
      phone: '+919820011002', // Ravi Kulkarni, A-403
      flatNumber: 'A-403',
      category: 'plumbing',
      description: 'Water leakage in A-403, bathroom ceiling is damp.',
      status: 'open' as const,
      escalate: false,
    },
    {
      phone: '+919820011004', // Imran Sheikh, B-702
      flatNumber: 'B-702',
      category: 'security',
      description: 'Gate security guard was absent overnight for the third time this month.',
      status: 'escalated' as const,
      escalate: true,
    },
  ];

  for (const c of seedData) {
    const residentId = residentIdsByPhone[c.phone];
    if (!residentId) continue;

    const existing = await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(eq(complaints.flatNumber, c.flatNumber))
      .limit(1);
    if (existing.length > 0) continue;

    const ticketId = await nextTicketId(db, year);
    const [complaint] = await db
      .insert(complaints)
      .values({
        ticketId,
        residentId,
        flatNumber: c.flatNumber,
        category: c.category,
        description: c.description,
        status: c.status,
      })
      .returning({ id: complaints.id });

    if (complaint && c.escalate) {
      await db.insert(escalations).values({
        sourceType: 'complaint',
        sourceId: complaint.id,
        reason: 'Recurring security lapse — requires committee attention per HLD Sec 16.',
        status: 'pending',
      });
    }

    console.log(`  seeded complaint ${ticketId} (${c.flatNumber})`);
  }
}

async function main() {
  // Real process entry point (HLD Sec 15) — resolves SECRETS_SOURCE=gcp
  // secrets (notably FIELD_ENCRYPTION_KEY, which seedResidents() below
  // needs via the bare loadEnv() call in fieldEncryptionConfigFromEnv)
  // into process.env before getPostgresClient()/loadEnv() re-validate it
  // themselves. See config/env.ts's loadEnvAsync doc comment — same fix
  // as src/db/migrate.ts, same underlying bug.
  await loadEnvAsync();
  const db = getPostgresClient();

  console.log('Seeding residents...');
  const residentIdsByPhone = await seedResidents(db);
  console.log(`  ${Object.keys(residentIdsByPhone).length} residents present.`);

  console.log('Seeding complaints...');
  await seedComplaints(db, residentIdsByPhone);

  console.log('Seed complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => closePostgresClient());
