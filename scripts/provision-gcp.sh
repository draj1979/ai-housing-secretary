#!/usr/bin/env bash
# scripts/provision-gcp.sh
#
# Provisions every GCP resource HLD Sec 14 lists, via the gcloud CLI:
#
#   Compute Engine · Cloud DNS · Static IP · Firewall · Secret Manager ·
#   Cloud SQL (optional, alternative to docker-compose's self-hosted
#   Postgres) · Cloud Storage · Cloud Monitoring · Cloud Logging
#
# The VM it creates also comes up ready for GitHub Actions-driven deploys
# (no SSH key pairs, no service account key file — see
# scripts/gcp/setup-cicd.sh, which grants the actual IAM access on top of
# what's below): OS Login enabled, Docker + the Compose plugin installed,
# Docker pre-authenticated to Artifact Registry via the VM's own attached
# service account, and a fixed DEPLOY_BASE_DIR directory ready for
# scripts/gcp/remote-deploy.sh.
#
# This is a *documented script*, not a Terraform module (by design — see
# the project's docs/deployment.md, which this complements): each function
# below is one resource, checks whether it already exists before creating
# it (safe to re-run), and is heavily commented with *why*, not just *what*.
#
# Usage:
#   cp scripts/provision-gcp.env.example scripts/provision-gcp.env
#   # edit scripts/provision-gcp.env with your project/domain/etc.
#   source scripts/provision-gcp.env
#   ./scripts/provision-gcp.sh
#
# Or set the same variables directly in your shell before running. Nothing
# in this script has a default for PROJECT_ID or DOMAIN — both must be set
# explicitly, on purpose (see "Required variables" below).
#
# After this script, continue with docs/deployment.md from "Install Docker
# + Compose" onward — this script only creates the GCP resources the VM
# and app need; it does not SSH in or bring up the app stack. Then run
# scripts/gcp/setup-cicd.sh to wire up GitHub Actions deploys.
set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration — every value is an env var so this script has no hidden
# defaults for anything that costs money or is hard to reverse (PROJECT_ID,
# DOMAIN). Optional resources (Cloud SQL, DNS) are opt-in via PROVISION_*
# flags, defaulted to the choice that matches docs/deployment.md's default
# path (self-hosted Postgres in docker-compose, DNS managed elsewhere).
# -----------------------------------------------------------------------------

: "${PROJECT_ID:?Set PROJECT_ID (your GCP project id) before running.}"
: "${DOMAIN:?Set DOMAIN (e.g. secretary.example-society.in) before running.}"

REGION="${REGION:-asia-south1}"
ZONE="${ZONE:-asia-south1-a}"

VM_NAME="${VM_NAME:-ai-housing-secretary}"
# Sizing recommendation (HLD Sec 17 NFR_TARGETS: concurrentUsers=500,
# minResidentCapacity=1000 — config/constants.ts):
#   - e2-small  (2 vCPU, 2GB)  — smoke-testing / a handful of residents only.
#     Redis + Postgres + the gateway + 2 worker processes on 2GB is tight;
#     expect swapping under any real WhatsApp traffic burst.
#   - e2-medium (2 vCPU, 4GB) — DEFAULT, recommended starting point. Comfortably
#     runs the full docker-compose stack (gateway + 2 workers + nginx +
#     Postgres + Redis) for a single society (~1000 residents,
#     NFR_TARGETS.concurrentUsers=500) at the <5s average response NFR.
#   - e2-standard-2 (2 vCPU, 8GB) — if also running Chroma (VECTOR_DB_PROVIDER=chroma
#     instead of pgvector) or self-hosted Postgres holds a large knowledge
#     base (HLD Sec 7.4) — the extra headroom is for Postgres/Chroma's own
#     memory use, not the Node processes, which are lightweight.
# Re-run `gcloud compute instances set-machine-type` later to resize
# in-place (VM must be stopped) rather than re-provisioning from scratch.
VM_MACHINE_TYPE="${VM_MACHINE_TYPE:-e2-medium}"
VM_IMAGE_FAMILY="${VM_IMAGE_FAMILY:-debian-12}"
VM_IMAGE_PROJECT="${VM_IMAGE_PROJECT:-debian-cloud}"
VM_BOOT_DISK_SIZE="${VM_BOOT_DISK_SIZE:-30GB}"
VM_SERVICE_ACCOUNT_NAME="${VM_SERVICE_ACCOUNT_NAME:-ai-housing-secretary-vm}"

# OS Login (project/instance metadata `enable-oslogin=TRUE`) replaces
# manually managed SSH key pairs/metadata with IAM-governed SSH: anyone
# granted roles/compute.osLogin or roles/compute.osAdminLogin on this
# instance (see scripts/gcp/setup-cicd.sh, which grants it to the
# GitHub Actions deploy service account) can SSH in using their own GCP
# identity, no key file to generate/distribute/rotate. On by default —
# set ENABLE_OS_LOGIN=false only if this project already manages SSH
# access some other way.
ENABLE_OS_LOGIN="${ENABLE_OS_LOGIN:-true}"

# Fixed path on the VM where scripts/gcp/remote-deploy.sh (invoked by CI
# over SSH) expects docker-compose.yml, nginx.conf.template, and a
# freshly-materialized .env (values pulled from Secret Manager at deploy
# time, never committed) to live. This script only creates the empty,
# correctly-owned directory on first boot — CI populates it on first
# deploy (it doesn't check out the git repo onto the VM at all; only
# these few files travel over SSH/SCP, matching the "no repo build on the
# VM" design in docker/docker-compose.yml's header comment).
DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt/ai-housing-secretary}"

STATIC_IP_NAME="${STATIC_IP_NAME:-ai-housing-secretary-ip}"

# DNS is opt-in: many societies already manage DNS elsewhere (their
# registrar, an existing Cloud DNS zone, etc.) and just need the static IP
# above to point an A record at manually. Set PROVISION_DNS=true to have
# this script also create/manage the zone and record.
PROVISION_DNS="${PROVISION_DNS:-false}"
DNS_ZONE_NAME="${DNS_ZONE_NAME:-ai-housing-secretary-zone}"

# Cloud SQL is explicitly an *alternative* to docker-compose's self-hosted
# `postgres` service (HLD Sec 14 lists it; docs/db-schema.md's design
# doesn't require it) — off by default so re-running this script against
# the default docs/deployment.md path never provisions a second, unused
# Postgres. Set PROVISION_CLOUD_SQL=true to use managed Postgres instead.
PROVISION_CLOUD_SQL="${PROVISION_CLOUD_SQL:-false}"
CLOUD_SQL_INSTANCE_NAME="${CLOUD_SQL_INSTANCE_NAME:-ai-housing-secretary-db}"
# Cloud SQL Postgres 15+ supports the `vector` extension (pgvector) needed
# for knowledge_chunks (HLD Sec 7.4) — see create_cloud_sql() below, which
# enables it explicitly; it is not on by default even on a supported version.
CLOUD_SQL_DATABASE_VERSION="${CLOUD_SQL_DATABASE_VERSION:-POSTGRES_16}"
# 1 vCPU / 3840MiB — the smallest custom machine type comfortable for
# pgvector + this app's write volume at the same ~1000-resident scale the
# VM sizing above targets. Current `gcloud sql instances create` wants
# --cpu/--memory for a custom size (the old `db-custom-N-M` --tier string
# still works on older SDKs, but --cpu/--memory is what `gcloud ... --help`
# documents now). `db-f1-micro`/`db-g1-small` (the cheaper shared-core
# --tier values) are intentionally not the default: Cloud SQL's shared-core
# tiers have historically had flaky pgvector index-build performance under
# any real load. Bump CLOUD_SQL_MEMORY for a larger society.
CLOUD_SQL_CPU="${CLOUD_SQL_CPU:-1}"
CLOUD_SQL_MEMORY="${CLOUD_SQL_MEMORY:-3840MiB}"
CLOUD_SQL_DB_NAME="${CLOUD_SQL_DB_NAME:-ai_housing_secretary}"
CLOUD_SQL_DB_USER="${CLOUD_SQL_DB_USER:-ai_housing_secretary}"

STORAGE_BUCKET_DOCS="${STORAGE_BUCKET_DOCS:-${PROJECT_ID}-society-documents}"
STORAGE_BUCKET_BACKUPS="${STORAGE_BUCKET_BACKUPS:-${PROJECT_ID}-backups}"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() { echo "==> $*" >&2; }

# -----------------------------------------------------------------------------
# 0. Sanity checks + API enablement
# -----------------------------------------------------------------------------

require_gcloud() {
  command -v gcloud >/dev/null || {
    echo "gcloud CLI not found — install the Google Cloud SDK first." >&2
    exit 1
  }
  local active
  active="$(gcloud config get-value account 2>/dev/null || true)"
  if [[ -z "${active}" || "${active}" == "(unset)" ]]; then
    echo "No active gcloud account — run 'gcloud auth login' first." >&2
    exit 1
  fi
  gcloud config set project "${PROJECT_ID}" --quiet
  log "Using project ${PROJECT_ID}, account ${active}"
}

enable_apis() {
  log "Enabling required APIs (skips ones already enabled — safe to re-run)"
  local apis=(
    compute.googleapis.com
    dns.googleapis.com
    secretmanager.googleapis.com
    storage.googleapis.com
    logging.googleapis.com
    monitoring.googleapis.com
    iam.googleapis.com
    oslogin.googleapis.com
    artifactregistry.googleapis.com
  )
  if [[ "${PROVISION_CLOUD_SQL}" == "true" ]]; then
    apis+=(sqladmin.googleapis.com)
  fi
  gcloud services enable "${apis[@]}" --project="${PROJECT_ID}"
}

# -----------------------------------------------------------------------------
# 1. Service account — the VM runs as this, not the operator's own account
#    or the (overly broad) Compute Engine default service account. Minimal
#    roles: read secrets, write logs/metrics, read/write the two buckets,
#    and (only if PROVISION_CLOUD_SQL) connect to Cloud SQL.
# -----------------------------------------------------------------------------

create_service_account() {
  local sa_email="${VM_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${sa_email}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Service account ${sa_email} already exists"
  else
    log "Creating service account ${sa_email}"
    gcloud iam service-accounts create "${VM_SERVICE_ACCOUNT_NAME}" \
      --project="${PROJECT_ID}" \
      --display-name="AI Housing Secretary — Compute Engine VM"
  fi

  log "Granting minimal IAM roles to ${sa_email}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/secretmanager.secretAccessor" --quiet >/dev/null
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/logging.logWriter" --quiet >/dev/null
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/monitoring.metricWriter" --quiet >/dev/null
  if [[ "${PROVISION_CLOUD_SQL}" == "true" ]]; then
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${sa_email}" \
      --role="roles/cloudsql.client" --quiet >/dev/null
  fi
  # Bucket-level (not project-level) access — the VM can read/write these
  # two buckets specifically, not every bucket in the project.
  gcloud storage buckets add-iam-policy-binding "gs://${STORAGE_BUCKET_DOCS}" \
    --member="serviceAccount:${sa_email}" --role="roles/storage.objectAdmin" --quiet >/dev/null 2>&1 || true
  gcloud storage buckets add-iam-policy-binding "gs://${STORAGE_BUCKET_BACKUPS}" \
    --member="serviceAccount:${sa_email}" --role="roles/storage.objectAdmin" --quiet >/dev/null 2>&1 || true
}

# -----------------------------------------------------------------------------
# 2. Static IP — the "Public endpoint" HLD Sec 14 names. Reserved before
#    the VM so DNS (step 3) and the VM creation (step 8) both reference a
#    stable address that doesn't change across VM restarts/recreations.
# -----------------------------------------------------------------------------

create_static_ip() {
  if gcloud compute addresses describe "${STATIC_IP_NAME}" --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Static IP ${STATIC_IP_NAME} already reserved"
  else
    log "Reserving static IP ${STATIC_IP_NAME}"
    gcloud compute addresses create "${STATIC_IP_NAME}" --region="${REGION}" --project="${PROJECT_ID}"
  fi
  gcloud compute addresses describe "${STATIC_IP_NAME}" --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(address)"
}

# -----------------------------------------------------------------------------
# 3. Cloud DNS (optional — PROVISION_DNS=true) — a managed zone + A record
#    pointing DOMAIN at the static IP. Skipped by default (see the
#    PROVISION_DNS comment above); when skipped, point your existing DNS
#    provider's A record at the static IP printed by create_static_ip()
#    manually instead.
# -----------------------------------------------------------------------------

create_dns_zone_and_record() {
  if [[ "${PROVISION_DNS}" != "true" ]]; then
    log "PROVISION_DNS=false — skipping Cloud DNS (point your own DNS provider's A record at the static IP above)"
    return
  fi

  local ip
  ip="$(gcloud compute addresses describe "${STATIC_IP_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format="value(address)")"

  if gcloud dns managed-zones describe "${DNS_ZONE_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Cloud DNS zone ${DNS_ZONE_NAME} already exists"
  else
    log "Creating Cloud DNS zone ${DNS_ZONE_NAME} for ${DOMAIN}"
    gcloud dns managed-zones create "${DNS_ZONE_NAME}" \
      --project="${PROJECT_ID}" --dns-name="${DOMAIN}." --description="AI Housing Secretary"
    echo "  Delegate ${DOMAIN} to this zone's nameservers at your registrar:" >&2
    gcloud dns managed-zones describe "${DNS_ZONE_NAME}" --project="${PROJECT_ID}" --format="value(nameServers)"
  fi

  log "Upserting A record ${DOMAIN} -> ${ip}"
  gcloud dns record-sets transaction start --zone="${DNS_ZONE_NAME}" --project="${PROJECT_ID}"
  gcloud dns record-sets transaction remove --zone="${DNS_ZONE_NAME}" --project="${PROJECT_ID}" \
    --name="${DOMAIN}." --type=A --ttl=300 "${ip}" 2>/dev/null || true
  gcloud dns record-sets transaction add --zone="${DNS_ZONE_NAME}" --project="${PROJECT_ID}" \
    --name="${DOMAIN}." --type=A --ttl=300 "${ip}"
  gcloud dns record-sets transaction execute --zone="${DNS_ZONE_NAME}" --project="${PROJECT_ID}"
}

# -----------------------------------------------------------------------------
# 4. Firewall — HLD Sec 15 "HTTPS only" / Sec 14 "Firewall | HTTP/HTTPS":
#    allow 80/443 ingress, nothing else opened by this script. SSH access
#    is deliberately handled separately (see the note printed at the end)
#    rather than opening port 22 here, so this step matches "allow 80/443
#    only" literally.
# -----------------------------------------------------------------------------

create_firewall_rules() {
  if gcloud compute firewall-rules describe allow-http-https --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Firewall rule allow-http-https already exists"
  else
    log "Creating firewall rule allow-http-https (ingress, tcp:80,443, tag http-server/https-server)"
    gcloud compute firewall-rules create allow-http-https \
      --project="${PROJECT_ID}" \
      --network=default \
      --direction=INGRESS \
      --action=ALLOW \
      --rules=tcp:80,tcp:443 \
      --source-ranges=0.0.0.0/0 \
      --target-tags=http-server,https-server \
      --description="HLD Sec 14/15: HTTP/HTTPS only. WhatsApp webhook + admin dashboard both live behind nginx on these two ports."
  fi
}

# -----------------------------------------------------------------------------
# 5. Secret Manager — HLD Sec 14 "Secret Manager | API Keys", HLD Sec 15
#    "Encrypted secrets". Creates the secret *resources*; does not print or
#    log the values themselves. Prompts interactively (hidden input) for
#    anything not already set as an env var, so real secret values never
#    have to be typed as a CLI argument (which would land in shell history
#    and `ps` output).
# -----------------------------------------------------------------------------

# Creates the secret if it doesn't exist, then adds `value` as a new
# version — safe to re-run to rotate a secret later.
create_or_update_secret() {
  local secret_name="$1"
  local value="$2"

  if [[ -z "${value}" ]]; then
    log "Skipping ${secret_name} (no value provided)"
    return
  fi

  if ! gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Creating secret ${secret_name}"
    gcloud secrets create "${secret_name}" --project="${PROJECT_ID}" --replication-policy=automatic >/dev/null
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${secret_name}" --project="${PROJECT_ID}" --data-file=- >/dev/null
  log "  -> ${secret_name}: new version added"
}

# Reads a value for `secret_name` from the matching env var if set
# (uppercase, underscored — e.g. GEMINI_API_KEY), else prompts for it with
# hidden input. Passing SECRET_PROMPT=false (e.g. in CI) skips prompting
# entirely and just leaves unset secrets unset (create_or_update_secret's
# empty-value skip above handles that).
prompt_or_env() {
  local env_var_name="$1"
  local prompt_text="$2"
  local value="${!env_var_name:-}"
  if [[ -z "${value}" && "${SECRET_PROMPT:-true}" == "true" ]]; then
    read -r -s -p "${prompt_text} (leave blank to skip): " value
    echo >&2
  fi
  printf '%s' "${value}"
}

create_secrets() {
  log "Secret Manager: creating/updating secrets referenced by GCP_SECRET_* in .env.example"
  create_or_update_secret "gemini-api-key" "$(prompt_or_env GEMINI_API_KEY 'GEMINI_API_KEY')"
  create_or_update_secret "whatsapp-cloud-api-token" "$(prompt_or_env WHATSAPP_CLOUD_API_TOKEN 'WHATSAPP_CLOUD_API_TOKEN')"
  create_or_update_secret "jwt-secret" "$(prompt_or_env JWT_SECRET 'JWT_SECRET (blank to skip /admin/* entirely)')"
  create_or_update_secret "field-encryption-key" "$(prompt_or_env FIELD_ENCRYPTION_KEY 'FIELD_ENCRYPTION_KEY (openssl rand -base64 32 if unset)')"
  create_or_update_secret "backup-encryption-key" "$(prompt_or_env BACKUP_ENCRYPTION_KEY 'BACKUP_ENCRYPTION_KEY (scripts/backup.sh — a different passphrase than FIELD_ENCRYPTION_KEY, see docs/security.md)')"

  # database-url depends on whether Cloud SQL was provisioned (step 6) or
  # you're using docker-compose's self-hosted postgres — handled after
  # create_cloud_sql() runs, in main(), not here.

  cat >&2 <<EOF
  Set these in .env to actually use the secrets above:
    SECRETS_SOURCE=gcp
    GCP_SECRET_GEMINI_API_KEY=projects/${PROJECT_ID}/secrets/gemini-api-key/versions/latest
    GCP_SECRET_WHATSAPP_TOKEN=projects/${PROJECT_ID}/secrets/whatsapp-cloud-api-token/versions/latest
    GCP_SECRET_JWT_SECRET=projects/${PROJECT_ID}/secrets/jwt-secret/versions/latest
    GCP_SECRET_FIELD_ENCRYPTION_KEY=projects/${PROJECT_ID}/secrets/field-encryption-key/versions/latest
  (GCP_SECRET_DATABASE_URL is printed after Cloud SQL provisioning, or set
  DATABASE_URL directly in .env for the self-hosted-Postgres path.)
EOF
}

# -----------------------------------------------------------------------------
# 6. Cloud SQL (optional — PROVISION_CLOUD_SQL=true) — HLD Sec 14 "Cloud SQL
#    | PostgreSQL", explicitly offered as an *alternative* to
#    docker-compose's self-hosted `postgres` service, not a replacement by
#    default. Enables pgvector (HLD Sec 7.4's knowledge_chunks needs it)
#    explicitly, since it isn't on by default even on a supported version.
# -----------------------------------------------------------------------------

create_cloud_sql() {
  if [[ "${PROVISION_CLOUD_SQL}" != "true" ]]; then
    log "PROVISION_CLOUD_SQL=false — skipping Cloud SQL (docker-compose's self-hosted postgres service is used instead)"
    return
  fi

  if gcloud sql instances describe "${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Cloud SQL instance ${CLOUD_SQL_INSTANCE_NAME} already exists"
  else
    log "Creating Cloud SQL instance ${CLOUD_SQL_INSTANCE_NAME} (${CLOUD_SQL_DATABASE_VERSION}, ${CLOUD_SQL_CPU} vCPU / ${CLOUD_SQL_MEMORY}) — this takes several minutes"
    gcloud sql instances create "${CLOUD_SQL_INSTANCE_NAME}" \
      --project="${PROJECT_ID}" \
      --database-version="${CLOUD_SQL_DATABASE_VERSION}" \
      --cpu="${CLOUD_SQL_CPU}" \
      --memory="${CLOUD_SQL_MEMORY}" \
      --region="${REGION}" \
      --storage-auto-increase \
      --backup-start-time=02:00
  fi

  if ! gcloud sql databases describe "${CLOUD_SQL_DB_NAME}" --instance="${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Creating database ${CLOUD_SQL_DB_NAME}"
    gcloud sql databases create "${CLOUD_SQL_DB_NAME}" --instance="${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}"
  fi

  local db_password
  db_password="$(openssl rand -base64 24)"
  if gcloud sql users describe "${CLOUD_SQL_DB_USER}" --instance="${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "DB user ${CLOUD_SQL_DB_USER} already exists — leaving its password unchanged (delete it first to rotate via this script)"
  else
    log "Creating DB user ${CLOUD_SQL_DB_USER}"
    gcloud sql users create "${CLOUD_SQL_DB_USER}" --instance="${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" --password="${db_password}"

    # pgvector isn't on by default (see this function's doc comment) —
    # enable it once, right after the database/user exist.
    log "Enabling pgvector on ${CLOUD_SQL_DB_NAME}"
    gcloud sql connect "${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" --user=postgres --database="${CLOUD_SQL_DB_NAME}" --quiet <<<'CREATE EXTENSION IF NOT EXISTS vector;' >/dev/null 2>&1 || \
      log "  Could not auto-enable pgvector (needs an interactive password prompt) — connect manually and run: CREATE EXTENSION IF NOT EXISTS vector;"

    local connection_name
    connection_name="$(gcloud sql instances describe "${CLOUD_SQL_INSTANCE_NAME}" --project="${PROJECT_ID}" --format='value(connectionName)')"
    # Cloud SQL Auth Proxy (running alongside the app, e.g. as another
    # docker-compose service) is the recommended connection path — private
    # IP without exposing Cloud SQL on the public internet. DATABASE_URL
    # below points at the proxy's local port, not Cloud SQL directly.
    create_or_update_secret "database-url" "postgresql://${CLOUD_SQL_DB_USER}:${db_password}@127.0.0.1:5433/${CLOUD_SQL_DB_NAME}"
    cat >&2 <<EOF
  Cloud SQL connection name: ${connection_name}
  Set in .env:
    GCP_CLOUD_SQL_INSTANCE_CONNECTION_NAME=${connection_name}
    GCP_SECRET_DATABASE_URL=projects/${PROJECT_ID}/secrets/database-url/versions/latest
  Run the Cloud SQL Auth Proxy on the VM (docs/deployment.md's Cloud SQL
  section) so DATABASE_URL's 127.0.0.1:5433 above actually resolves —
  the proxy, not the app, holds the real Cloud SQL connection.
EOF
  fi
}

# -----------------------------------------------------------------------------
# 7. Cloud Storage — HLD Sec 14 "Cloud Storage | Documents". Two buckets:
#    society documents (knowledge-base source files ingested by
#    scripts/ingest-knowledge.ts, HLD Sec 7.4) and backups
#    (scripts/backup.sh's BACKUP_GCS_BUCKET — see docs/runbooks/backup-restore.md).
#    Uniform bucket-level access + no public access, matching HLD Sec 15.
# -----------------------------------------------------------------------------

create_storage_bucket() {
  local bucket="$1"
  local description="$2"
  if gcloud storage buckets describe "gs://${bucket}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Bucket gs://${bucket} already exists"
  else
    log "Creating bucket gs://${bucket} (${description})"
    gcloud storage buckets create "gs://${bucket}" \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --uniform-bucket-level-access \
      --public-access-prevention
  fi
}

create_storage_buckets() {
  create_storage_bucket "${STORAGE_BUCKET_DOCS}" "society documents — knowledge base source files"
  create_storage_bucket "${STORAGE_BUCKET_BACKUPS}" "encrypted daily Postgres backups"
  # 90-day lifecycle on the backups bucket, matching scripts/backup.sh's
  # own application-level pruning (belt-and-braces — if the app-level
  # prune ever fails silently, the bucket's own lifecycle rule still caps
  # storage growth).
  log "Setting a 90-day deletion lifecycle rule on gs://${STORAGE_BUCKET_BACKUPS}"
  cat >/tmp/backup-lifecycle.json <<'EOF'
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 90}}]}
EOF
  gcloud storage buckets update "gs://${STORAGE_BUCKET_BACKUPS}" --project="${PROJECT_ID}" \
    --lifecycle-file=/tmp/backup-lifecycle.json
  rm -f /tmp/backup-lifecycle.json
  cat >&2 <<EOF
  Set in .env:
    GCP_STORAGE_BUCKET=${STORAGE_BUCKET_DOCS}
    BACKUP_GCS_BUCKET=gs://${STORAGE_BUCKET_BACKUPS}
EOF
}

# -----------------------------------------------------------------------------
# 8. Compute Engine VM — HLD Sec 14 "Compute Engine | OpenClaw". Boots with
#    a startup script that installs Docker + the Compose plugin, the Ops
#    Agent, configures Docker to authenticate to Artifact Registry (no key
#    file — uses the VM's own attached service account via the metadata
#    server), and creates DEPLOY_BASE_DIR — everything
#    scripts/gcp/remote-deploy.sh needs already in place the moment CI's
#    first deploy runs. See docs/deployment.md's "Install Docker +
#    Compose" step, which then just confirms all this is there rather
#    than installing from scratch.
# -----------------------------------------------------------------------------

create_vm() {
  if gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "VM ${VM_NAME} already exists"
    return
  fi

  local sa_email="${VM_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  local startup_script
  startup_script="$(mktemp)"
  # REGION is substituted below (not left as a startup-script-time
  # variable) so the Artifact Registry host CI pushes to
  # (${REGION}-docker.pkg.dev) and the one Docker is configured to trust
  # here are guaranteed to match, without relying on instance metadata
  # lookups inside the startup script itself.
  cat >"${startup_script}" <<STARTUP
#!/usr/bin/env bash
set -euo pipefail

# 1. Docker + Compose plugin (docs/deployment.md's "Install Docker +
#    Compose" step — done here too so it's ready immediately on first
#    boot). get.docker.com's convenience script already bundles the
#    compose plugin, but install it explicitly too as a fallback in case
#    that ever changes upstream — apt no-ops if it's already present.
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker-compose-plugin
fi

# 2. Google Cloud CLI — not present on the base Debian image. Needed for
#    'gcloud auth configure-docker' (step 3) and useful generally for
#    on-VM troubleshooting. Same apt-repo-add pattern as the Ops Agent
#    below, official Google-signed repo.
if ! command -v gcloud >/dev/null; then
  apt-get update -y
  apt-get install -y apt-transport-https ca-certificates gnupg curl
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    >/etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -y
  apt-get install -y google-cloud-cli
fi

# 3. Docker <-> Artifact Registry auth — configures a docker credential
#    helper (docker-credential-gcloud) that fetches a short-lived access
#    token from the VM's own attached service account (via the metadata
#    server) on every pull/push. No static credential written to disk,
#    nothing for scripts/gcp/remote-deploy.sh to manage or rotate. Runs
#    as root (this whole script does, being a startup-script) so it
#    configures /root/.docker/config.json — matching remote-deploy.sh's
#    own 'sudo docker compose' invocations, which also run as root.
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# 4. Ops Agent — Cloud Monitoring (VM CPU/mem/disk metrics) + Cloud
#    Logging (VM/system logs). Per-container gateway/worker logs are
#    shipped separately via Docker's own gcplogs driver — see
#    docs/deployment.md's "Cloud Monitoring & Logging" section for why
#    this is two mechanisms, not one, and how to wire gcplogs into
#    docker-compose.
if ! systemctl is-active --quiet google-cloud-ops-agent 2>/dev/null; then
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi

# 5. Fixed deploy directory — scripts/gcp/remote-deploy.sh's cwd. CI
#    populates docker-compose.yml/nginx.conf.template/.env here on first
#    deploy (see this function's own header comment); this step only
#    ensures the directory exists with sane ownership beforehand.
mkdir -p "${DEPLOY_BASE_DIR}"
chown root:root "${DEPLOY_BASE_DIR}"
chmod 0755 "${DEPLOY_BASE_DIR}"
STARTUP

  log "Creating VM ${VM_NAME} (${VM_MACHINE_TYPE}, zone ${ZONE}) — see this script's VM_MACHINE_TYPE comment for sizing rationale"
  local os_login_metadata=()
  if [[ "${ENABLE_OS_LOGIN}" == "true" ]]; then
    os_login_metadata=(--metadata=enable-oslogin=TRUE)
    log "OS Login enabled on this instance (ENABLE_OS_LOGIN=true) — see scripts/gcp/setup-cicd.sh for granting SSH access via IAM instead of key pairs"
  fi
  gcloud compute instances create "${VM_NAME}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --machine-type="${VM_MACHINE_TYPE}" \
    --image-family="${VM_IMAGE_FAMILY}" \
    --image-project="${VM_IMAGE_PROJECT}" \
    --boot-disk-size="${VM_BOOT_DISK_SIZE}" \
    --tags=http-server,https-server \
    --address="${STATIC_IP_NAME}" \
    --service-account="${sa_email}" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    "${os_login_metadata[@]}" \
    --metadata-from-file=startup-script="${startup_script}"

  rm -f "${startup_script}"
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------

main() {
  require_gcloud
  enable_apis
  create_static_ip
  create_service_account
  create_storage_buckets
  create_dns_zone_and_record
  create_firewall_rules
  create_secrets
  create_cloud_sql
  create_vm

  cat >&2 <<EOF

==> Done. Next:
  1. If PROVISION_DNS=false, point ${DOMAIN}'s A record at the static IP above.
  2. SSH in: gcloud compute ssh ${VM_NAME} --zone=${ZONE} --project=${PROJECT_ID}
     (SSH itself isn't opened by this script's firewall rule — see the note
     below. Works via your own GCP identity now that OS Login is enabled —
     no SSH key pair to generate or copy.)
  3. Continue at docs/deployment.md's "Clone the repo and configure secrets" step.
  4. To let GitHub Actions deploy to this VM without a service account key,
     run scripts/gcp/setup-cicd.sh next (see docs/deployment.md's "CI/CD Auth"
     section) — it grants the deploy identity SSH access via the same OS
     Login mechanism, scoped to just this instance.

Note on SSH access: this script's firewall rule only opens 80/443 (HLD Sec
14/15's "HTTP/HTTPS only"), on purpose. 'gcloud compute ssh' above works
without any extra firewall rule via Identity-Aware Proxy (IAP) tunneling if
your project has IAP enabled for TCP forwarding; if you get a connection
timeout instead, either enable IAP (recommended — see
https://cloud.google.com/iap/docs/using-tcp-forwarding) or add a narrowly-scoped
SSH rule yourself:
  gcloud compute firewall-rules create allow-ssh-iap \\
    --network=default --direction=INGRESS --action=ALLOW --rules=tcp:22 \\
    --source-ranges=35.235.240.0/20
(35.235.240.0/20 is Google's own IAP range, not "the whole internet" — this
is deliberately not bundled into create_firewall_rules() above so a plain
read of that function matches "80/443 only" exactly.)

DEPLOY_BASE_DIR=${DEPLOY_BASE_DIR} was created on the VM for
scripts/gcp/remote-deploy.sh — CI populates it with docker-compose.yml/
nginx.conf.template/.env on first deploy; nothing to do here yet.
EOF
}

main "$@"
