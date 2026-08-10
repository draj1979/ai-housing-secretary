# AI Housing Society Secretary Assistant — OpenClaw Gateway service image
# (HLD Sec 5, 13: TypeScript build -> slim runtime image).
#
# Four stages:
#   base       - shared Node 20 + pnpm setup, nothing installed yet
#   deps       - full install (incl. devDependencies) — needed to run `tsc`
#   build      - compiles src/ -> dist/ (tsconfig.build.json excludes
#                *.test.ts — see that file's own comment) and copies the
#                raw *.sql migration files into dist/db/migrations (tsc
#                only emits .ts -> .js; drizzle-orm's migrator reads those
#                .sql files from disk at runtime, so they must ship too)
#   prod-deps  - a *separate* install, --prod only, so devDependencies
#                (typescript, eslint, vitest, ...) never end up in the
#                image that actually runs in production
#   runtime    - the final, slim image: prod-deps' node_modules + build's
#                dist/, nothing else. Runs as a non-root user.
#
# Same image serves all three processes this app runs (HLD Sec 13's
# gateway/worker split) — docker-compose.yml's `worker`/`broadcast-worker`
# services override CMD, they don't need a separate build.

FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:20-slim already has an unprivileged `node` user (uid 1000) — no
# need to create one. Own the app dir so it can be read at runtime.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Liveness (HLD Sec 13) — gateway/health.ts's GET /health, no dependency
# I/O. Only meaningful for the `gateway` service; docker-compose.yml
# overrides/disables this for `worker`/`broadcast-worker` (BullMQ
# consumers, no HTTP server to probe). No curl/wget in node:20-slim, so a
# plain Node script instead of shelling out to either.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/gateway/index.js"]
