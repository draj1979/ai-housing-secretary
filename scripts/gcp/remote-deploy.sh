#!/usr/bin/env bash
# scripts/gcp/remote-deploy.sh
#
# Runs ON the deploy VM (never on the CI runner) — this is what
# scripts/gcp/setup-cicd.sh's github-deployer service account SSHes in
# (via an IAP tunnel, OS Login, no key pairs — see that script and
# docs/deployment.md's "CI/CD Auth" section) and invokes to actually roll
# out a new deploy:
#
#   1. Refresh app secrets — fetch the current value of every secret in
#      SECRET_MAP (below) from GCP Secret Manager and write it into
#      ENV_FILE, replacing whatever was there before. This is the one
#      place secret *values* ever touch disk in this whole pipeline —
#      GitHub Actions (.github/workflows/cd.yml) never sees them, only
#      WIF_PROVIDER/WIF_SERVICE_ACCOUNT/GCP_PROJECT_ID/
#      ARTIFACT_REGISTRY_REGION/GCE_VM_NAME/GCE_VM_ZONE, none of which
#      are app secrets. Values are never echoed, printed, or otherwise
#      logged anywhere in this function — see docs/deployment.md's
#      "Secret flow" diagram for the full picture end to end.
#   2. docker compose pull   — fetch the image scripts/gcp/setup-cicd.sh's
#      Artifact Registry auth (configured on this VM by
#      scripts/provision-gcp.sh's startup script) was pushed to.
#   3. Run DB migrations against the already-running (or freshly started)
#      postgres.
#   4. docker compose up -d  — (re)start every service on the new image,
#      picking up step 1's freshly-written .env.
#   5. Poll the local healthcheck endpoint until it returns 200 or
#      HEALTH_TIMEOUT_SECONDS elapses — exits non-zero on timeout, which
#      is CI's signal that the deploy failed and the workflow step should
#      go red. This script itself does not roll back (it wouldn't know
#      what "the previous good tag" was without CD's own bookkeeping) —
#      .github/workflows/cd.yml's deploy job reads LAST_GOOD_TAG_FILE
#      (below) and re-invokes this same script with that tag when a
#      deploy's healthcheck fails, then still fails the workflow so the
#      rollback is visible rather than silently swallowed.
#
# Expects DEPLOY_BASE_DIR (default /opt/ai-housing-secretary — see
# scripts/provision-gcp.sh, which creates it) to already contain:
#   DEPLOY_BASE_DIR/.env                       (set up once, see below)
#   DEPLOY_BASE_DIR/docker/docker-compose.yml  (CI delivers/refreshes this)
#   DEPLOY_BASE_DIR/docker/nginx.conf.template (ditto)
# The docker/ nesting is deliberate, not incidental: docker-compose.yml's
# own `env_file: ../.env` (matching this repo's local-dev layout,
# docker/docker-compose.yml next to root .env) only resolves correctly if
# the compose file is one directory *below* wherever .env actually is —
# get this wrong (e.g. dropping docker-compose.yml straight into
# DEPLOY_BASE_DIR) and every container silently gets no env_file config
# at all, or `docker compose` fails outright looking for .env one level
# too high. CI's sync step (.github/workflows/cd.yml) preserves this
# nesting; do the same if you ever place these files by hand.
#
# .env's non-secret config (DOMAIN, GCP_PROJECT_ID, ports, feature
# flags, ...) is set up once by following docs/deployment.md's "Clone the
# repo and configure secrets" step; its *secret* fields
# (GEMINI_API_KEY/WHATSAPP_CLOUD_API_TOKEN/JWT_SECRET/
# FIELD_ENCRYPTION_KEY) are overwritten by step 1 above on every single
# deploy, so whatever placeholder value they start with doesn't matter.
# What *does* change per deploy is IMAGE_TAG (e.g. the git SHA just
# built) — pass it as the first argument (what CI does) or as an env
# var; neither is persisted back into .env.
#
# On a successful deploy (healthcheck passed), IMAGE_TAG is recorded to
# LAST_GOOD_TAG_FILE (default DEPLOY_BASE_DIR/.last-good-tag) — this is
# the file CD's rollback step reads.
#
# Usage (as CI invokes it):
#   ./remote-deploy.sh <git-sha>
#   # or: IMAGE_TAG=<git-sha> ./remote-deploy.sh
set -euo pipefail

DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt/ai-housing-secretary}"
# Relative to DEPLOY_BASE_DIR (require_files below `cd`s there first) —
# see this script's header comment for why "docker/" is load-bearing, not
# cosmetic.
COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
LAST_GOOD_TAG_FILE="${LAST_GOOD_TAG_FILE:-${DEPLOY_BASE_DIR}/.last-good-tag}"

# Positional arg wins over the env var, which wins over the same
# "latest" default docker/docker-compose.yml's `image:` fields use (see
# that file's own header comment) — kept in sync deliberately.
IMAGE_TAG="${1:-${IMAGE_TAG:-latest}}"
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
    echo "Missing ${DEPLOY_BASE_DIR}/${COMPOSE_FILE} — CI should scp docker/docker-compose.yml (and docker/nginx.conf.template) into DEPLOY_BASE_DIR/docker/ before invoking this script." >&2
    exit 1
  fi
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Missing ${DEPLOY_BASE_DIR}/${ENV_FILE} — run docs/deployment.md's \"Clone the repo and configure secrets\" step once on this VM first (only the non-secret config needs to be right; refresh_secrets() below fills in the real secret values on every run)." >&2
    exit 1
  fi
}

# Prefer running docker without sudo (VM operator already in the `docker`
# group); fall back to non-interactive sudo (`-n`, never prompts — works
# unattended under scripts/gcp/setup-cicd.sh's default
# roles/compute.osAdminLogin, which makes the OS Login user a passwordless
# `google-sudoers` member). Fails loudly rather than hanging on a sudo
# password prompt CI could never answer.
#
# The sudo branch explicitly carries COMPOSE_PROJECT_NAME across the sudo
# boundary (`env COMPOSE_PROJECT_NAME=...`) rather than relying on plain
# `sudo docker ...` to inherit it — sudo resets the environment by
# default (Debian's default `env_reset` sudoers policy), silently
# dropping custom variables like this one, which would otherwise leave
# every deploy invoked through this branch back on Compose's own
# directory-name-derived default project name (see that variable's own
# comment for why that's a real, previously-hit problem, not
# theoretical).
DOCKER_CMD=()
resolve_docker_cmd() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo -n env "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}" docker)
  else
    echo "Cannot run docker (not in the docker group, and passwordless sudo isn't available). See scripts/gcp/setup-cicd.sh's OS_LOGIN_ROLE comment." >&2
    exit 1
  fi
  log "Running docker as: ${DOCKER_CMD[*]}"
}

# COMPOSE_PROJECT_NAME pinned explicitly rather than left to Compose's
# own default (the compose *file's* parent directory basename — i.e.
# "docker", not "ai-housing-secretary", given the DEPLOY_BASE_DIR/docker/
# nesting this script's header comment explains). Confirmed live: without
# this, re-running against an unchanged DEPLOY_BASE_DIR layout still
# produces a *different* project name than before that layout existed,
# leaving the previous run's containers orphaned under the old project
# name — holding the very host ports (5432/6379/8080/80/443) the new
# project's containers then fail to bind, every single deploy.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ai-housing-secretary}"
export COMPOSE_PROJECT_NAME

compose() {
  "${DOCKER_CMD[@]}" compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

# -----------------------------------------------------------------------------
# 1. Refresh app secrets from Secret Manager into .env — the only place
#    secret *values* exist outside Secret Manager itself in this whole
#    pipeline (see docs/deployment.md's "Secret flow" section/diagram).
#    GitHub Actions never holds these; it only ever authenticates via WIF
#    and tells this VM which image tag to run.
#
#    ENV_KEY:secret-name pairs, mirroring config/secrets.ts's
#    SECRET_TARGETS list minus DATABASE_URL — this repo's default deploy
#    path is docker-compose's self-hosted Postgres (a fixed local
#    connection string, not a real external credential; see .env's own
#    DATABASE_URL comment), so DATABASE_URL isn't Secret-Manager-backed
#    here. Add "DATABASE_URL:database-url" to SECRET_MAP too only if
#    you've switched to Cloud SQL (PROVISION_CLOUD_SQL=true,
#    scripts/provision-gcp.sh).
# -----------------------------------------------------------------------------

SECRET_MAP=(
  "GEMINI_API_KEY:gemini-api-key"
  "WHATSAPP_CLOUD_API_TOKEN:whatsapp-cloud-api-token"
  "JWT_SECRET:jwt-secret"
  "FIELD_ENCRYPTION_KEY:field-encryption-key"
)

# Writes ENV_FILE's contents to stdout via sudo when needed — the one
# helper both refresh_secrets() (reading GCP_PROJECT_ID out of it) and
# its own rewrite step share, since ENV_FILE is root-owned 0600 and the
# non-root OS Login path can't `cat` it directly either.
read_env_file() {
  if [[ "${DOCKER_CMD[0]:-}" == "sudo" ]]; then
    sudo -n cat "${ENV_FILE}"
  else
    cat "${ENV_FILE}"
  fi
}

refresh_secrets() {
  log "Refreshing ${#SECRET_MAP[@]} app secret(s) from Secret Manager into ${ENV_FILE} (values never logged)"

  local project_id
  project_id="$(read_env_file | grep -m1 '^GCP_PROJECT_ID=' | cut -d= -f2-)"
  if [[ -z "${project_id}" ]]; then
    echo "GCP_PROJECT_ID not set in ${DEPLOY_BASE_DIR}/${ENV_FILE} — cannot tell which project's Secret Manager to read from." >&2
    exit 1
  fi

  # Rebuild ENV_FILE: every line NOT matching one of SECRET_MAP's keys
  # passes through untouched; each matched key gets a freshly-fetched
  # value appended once. Done via a temp file + atomic `install` rather
  # than editing ENV_FILE in place, so a failed fetch partway through
  # (network blip, a secret rotated to no versions) never leaves ENV_FILE
  # half-written.
  local tmp_env strip_pattern pair env_key secret_name value
  tmp_env="$(mktemp)"
  strip_pattern=""
  for pair in "${SECRET_MAP[@]}"; do
    env_key="${pair%%:*}"
    strip_pattern+="${strip_pattern:+|}^${env_key}="
  done
  read_env_file | grep -vE "${strip_pattern}" >"${tmp_env}"

  for pair in "${SECRET_MAP[@]}"; do
    env_key="${pair%%:*}"
    secret_name="${pair#*:}"
    if ! value="$(gcloud secrets versions access latest --secret="${secret_name}" --project="${project_id}" 2>/dev/null)"; then
      echo "Failed to fetch secret '${secret_name}' (for ${env_key}) from Secret Manager — check it has at least one version, and that this VM's own service account has roles/secretmanager.secretAccessor (scripts/provision-gcp.sh grants this by default). Aborting rather than deploying with a stale or missing value." >&2
      rm -f "${tmp_env}"
      exit 1
    fi
    # printf, not echo — a value that happens to start with '-' is never
    # misread as a flag. Never printed anywhere else in this function.
    printf '%s=%s\n' "${env_key}" "${value}" >>"${tmp_env}"
  done

  if [[ "${DOCKER_CMD[0]:-}" == "sudo" ]]; then
    sudo -n install -o root -g root -m 0600 "${tmp_env}" "${ENV_FILE}"
  else
    install -m 0600 "${tmp_env}" "${ENV_FILE}"
  fi
  rm -f "${tmp_env}"
  log "Secrets refreshed"
}

# -----------------------------------------------------------------------------
# 2. Pull the freshly-built image(s) — see docker-compose.yml's `image:`
#    fields; the three app services all share one image (one Dockerfile,
#    CMD overridden per service).
# -----------------------------------------------------------------------------

pull_images() {
  log "docker compose pull (IMAGE_TAG=${IMAGE_TAG})"
  compose pull
}

# -----------------------------------------------------------------------------
# 3. Migrations — postgres/redis must be up first (compose's own
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
# 4. Roll out — recreates any service whose image/config changed;
#    services already on the new image/config are left untouched.
# -----------------------------------------------------------------------------

roll_out() {
  log "docker compose up -d"
  compose up -d
}

# -----------------------------------------------------------------------------
# 5. Healthcheck gate — this is what makes the deploy step in CI actually
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

# -----------------------------------------------------------------------------
# 6. Record this as the last known-good tag — only reached if
#    wait_for_healthy returned 0. .github/workflows/cd.yml's deploy job
#    reads this file (a plain SSH `cat`, no special tooling) when a
#    *later* deploy fails, to know what to roll back to. Uses the same
#    DOCKER_CMD-derived sudo resolution as everything else in this
#    script, since DEPLOY_BASE_DIR is root-owned (scripts/provision-gcp.sh).
# -----------------------------------------------------------------------------

record_last_good_tag() {
  if [[ "${DOCKER_CMD[0]}" == "sudo" ]]; then
    echo "${IMAGE_TAG}" | sudo -n tee "${LAST_GOOD_TAG_FILE}" >/dev/null
  else
    echo "${IMAGE_TAG}" >"${LAST_GOOD_TAG_FILE}"
  fi
  log "Recorded ${IMAGE_TAG} as the last known-good tag (${LAST_GOOD_TAG_FILE})"
}

main() {
  require_files
  resolve_docker_cmd
  refresh_secrets
  pull_images
  run_migrations
  roll_out
  wait_for_healthy
  record_last_good_tag
  log "Deploy complete (IMAGE_TAG=${IMAGE_TAG})"
}

main "$@"
