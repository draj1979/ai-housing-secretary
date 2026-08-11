import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { hashSync } from 'bcryptjs';
import { registerAdminLoginRoutes, createLoginRateLimiter } from './adminLoginRoutes.js';
import { verifyAdminToken, type AdminAuthConfig } from './adminAuth.js';

const CONFIG: AdminAuthConfig = { secret: 'test-admin-secret', expiresIn: '1h' };
const PASSWORD = 'correct-horse-battery-staple';
const PASSWORD_HASH = hashSync(PASSWORD, 4); // low cost factor — fast tests, not production strength

function buildApp() {
  const app = Fastify();
  registerAdminLoginRoutes(app, {
    authConfig: CONFIG,
    username: 'admin',
    passwordHash: PASSWORD_HASH,
  });
  return app;
}

describe('POST /admin/login', () => {
  it('returns a valid admin JWT for correct credentials', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'admin', password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.token).toBe('string');
    const payload = verifyAdminToken(CONFIG, body.token);
    expect(payload).toEqual({ sub: 'admin', role: 'secretary' });
  });

  it('rejects a wrong password', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'admin', password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong username', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'not-admin', password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('400s when username or password is missing', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'admin' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('never leaks whether the username or the password was wrong', async () => {
    const app = buildApp();

    const wrongUser = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'nope', password: PASSWORD },
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: 'admin', password: 'nope' },
    });

    expect(wrongUser.json()).toEqual(wrongPassword.json());
  });
});

describe('createLoginRateLimiter', () => {
  it('allows attempts under the limit', () => {
    const limiter = createLoginRateLimiter(3, 60_000);
    expect(limiter.check('1.2.3.4')).toBe(true);
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('blocks once the limit is hit within the window', () => {
    const limiter = createLoginRateLimiter(3, 60_000);
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
  });

  it('tracks IPs independently', () => {
    const limiter = createLoginRateLimiter(1, 60_000);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    expect(limiter.check('5.6.7.8')).toBe(true);
  });

  it('clears an IP on success', () => {
    const limiter = createLoginRateLimiter(1, 60_000);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    limiter.clear('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(true);
  });

  it('resets after the window elapses', () => {
    const limiter = createLoginRateLimiter(1, 10);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.check('1.2.3.4')).toBe(false);
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(limiter.check('1.2.3.4')).toBe(true);
        resolve(undefined);
      }, 20);
    });
  });
});

describe('POST /admin/login rate limiting', () => {
  it('429s after too many failed attempts from the same IP', async () => {
    const app = Fastify();
    const limiter = createLoginRateLimiter(2, 60_000);
    registerAdminLoginRoutes(
      app,
      { authConfig: CONFIG, username: 'admin', passwordHash: PASSWORD_HASH },
      limiter,
    );

    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { username: 'admin', password: 'wrong' },
      });

    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
  });
});
