import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  mintAdminToken,
  requireAdminAuth,
  requireRole,
  verifyAdminToken,
  type AdminAuthConfig,
} from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };

describe('mintAdminToken / verifyAdminToken', () => {
  it('round-trips a valid token', () => {
    const token = mintAdminToken(CONFIG, { sub: '+919820099000', role: 'secretary' });
    const payload = verifyAdminToken(CONFIG, token);
    expect(payload).toEqual({ sub: '+919820099000', role: 'secretary' });
  });

  it('throws for a token signed with a different secret', () => {
    const token = mintAdminToken(
      { ...CONFIG, secret: 'wrong-secret' },
      { sub: 'x', role: 'secretary' },
    );
    expect(() => verifyAdminToken(CONFIG, token)).toThrow(/Invalid or expired/);
  });

  it('throws for a malformed token string', () => {
    expect(() => verifyAdminToken(CONFIG, 'not-a-jwt')).toThrow(/Invalid or expired/);
  });
});

describe('requireAdminAuth / requireRole (Fastify integration)', () => {
  function buildApp() {
    const app = Fastify();
    app.get(
      '/protected',
      { preHandler: [requireAdminAuth(CONFIG), requireRole('secretary')] },
      async (request) => ({ sub: request.admin?.sub, role: request.admin?.role }),
    );
    app.get(
      '/either-role',
      { preHandler: [requireAdminAuth(CONFIG), requireRole('secretary', 'read_only')] },
      async () => ({ ok: true }),
    );
    return app;
  }

  it('401s when the Authorization header is missing', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
  });

  it('401s for an invalid token', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer garbage' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('403s a read_only token on a secretary-only route', async () => {
    const app = buildApp();
    const token = mintAdminToken(CONFIG, { sub: 'viewer', role: 'read_only' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a secretary token through to a secretary-only route', async () => {
    const app = buildApp();
    const token = mintAdminToken(CONFIG, { sub: '+919820099000', role: 'secretary' });
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sub: '+919820099000', role: 'secretary' });
  });

  it('allows both roles through a route open to either', async () => {
    const app = buildApp();
    for (const role of ['secretary', 'read_only'] as const) {
      const token = mintAdminToken(CONFIG, { sub: 'x', role });
      const response = await app.inject({
        method: 'GET',
        url: '/either-role',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
