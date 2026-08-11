/**
 * gateway/adminLoginRoutes.ts
 *
 * A real username/password login for the admin dashboard
 * (gateway/adminDashboard.ts), replacing the "paste a token
 * scripts/mint-admin-token.ts printed" flow as the primary UX — that
 * script still exists and still works (useful for scripting/emergency
 * access), but a human secretary logging in through a browser now gets
 * an actual login form instead.
 *
 * Deliberately a single fixed account, not a user-management system —
 * this repo still has no HLD-specified identity provider, and one
 * secretary account is what was actually asked for. `ADMIN_USERNAME`
 * (plain, defaults "admin") + `ADMIN_PASSWORD_HASH` (a bcrypt hash,
 * Secret-Manager-backed like every other credential in this app — see
 * config/secrets.ts) are the only two knobs. A successful login mints the
 * exact same JWT `scripts/mint-admin-token.ts` does
 * (gateway/adminAuth.ts's `mintAdminToken`), always role `secretary` —
 * there's only one account, and it's the one with full access.
 *
 * Rate-limited per source IP (`loginRateLimiter` below) — unlike the
 * out-of-band token flow, a login endpoint is a real, reachable brute-
 * force target the moment it's on the public internet. bcrypt's own cost
 * factor already makes each guess slow; this bounds the *number* of
 * guesses an IP gets regardless, independent of password strength.
 */
import type { FastifyInstance } from 'fastify';
import { compare } from 'bcryptjs';
import { mintAdminToken, type AdminAuthConfig } from './adminAuth.js';

export interface AdminLoginRoutesDeps {
  authConfig: AdminAuthConfig;
  username: string;
  /** bcrypt hash of the real password — never the plaintext password itself. */
  passwordHash: string;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Fixed-window per-IP rate limiter, in-memory — this app runs as a single
 * VM instance (docker-compose, not a multi-replica deployment), so there
 * is no shared-state problem a Redis-backed limiter would be solving
 * here; a plain Map is the simplest thing that's actually correct at
 * this scale. Exported for adminLoginRoutes.test.ts to reset between
 * tests without needing a fresh module instance every time.
 */
export function createLoginRateLimiter(maxAttempts = MAX_ATTEMPTS, windowMs = WINDOW_MS) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  return {
    /** Returns true if this IP is currently allowed to attempt a login. */
    check(ip: string): boolean {
      const entry = attempts.get(ip);
      const now = Date.now();
      if (!entry || now >= entry.resetAt) return true;
      return entry.count < maxAttempts;
    },
    /** Records a failed attempt — call only on wrong-credential failures, not on every request. */
    recordFailure(ip: string): void {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now >= entry.resetAt) {
        attempts.set(ip, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    /** Clears an IP's failure count — call on successful login. */
    clear(ip: string): void {
      attempts.delete(ip);
    },
  };
}

export type LoginRateLimiter = ReturnType<typeof createLoginRateLimiter>;

export function registerAdminLoginRoutes(
  app: FastifyInstance,
  deps: AdminLoginRoutesDeps,
  rateLimiter: LoginRateLimiter = createLoginRateLimiter(),
): void {
  app.post<{ Body: LoginBody }>('/admin/login', async (request, reply) => {
    const ip = request.ip;

    if (!rateLimiter.check(ip)) {
      return reply.code(429).send({ error: 'Too many failed login attempts. Try again later.' });
    }

    const { username, password } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return reply.code(400).send({ error: '"username" and "password" are both required.' });
    }

    // Username isn't a secret (it's a fixed, known value — "admin" by
    // default), so a plain comparison is fine; the password is what
    // actually gates access, via bcrypt's own comparison below.
    if (username !== deps.username) {
      rateLimiter.recordFailure(ip);
      return reply.code(401).send({ error: 'Invalid username or password.' });
    }

    const valid = await compare(password, deps.passwordHash);
    if (!valid) {
      rateLimiter.recordFailure(ip);
      return reply.code(401).send({ error: 'Invalid username or password.' });
    }

    rateLimiter.clear(ip);
    const token = mintAdminToken(deps.authConfig, { sub: deps.username, role: 'secretary' });
    return reply.code(200).send({ token });
  });
}
