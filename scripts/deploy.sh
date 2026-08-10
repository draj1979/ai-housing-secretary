#!/usr/bin/env bash
# scripts/deploy.sh
#
# Deploy the AI Housing Society Secretary Assistant to the GCP Compute
# Engine VM (HLD Sec 13, 14). Placeholder — fill in with the real deploy
# steps (build image, push to Artifact Registry, ssh + docker compose pull/up
# on the VM, run migrations) before use.
#
# Not what you want for *first-time* infrastructure setup — that's
# scripts/provision-gcp.sh (VM/DNS/firewall/Secret Manager/Cloud SQL/
# Storage/Monitoring, HLD Sec 14) plus docs/deployment.md's walkthrough.
# This script is for *re-deploying app code* to an already-provisioned VM.
set -euo pipefail

echo "TODO: implement deploy pipeline per HLD Sec 13/14 — see docs/deployment.md's 'Updating the deployment' section for the manual steps this should automate." >&2
exit 1
