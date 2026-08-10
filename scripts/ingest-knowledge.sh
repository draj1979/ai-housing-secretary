#!/usr/bin/env bash
# scripts/ingest-knowledge.sh
#
# Thin wrapper around the TypeScript ingestion implementation
# (scripts/ingest-knowledge.ts), which chunks and embeds /docs/knowledge
# into the configured vector store (HLD Sec 6.2, 7.4). Kept as a shell
# entrypoint so ops runbooks / cron have one stable command.
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm knowledge:ingest
