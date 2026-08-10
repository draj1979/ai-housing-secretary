/**
 * gateway/health.ts
 *
 * Healthcheck endpoints (HLD Sec 13) — two distinct routes, not one,
 * because "is the process up" and "can it actually do its job right now"
 * are different questions with different consumers:
 *
 *   - `GET /health` — liveness. No dependency I/O at all: just "the
 *     process is running and answering HTTP". This is what
 *     `docker/nginx.conf`'s `location /health` proxies, and what an
 *     orchestrator's liveness probe should hit — it must never fail just
 *     because Redis or Postgres had a momentary blip, or a restart loop
 *     would kill an otherwise-healthy container over a transient
 *     dependency hiccup.
 *   - `GET /health/ready` — readiness. Actually pings this process's real
 *     dependencies (Redis always; Postgres only when this process touches
 *     it — see gateway/index.ts's `createGateway` doc comment on why the
 *     webhook receiver doesn't always need Postgres) and reports 503 if
 *     any are unreachable. This is what `docker-compose.yml`'s gateway
 *     healthcheck (and, in a real orchestrator, a readiness probe gating
 *     traffic) should hit instead.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface HealthCheckDeps {
  /** Pings Redis — the webhook receiver's one hard dependency (BullMQ enqueue). */
  checkRedis: () => Promise<boolean>;
  /** Pings Postgres — only provided when this process actually touches it (e.g. admin routes mounted, or the full worker gateway). Omitted entirely -> readiness doesn't check Postgres at all, rather than reporting a check for a dependency this process never uses. */
  checkPostgres?: () => Promise<boolean>;
}

interface ReadinessBody {
  status: 'ok' | 'unavailable';
  checks: Record<string, 'ok' | 'unavailable'>;
}

async function safeCheck(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthCheckDeps): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply: FastifyReply) => {
    const redisOk = await safeCheck(deps.checkRedis);
    const postgresOk = deps.checkPostgres ? await safeCheck(deps.checkPostgres) : undefined;

    const ready = redisOk && postgresOk !== false;
    const body: ReadinessBody = {
      status: ready ? 'ok' : 'unavailable',
      checks: {
        redis: redisOk ? 'ok' : 'unavailable',
        ...(postgresOk !== undefined
          ? { postgres: postgresOk ? 'ok' : ('unavailable' as const) }
          : {}),
      },
    };
    return reply.code(ready ? 200 : 503).send(body);
  });
}
