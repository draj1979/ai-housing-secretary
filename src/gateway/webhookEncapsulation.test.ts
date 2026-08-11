/**
 * gateway/webhookEncapsulation.test.ts
 *
 * Regression test for a real bug found live: registerWebhookRoutes used
 * to call `app.addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)`
 * directly on the shared top-level Fastify instance, which silently
 * broke JSON body parsing for *every other* route registered on the same
 * app — including gateway/adminRoutes.ts's and
 * gateway/adminResidentsRoutes.ts's JSON POST bodies, which would arrive
 * as a raw Buffer instead of a parsed object in the real deployed
 * gateway (gateway/index.ts always registers webhook routes and admin
 * routes on one instance). Invisible in either route file's own unit
 * tests, since those each build a bare `Fastify()` that never also
 * registers webhook.ts's routes — this test deliberately registers both
 * on one instance, the way gateway/index.ts actually does, to catch a
 * regression neither file's own test suite can see on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerWebhookRoutes } from './webhook.js';
import { registerAdminRoutes } from './adminRoutes.js';
import { mintAdminToken, type AdminAuthConfig } from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };

describe('webhook routes + admin routes on the same Fastify instance', () => {
  it("admin JSON POST bodies parse correctly (aren't hijacked by webhook.ts's raw-buffer parser)", async () => {
    const app = Fastify();

    registerWebhookRoutes(app, {
      verifyToken: 'test-verify-token',
      appSecret: 'test-app-secret',
      enqueue: vi.fn(),
    });

    const escalationModule = {
      listOpenEscalations: vi.fn(),
      acknowledge: vi.fn().mockResolvedValue({
        escalationId: 'e1234567-x',
        status: 'acknowledged',
        replyText: 'ok',
      }),
    };
    registerAdminRoutes(app, { authConfig: CONFIG, escalationModule });

    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/escalations/e1234567/status',
      headers: {
        authorization: `Bearer ${mintAdminToken(CONFIG, { sub: 'x', role: 'secretary' })}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ status: 'acknowledged' }),
    });

    expect(response.statusCode).toBe(200);
    // The real bug: acknowledge() never got a string 'status' at all
    // (request.body was a raw Buffer), so this call either never
    // happened or the body's `status` field was undefined.
    expect(escalationModule.acknowledge).toHaveBeenCalledWith('e1234567', 'acknowledged');
  });
});
