#!/usr/bin/env bash
# scripts/gcp/remote-deploy.sh
#
# Runs ON the deploy VM (never on the CI runner) — this is what
# scripts/gcp/setup-cicd.sh's github-deployer service account SSHes in
# (via an IAP tunnel, OS Login, no key pairs — see that script and
# docs/deployment.md's "CI/CD Auth" section) and invokes to actually roll
# out a new deploy:
#
#   1. docker compose pull   — fetch the image scripts/gcp/setup-cicd.sh's
#      Artifact Registry auth (configured on this VM by
#      scripts/provision-gcp.sh's startup script) was pushed to.
#   2. Run DB migrations against the already-running (or freshly started)
#      postgres.
#   3. docker compose up -d  — (re)start every service on the new image.
#   4. Poll the local healthcheck endpoint until it returns 200 or
#      HEALTH_TIMEOUT_SECONDS elapses — exits non-zero on timeout, which
#      is CI's signal that the deploy failed and the workflow step should
#      go red (this script does not attempt an automatic rollback; that's
#      intentionally left to the operator/a future phase, since rolling
#      back safely also needs to consider in-flight DB migrations).
#
# Expects DEPLOY_BASE_DIR (default /opt/ai-housing-secretary — see
# scripts/provision-gcp.sh, which creates it) to already contain
# docker-compose.yml and .env — CI delivers/refreshes docker-compose.yml
# on every deploy (scp, alongside this script); .env is set up once by
# following docs/deployment.md's "Clone the repo and configure secrets"
# step (SECRETS_SOURCE=gcp — the app containers resolve real secret
# values from Secret Manager themselves at boot, via this VM's own
# attached service account; nothing secret is ever written into .env by
# this script). What *does* change per deploy is IMAGE_TAG (e.g. the git
# SHA just built) — pass it as an env var to this script; it is not
# persisted back into .env.
#
# Usage (as CI invokes it):
#   IMAGE_TAG=<git-sha> ./remote-deploy.sh
set -euo pipefail

DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt/ai-housing-secretary}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"

# Same IMAGE_TAG default as docker/docker-compose.yml's `image:` fields —
# kept in sync deliberately (see that file's own header comment).
IMAGE_TAG="${IMAGE_TAG:-latest}"
export IMAGE_TAG

# What "healthy" means for step 4. Deliberately the gateway's own port
# (8080), not nginx's (80/443): this confirms the actual app process
# answered, not just that nginx is up — see docs/deployment.md's own
# nginx healthcheck note on why a bare "nginx answered" check (a 301
# still counts as `curl -f` success there) is a weaker signal. Override
# to e.g. http://localhost/health to also exercise the nginx hop.
HEALTH_URL="${HEALTH_URL:-http://localhost:8080/health}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

log() { echo "==> $*" >&2; }

# -----------------------------------------------------------------------------
# 0. Sanity checks — fail fast and clearly rather than partway through a
#    deploy.
# -----------------------------------------------------------------------------

require_files() {
  cd "${DEPLOY_BASE_DIR}"
  if [[ ! -f "${COMPOSE_FILE}" ]]; then
    echo "Missing ${DEPLOY_BASE_DIR}/${COMPOSE_FILE} — CI should scp docker/docker-compose.yml here before invoking this script." >&2
    exit 1
  fi
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Missing ${DEPLOY_BASE_DIR}/${ENV_FILE} — run docs/deployment.md's \"Clone the repo and configure secrets\" step once on this VM first (SECRETS_SOURCE=gcp path recommended)." >&2
    exit 1
  fi
}

# Prefer running docker without sudo (VM operator already in the `docker`
# group); fall back to non-interactive sudo (`-n`, never prompts — works
# unattended under scripts/gcp/setup-cicd.sh's default
# roles/compute.osAdminLogin, which makes the OS Login user a passwordless
# `google-sudoers` member). Fails loudly rather than hanging on a sudo
# password prompt CI could never answer.
DOCKER_CMD=()
resolve_docker_cmd() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo -n docker)
  else
    echo "Cannot run docker (not in the docker group, and passwordless sudo isn't available). See scripts/gcp/setup-cicd.sh's OS_LOGIN_ROLE comment." >&2
    exit 1
  fi
  log "Running docker as: ${DOCKER_CMD[*]}"
}

compose() {
  "${DOCKER_CMD[@]}" compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

# -----------------------------------------------------------------------------
# 1. Pull the freshly-built image(s) — see docker-compose.yml's `image:`
#    fields; the three app services all share one image (one Dockerfile,
#    CMD overridden per service).
# -----------------------------------------------------------------------------

pull_images() {
  log "docker compose pull (IMAGE_TAG=${IMAGE_TAG})"
  compose pull
}

# -----------------------------------------------------------------------------
# 2. Migrations — postgres/redis must be up first (compose's own
#    depends_on: condition: service_healthy handles ordering once
#    `up -d` is told to include them), then run the migration once as a
#    throwaway container so it doesn't matter whether `gateway` is
#    already running.
# -----------------------------------------------------------------------------

run_migrations() {
  log "Ensuring postgres/redis are up before migrating"
  compose up -d postgres redis
  log "Running DB migrations (docker compose run --rm gateway node dist/db/migrate.js)"
  compose run --rm gateway node dist/db/migrate.js
}

# -----------------------------------------------------------------------------
# 3. Roll out — recreates any service whose image/config changed;
#    services already on the new image/config are left untouched.
# -----------------------------------------------------------------------------

roll_out() {
  log "docker compose up -d"
  compose up -d
}

# -----------------------------------------------------------------------------
# 4. Healthcheck gate — this is what makes the deploy step in CI actually
#    fail on a bad rollout instead of reporting success just because
#    `docker compose up -d` returned 0 (a container can start and still
#    be crash-looping or failing its own internal readiness checks).
# -----------------------------------------------------------------------------

wait_for_healthy() {
  log "Waiting up to ${HEALTH_TIMEOUT_SECONDS}s for ${HEALTH_URL} to return 200"
  local waited=0
  local status
  while (( waited < HEALTH_TIMEOUT_SECONDS )); do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HEALTH_URL}" || echo "000")"
    if [[ "${status}" == "200" ]]; then
      log "Healthy (${HEALTH_URL} -> 200) after ${waited}s"
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SECONDS}"
    waited=$((waited + HEALTH_INTERVAL_SECONDS))
  done

  echo "Deploy FAILED: ${HEALTH_URL} did not return 200 within ${HEALTH_TIMEOUT_SECONDS}s (last status: ${status})." >&2
  echo "Recent gateway logs:" >&2
  compose logs --tail=50 gateway >&2 || true
  return 1
}

main() {
  require_files
  resolve_docker_cmd
  pull_images
  run_migrations
  roll_out
  wait_for_healthy
  log "Deploy complete (IMAGE_TAG=${IMAGE_TAG})"
}

main "$@"
