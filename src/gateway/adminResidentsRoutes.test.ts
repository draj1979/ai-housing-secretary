import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAdminResidentsRoutes } from './adminResidentsRoutes.js';
import { mintAdminToken, type AdminAuthConfig } from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };

function buildApp(residentsTool: {
  listAll: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  registerAdminResidentsRoutes(app, { authConfig: CONFIG, residentsTool });
  return app;
}

function bearer(role: 'secretary' | 'read_only') {
  return `Bearer ${mintAdminToken(CONFIG, { sub: 'x', role })}`;
}

describe('GET /admin/residents', () => {
  it('returns the resident roster for a secretary token', async () => {
    const residentsTool = {
      listAll: vi.fn().mockResolvedValue([
        {
          id: 'r1',
          name: 'Priya Sharma',
          flatNumber: 'A-403',
          phoneE164: '+919620594287',
          emergencyContact: null,
        },
      ]),
      upsert: vi.fn(),
      remove: vi.fn(),
    };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/residents',
      headers: { authorization: bearer('secretary') },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().residents).toHaveLength(1);
  });

  it('403s a read_only token — this surface is secretary-only', async () => {
    const residentsTool = { listAll: vi.fn(), upsert: vi.fn(), remove: vi.fn() };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/residents',
      headers: { authorization: bearer('read_only') },
    });

    expect(response.statusCode).toBe(403);
    expect(residentsTool.listAll).not.toHaveBeenCalled();
  });

  it('401s with no token', async () => {
    const app = buildApp({ listAll: vi.fn(), upsert: vi.fn(), remove: vi.fn() });
    const response = await app.inject({ method: 'GET', url: '/admin/residents' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/residents', () => {
  it('upserts a valid resident', async () => {
    const residentsTool = {
      listAll: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'r1', phoneE164: '+919620594287' }),
      remove: vi.fn(),
    };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/residents',
      headers: { authorization: bearer('secretary'), 'content-type': 'application/json' },
      payload: {
        flatNumber: 'A-403',
        name: 'Priya Sharma',
        phoneE164: '+919620594287',
        vehicles: ['MH12AB1234'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(residentsTool.upsert).toHaveBeenCalledWith({
      flatNumber: 'A-403',
      name: 'Priya Sharma',
      phoneE164: '+919620594287',
      vehicles: ['MH12AB1234'],
    });
  });

  it('400s a phone number not in E.164 form', async () => {
    const residentsTool = { listAll: vi.fn(), upsert: vi.fn(), remove: vi.fn() };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/residents',
      headers: { authorization: bearer('secretary'), 'content-type': 'application/json' },
      payload: { flatNumber: 'A-403', name: 'Priya', phoneE164: '9620594287' },
    });

    expect(response.statusCode).toBe(400);
    expect(residentsTool.upsert).not.toHaveBeenCalled();
  });

  it('400s a missing name', async () => {
    const residentsTool = { listAll: vi.fn(), upsert: vi.fn(), remove: vi.fn() };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/residents',
      headers: { authorization: bearer('secretary'), 'content-type': 'application/json' },
      payload: { flatNumber: 'A-403', phoneE164: '+919620594287' },
    });

    expect(response.statusCode).toBe(400);
    expect(residentsTool.upsert).not.toHaveBeenCalled();
  });
});

describe('DELETE /admin/residents/:id', () => {
  it('removes an existing resident', async () => {
    const residentsTool = {
      listAll: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn().mockResolvedValue(true),
    };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'DELETE',
      url: '/admin/residents/r1',
      headers: { authorization: bearer('secretary') },
    });

    expect(response.statusCode).toBe(200);
    expect(residentsTool.remove).toHaveBeenCalledWith('r1');
  });

  it('404s a resident id that does not exist', async () => {
    const residentsTool = {
      listAll: vi.fn(),
      upsert: vi.fn(),
      remove: vi.fn().mockResolvedValue(false),
    };
    const app = buildApp(residentsTool);

    const response = await app.inject({
      method: 'DELETE',
      url: '/admin/residents/nope',
      headers: { authorization: bearer('secretary') },
    });

    expect(response.statusCode).toBe(404);
  });
});
