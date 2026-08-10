import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerHealthRoutes } from './health.js';

describe('GET /health', () => {
  it('always returns 200 ok, with no dependency checks', async () => {
    const app = Fastify();
    const checkRedis = vi.fn();
    registerHealthRoutes(app, { checkRedis });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(checkRedis).not.toHaveBeenCalled();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when redis is reachable and no postgres check is configured', async () => {
    const app = Fastify();
    registerHealthRoutes(app, { checkRedis: vi.fn().mockResolvedValue(true) });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { redis: 'ok' } });
  });

  it('returns 503 when redis is unreachable', async () => {
    const app = Fastify();
    registerHealthRoutes(app, { checkRedis: vi.fn().mockResolvedValue(false) });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { redis: 'unavailable' } });
  });

  it('returns 503 when checkRedis throws, rather than crashing the route', async () => {
    const app = Fastify();
    registerHealthRoutes(app, { checkRedis: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json().checks.redis).toBe('unavailable');
  });

  it('includes and checks postgres when configured', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      checkRedis: vi.fn().mockResolvedValue(true),
      checkPostgres: vi.fn().mockResolvedValue(true),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { redis: 'ok', postgres: 'ok' } });
  });

  it('is unready if postgres is down even when redis is up', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      checkRedis: vi.fn().mockResolvedValue(true),
      checkPostgres: vi.fn().mockResolvedValue(false),
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      checks: { redis: 'ok', postgres: 'unavailable' },
    });
  });
});
