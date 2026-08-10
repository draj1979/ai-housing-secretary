import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAdminRoutes } from './adminRoutes.js';
import { mintAdminToken, type AdminAuthConfig } from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };

function buildApp(escalationModule: {
  listOpenEscalations: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  registerAdminRoutes(app, { authConfig: CONFIG, escalationModule });
  return app;
}

function bearer(role: 'secretary' | 'read_only') {
  return `Bearer ${mintAdminToken(CONFIG, { sub: 'x', role })}`;
}

describe('GET /admin/escalations', () => {
  it('returns the open escalations for a read_only token', async () => {
    const escalationModule = {
      listOpenEscalations: vi.fn().mockResolvedValue({
        replyText: '1 open escalation(s)',
        escalations: [{ id: 'e1', category: 'legal_matter', status: 'pending' }],
      }),
      acknowledge: vi.fn(),
    };
    const app = buildApp(escalationModule);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/escalations',
      headers: { authorization: bearer('read_only') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      escalations: [{ id: 'e1', category: 'legal_matter', status: 'pending' }],
    });
  });

  it('401s with no token', async () => {
    const app = buildApp({ listOpenEscalations: vi.fn(), acknowledge: vi.fn() });
    const response = await app.inject({ method: 'GET', url: '/admin/escalations' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/escalations/:ref/status', () => {
  it('allows a secretary token to acknowledge', async () => {
    const escalationModule = {
      listOpenEscalations: vi.fn(),
      acknowledge: vi.fn().mockResolvedValue({
        escalationId: 'e1234567-x',
        status: 'acknowledged',
        replyText: 'Escalation e1234567 marked acknowledged.',
      }),
    };
    const app = buildApp(escalationModule);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/escalations/e1234567/status',
      headers: { authorization: bearer('secretary'), 'content-type': 'application/json' },
      payload: { status: 'acknowledged' },
    });

    expect(response.statusCode).toBe(200);
    expect(escalationModule.acknowledge).toHaveBeenCalledWith('e1234567', 'acknowledged');
    expect(response.json()).toEqual({ escalationId: 'e1234567-x', status: 'acknowledged' });
  });

  it('403s a read_only token — role-based access control (HLD Sec 15)', async () => {
    const escalationModule = { listOpenEscalations: vi.fn(), acknowledge: vi.fn() };
    const app = buildApp(escalationModule);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/escalations/e1234567/status',
      headers: { authorization: bearer('read_only'), 'content-type': 'application/json' },
      payload: { status: 'acknowledged' },
    });

    expect(response.statusCode).toBe(403);
    expect(escalationModule.acknowledge).not.toHaveBeenCalled();
  });

  it('400s an invalid status value', async () => {
    const escalationModule = { listOpenEscalations: vi.fn(), acknowledge: vi.fn() };
    const app = buildApp(escalationModule);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/escalations/e1234567/status',
      headers: { authorization: bearer('secretary'), 'content-type': 'application/json' },
      payload: { status: 'bogus' },
    });

    expect(response.statusCode).toBe(400);
    expect(escalationModule.acknowledge).not.toHaveBeenCalled();
  });
});
