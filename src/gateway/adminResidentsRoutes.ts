/**
 * gateway/adminResidentsRoutes.ts
 *
 * The admin dashboard's resident-roster API — list/add-or-update/remove
 * residents (name, flat number, phone, vehicles, emergency contact).
 * Thin: every route just calls tools/residentsTool.ts, the one module
 * allowed to touch `residents.phone_e164`/`emergency_contact` (HLD
 * Sec 15 field-level encryption) — this file never sees or handles
 * ciphertext, only the plaintext `ResidentContact` shape residentsTool
 * already decrypts for display.
 *
 * `secretary`-only throughout, same reasoning as
 * gateway/adminDocumentsRoutes.ts's header comment — resident PII
 * management has no HLD-specified read-only viewer role either.
 */
import type { FastifyInstance } from 'fastify';
import { requireAdminAuth, requireRole, type AdminAuthConfig } from './adminAuth.js';
import type { ResidentsTool, UpsertResidentInput } from '../tools/residentsTool.js';

export interface AdminResidentsRoutesDeps {
  authConfig: AdminAuthConfig;
  residentsTool: Pick<ResidentsTool, 'listAll' | 'upsert' | 'remove'>;
}

interface UpsertResidentBody {
  flatNumber?: unknown;
  name?: unknown;
  phoneE164?: unknown;
  vehicles?: unknown;
  emergencyContact?: unknown;
}

function validateUpsertBody(
  body: UpsertResidentBody | null | undefined,
): UpsertResidentInput | string {
  if (!body || typeof body !== 'object') return 'Request body is required.';
  const { flatNumber, name, phoneE164, vehicles, emergencyContact } = body;
  if (typeof flatNumber !== 'string' || !flatNumber.trim()) return '"flatNumber" is required.';
  if (typeof name !== 'string' || !name.trim()) return '"name" is required.';
  if (typeof phoneE164 !== 'string' || !phoneE164.startsWith('+')) {
    return '"phoneE164" is required and must be E.164 (start with "+").';
  }
  if (
    vehicles !== undefined &&
    (!Array.isArray(vehicles) || !vehicles.every((v) => typeof v === 'string'))
  ) {
    return '"vehicles" must be an array of strings if provided.';
  }
  if (emergencyContact !== undefined && typeof emergencyContact !== 'string') {
    return '"emergencyContact" must be a string if provided.';
  }
  return {
    flatNumber: flatNumber.trim(),
    name: name.trim(),
    phoneE164,
    vehicles: (vehicles as string[] | undefined) ?? [],
    ...(emergencyContact ? { emergencyContact } : {}),
  };
}

export function registerAdminResidentsRoutes(
  app: FastifyInstance,
  deps: AdminResidentsRoutesDeps,
): void {
  const auth = requireAdminAuth(deps.authConfig);
  const secretaryOnly = requireRole('secretary');

  app.get('/admin/residents', { preHandler: [auth, secretaryOnly] }, async () => {
    const residents = await deps.residentsTool.listAll();
    return { residents };
  });

  app.post<{ Body: UpsertResidentBody }>(
    '/admin/residents',
    { preHandler: [auth, secretaryOnly] },
    async (request, reply) => {
      const validated = validateUpsertBody(request.body);
      if (typeof validated === 'string') {
        return reply.code(400).send({ error: validated });
      }
      const result = await deps.residentsTool.upsert(validated);
      return reply.code(201).send({ resident: result });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/residents/:id',
    { preHandler: [auth, secretaryOnly] },
    async (request, reply) => {
      const removed = await deps.residentsTool.remove(request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: 'No resident with that id.' });
      }
      return { deleted: true };
    },
  );
}
