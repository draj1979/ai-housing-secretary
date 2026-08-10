/**
 * gateway/adminRoutes.ts
 *
 * Internal/admin HTTP endpoints (HLD Sec 15) — the "future committee
 * dashboard" the HLD anticipates. Two routes today, both behind
 * gateway/adminAuth.ts's JWT verification, demonstrating the role split
 * the HLD asks for rather than shipping a full dashboard:
 *
 *   - `GET /admin/escalations` — read-only, either role (`secretary` or
 *     `read_only`) can see the open-escalations queue.
 *   - `POST /admin/escalations/:ref/status` — mutating, `secretary` only.
 *     A `read_only` committee viewer can see the queue but not act on it.
 *
 * Reuses `modules/escalation.ts` rather than a bespoke query — the same
 * `listOpenEscalations`/`acknowledge` the WhatsApp "pending escalations" /
 * "ack <ref>" secretary commands call (docs/escalation-engine.md), so a
 * future HTTP dashboard and the WhatsApp command grammar can never drift
 * on what "open" means or what an acknowledgement does.
 */
import type { FastifyInstance } from 'fastify';
import { requireAdminAuth, requireRole, type AdminAuthConfig } from './adminAuth.js';
import type { EscalationModule } from '../modules/escalation.js';

export interface AdminRoutesDeps {
  authConfig: AdminAuthConfig;
  escalationModule: Pick<EscalationModule, 'listOpenEscalations' | 'acknowledge'>;
}

interface UpdateStatusBody {
  status: 'acknowledged' | 'resolved';
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const auth = requireAdminAuth(deps.authConfig);

  app.get(
    '/admin/escalations',
    { preHandler: [auth, requireRole('secretary', 'read_only')] },
    async () => {
      const outcome = await deps.escalationModule.listOpenEscalations();
      return { escalations: outcome.escalations };
    },
  );

  app.post<{ Params: { ref: string }; Body: UpdateStatusBody }>(
    '/admin/escalations/:ref/status',
    { preHandler: [auth, requireRole('secretary')] },
    async (request, reply) => {
      const { status } = request.body ?? {};
      if (status !== 'acknowledged' && status !== 'resolved') {
        return reply.code(400).send({ error: 'body.status must be "acknowledged" or "resolved".' });
      }
      const outcome = await deps.escalationModule.acknowledge(request.params.ref, status);
      return { escalationId: outcome.escalationId, status: outcome.status };
    },
  );
}
