/**
 * tools/complaintTool.ts
 *
 * Complaint Management tool (HLD Sec 6.3, 11). Creates a complaint record,
 * generates a human-readable Ticket ID, saves to PostgreSQL, and looks up a
 * complaint's current status by ticket id. Notifying the secretary and
 * replying to the resident are the caller's job — see modules/complaints.ts,
 * which is the actual HLD Sec 6.3/11 workflow (detect -> create -> notify ->
 * confirm, plus the status-check flow) built on top of this tool.
 */
import { eq, sql } from 'drizzle-orm';
import { complaints, residents } from '../db/schema.js';
import { getPostgresClient, type Database } from '../memory/postgresAdapter.js';

export interface CreateComplaintInput {
  residentId: string;
  category?: string;
  description: string;
}

type ComplaintRow = typeof complaints.$inferSelect;
export type ComplaintStatusValue = ComplaintRow['status'];

export interface Complaint {
  id: string;
  ticketId: string;
  status: ComplaintStatusValue;
  /** Denormalized from the resident row at creation time — lets callers (e.g. modules/complaints.ts's secretary notification) avoid a second lookup. */
  flatNumber: string;
}

export interface ComplaintStatus {
  id: string;
  ticketId: string;
  residentId: string;
  category: string;
  description: string;
  status: ComplaintStatusValue;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ComplaintTool {
  createComplaint(input: CreateComplaintInput): Promise<Complaint>;
  /** Looks up a complaint by its exact ticket id (e.g. "TCK-2026-0001"); `null` if none exists. */
  getComplaintByTicketId(ticketId: string): Promise<ComplaintStatus | null>;
}

/**
 * `TCK-{year}-{seq}`, zero-padded to 4 digits — pure formatting, split out
 * from `nextTicketId` so the format/padding rules are unit-testable without
 * a database (see complaintTool.test.ts).
 */
export function formatTicketId(year: number, sequence: number): string {
  if (sequence <= 0) {
    throw new Error(`Ticket sequence must be positive, got ${sequence}.`);
  }
  return `TCK-${year}-${String(sequence).padStart(4, '0')}`;
}

/**
 * Counts existing tickets for the year and formats the next one.
 * Note: this count-then-insert is not race-safe under concurrent complaint
 * creation (two simultaneous complaints could compute the same sequence
 * number) — acceptable at this scale (a single society, not high-frequency
 * writes); a `SERIAL`/advisory-lock-based generator would be the fix if
 * that ever becomes a real problem. Sequential *uniqueness* under normal
 * (non-concurrent) use is verified live — see docs/complaint-management.md.
 */
async function nextTicketId(db: Database, year: number): Promise<string> {
  const prefix = `TCK-${year}-`;
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(complaints)
    .where(sql`${complaints.ticketId} like ${prefix + '%'}`);
  // pg returns count(*) as a string (bigint) — coerce before arithmetic.
  const nextSeq = Number(row?.count ?? 0) + 1;
  return formatTicketId(year, nextSeq);
}

export function createComplaintTool(db: Database = getPostgresClient()): ComplaintTool {
  return {
    async createComplaint(input) {
      const [resident] = await db
        .select({ flatNumber: residents.flatNumber })
        .from(residents)
        .where(eq(residents.id, input.residentId))
        .limit(1);
      if (!resident) {
        throw new Error(`No resident found for id "${input.residentId}".`);
      }

      const ticketId = await nextTicketId(db, new Date().getFullYear());

      const [created] = await db
        .insert(complaints)
        .values({
          ticketId,
          residentId: input.residentId,
          flatNumber: resident.flatNumber,
          category: input.category ?? 'general',
          description: input.description,
        })
        .returning();
      if (!created) throw new Error('Failed to create complaint.');

      return {
        id: created.id,
        ticketId: created.ticketId,
        status: created.status,
        flatNumber: created.flatNumber,
      };
    },

    async getComplaintByTicketId(ticketId) {
      const [row] = await db
        .select()
        .from(complaints)
        .where(eq(complaints.ticketId, ticketId))
        .limit(1);
      if (!row) return null;

      return {
        id: row.id,
        ticketId: row.ticketId,
        residentId: row.residentId,
        category: row.category,
        description: row.description,
        status: row.status,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
      };
    },
  };
}
