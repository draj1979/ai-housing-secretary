#!/usr/bin/env bash
# scripts/seed.sh
#
# Thin wrapper around the TypeScript seed implementation (scripts/seed.ts),
# which inserts sample residents and complaints via Drizzle (HLD Sec 7.4,
# 7.5). Kept as a shell entrypoint so ops runbooks / cron have one stable
# command regardless of how the Node seed script evolves.
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm db:seed
