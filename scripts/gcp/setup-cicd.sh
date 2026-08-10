#!/usr/bin/env bash
# scripts/gcp/setup-cicd.sh
#
# Provisions everything GitHub Actions needs to build and deploy this repo
# to the VM `scripts/provision-gcp.sh` created — WITHOUT ever creating or
# storing a GCP service account JSON key in GitHub. GitHub Actions
# authenticates as a dedicated deploy service account via Workload Identity
# Federation (WIF): GitHub's own OIDC token is exchanged, at request time,
# for short-lived GCP credentials scoped to exactly that workflow run. See
# this script's "Print the values" step at the end, and
# docs/deployment.md's "CI/CD Auth" section, for why this is preferred over
# a downloaded key file (no long-lived secret to leak, rotate, or revoke).
#
# What this creates:
#   1. Artifact Registry Docker repository — where CI pushes built images.
#   2. Deploy service account (github-deployer@<project>.iam) — least
#      privilege: push images to that one repo, and reach the deploy VM
#      over SSH via IAP (no broader project role).
#   3. Workload Identity Pool + OIDC Provider trusting
#      https://token.actions.githubusercontent.com, restricted to this
#      repo's GitHub Actions runs.
#   4. A workloadIdentityUser binding letting only workflow runs on
#      PROD_BRANCH (and STAGING_BRANCH, if set) impersonate the deploy
#      service account — a run on any other branch or from a fork cannot.
#
# Prerequisites: the target VM must already exist (run
# scripts/provision-gcp.sh first) — step 2 above scopes IAM bindings to
# that specific instance, which requires the instance to exist.
#
# Idempotent: every resource is describe-before-create, and every IAM
# binding is an additive `add-iam-policy-binding` call, both safe to
# re-run (e.g. after rotating GITHUB_REPO, or adding a STAGING_BRANCH
# later).
#
# Usage:
#   export PROJECT_ID=your-gcp-project
#   export GITHUB_REPO=your-org/ai-housing-secretary   # see note below
#   ./scripts/gcp/setup-cicd.sh
set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

: "${PROJECT_ID:?Set PROJECT_ID (your GCP project id) before running.}"

# NOTE: the HLD/task referenced "kartavya-tech/ai-housing-secretary" as the
# target repo, but at the time this script was written the actual GitHub
# repo is draj1979/ai-housing-secretary (kartavya-tech isn't an org the
# pushing account belongs to — see the repo's own setup history). Default
# reflects the real repo; override if that ever changes (e.g. after a
# transfer to an org).
GITHUB_REPO="${GITHUB_REPO:-draj1979/ai-housing-secretary}"

REGION="${REGION:-asia-south1}"

AR_REPO_NAME="${AR_REPO_NAME:-ai-housing-secretary}"

DEPLOY_SA_NAME="${DEPLOY_SA_NAME:-github-deployer}"

WIF_POOL_NAME="${WIF_POOL_NAME:-github-actions-pool}"
WIF_PROVIDER_NAME="${WIF_PROVIDER_NAME:-github-actions-provider}"

# Must match scripts/provision-gcp.sh's VM_NAME/ZONE for the same project —
# this script does not create the VM, only scopes IAM bindings to it.
GCE_VM_NAME="${GCE_VM_NAME:-ai-housing-secretary}"
GCE_VM_ZONE="${GCE_VM_ZONE:-asia-south1-a}"

# Which branch(es) may impersonate the deploy service account. PROD_BRANCH
# is required and typically "main". Set STAGING_BRANCH (e.g. "develop") to
# additionally allow deploys from that branch with the same service
# account — re-run this script after setting it to add the binding; it's
# additive, so PROD_BRANCH's existing binding is untouched.
PROD_BRANCH="${PROD_BRANCH:-main}"
STAGING_BRANCH="${STAGING_BRANCH:-}"

# How the deploy service account reaches the VM to run the actual deploy
# (pull the new image, `docker compose up -d`). Two options, both scoped
# to the single VM instance, never project-wide in *effect* — though see
# create_deploy_service_account() below for a wrinkle confirmed against a
# real project: roles/iap.tunnelResourceAccessor and (usually)
# OS_LOGIN_ROLE aren't grantable via Compute's own instance-level IAM API
# at all (GCP 400s "not supported for this resource"), so those two are
# actually project-level bindings with an IAM Condition restricting them
# to this one instance's resource name — same real-world scope, different
# API surface. roles/compute.instanceAdmin.v1 *is* instance-level-
# grantable directly, so that one uses the plain instance API.
#   oslogin         (default, narrower) — OS_LOGIN_ROLE (see below;
#                    defaults to roles/compute.osAdminLogin, needed for
#                    unattended `sudo docker compose` — see that var's own
#                    comment) + roles/iap.tunnelResourceAccessor. Lets the
#                    SA SSH in through an IAP tunnel; nothing else (can't
#                    stop/reset/delete the VM, can't touch other instances).
#   instance-admin   — roles/compute.instanceAdmin.v1 +
#                    roles/iap.tunnelResourceAccessor, both scoped to this
#                    one instance. Broader (also allows start/stop/reset/
#                    setMetadata on the VM) — use only if your deploy step
#                    needs that (e.g. resetting the VM as part of rollout).
DEPLOY_VM_ACCESS_MODE="${DEPLOY_VM_ACCESS_MODE:-oslogin}"

# roles/compute.osAdminLogin (not the plain roles/compute.osLogin) is the
# default here on purpose: CI runs docker/docker compose non-interactively
# over SSH (scripts/gcp/remote-deploy.sh) with no TTY to answer a sudo
# password prompt. osAdminLogin is what makes the linked OS Login POSIX
# user a passwordless member of `google-sudoers` — see
# https://cloud.google.com/compute/docs/oslogin/set-up-oslogin#configure_users
# — so `sudo docker compose ...` in remote-deploy.sh actually runs
# unattended. Plain roles/compute.osLogin (regular, non-sudo user) only
# works if you instead put the OS Login user in the VM's local `docker`
# group yourself (not automated by this script, since OS Login usernames
# are generated per-identity and not known ahead of time) — override to
# that only if you've done so. roles/compute.osLoginExternalUser is a
# separate axis (identities *outside* your Cloud Identity org, e.g. a
# Domain Restricted Sharing policy) — not relevant to this same-project
# service account.
OS_LOGIN_ROLE="${OS_LOGIN_ROLE:-roles/compute.osAdminLogin}"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

log() { echo "==> $*" >&2; }

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

require_vm_exists() {
  if ! gcloud compute instances describe "${GCE_VM_NAME}" --zone="${GCE_VM_ZONE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    cat >&2 <<EOF
VM '${GCE_VM_NAME}' not found in zone ${GCE_VM_ZONE} (project ${PROJECT_ID}).
This script scopes IAM bindings to that specific instance, so it must
exist first. Run scripts/provision-gcp.sh (see docs/deployment.md), or set
GCE_VM_NAME/GCE_VM_ZONE to an existing instance, then re-run.
EOF
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# 0. API enablement
# -----------------------------------------------------------------------------

enable_apis() {
  log "Enabling required APIs (skips ones already enabled — safe to re-run)"
  gcloud services enable \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    sts.googleapis.com \
    artifactregistry.googleapis.com \
    compute.googleapis.com \
    iap.googleapis.com \
    cloudresourcemanager.googleapis.com \
    --project="${PROJECT_ID}"
}

# -----------------------------------------------------------------------------
# 1. Artifact Registry — CI pushes gateway/worker/broadcast-worker images
#    here (all three come from the same docker/Dockerfile per
#    docs/deployment.md, tagged per-service at push time).
# -----------------------------------------------------------------------------

create_artifact_registry() {
  if gcloud artifacts repositories describe "${AR_REPO_NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Artifact Registry repo ${AR_REPO_NAME} already exists in ${REGION}"
  else
    log "Creating Artifact Registry repo ${AR_REPO_NAME} in ${REGION}"
    gcloud artifacts repositories create "${AR_REPO_NAME}" \
      --project="${PROJECT_ID}" \
      --repository-format=docker \
      --location="${REGION}" \
      --description="ai-housing-secretary Docker images (gateway/worker/broadcast-worker), built and pushed by GitHub Actions"
  fi
}

# -----------------------------------------------------------------------------
# 2. Deploy service account — least privilege: write access to exactly the
#    one Artifact Registry repo above, and SSH-via-IAP to exactly the one
#    deploy VM. No project-level roles, no key file.
# -----------------------------------------------------------------------------

create_deploy_service_account() {
  local sa_email="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

  if gcloud iam service-accounts describe "${sa_email}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Service account ${sa_email} already exists"
  else
    log "Creating service account ${sa_email}"
    gcloud iam service-accounts create "${DEPLOY_SA_NAME}" \
      --project="${PROJECT_ID}" \
      --display-name="GitHub Actions deploy (ai-housing-secretary)"
  fi

  log "Granting roles/artifactregistry.writer on ${AR_REPO_NAME} (repo-scoped, not project-wide)"
  # --condition=None: required once the project's IAM policy contains any
  # conditioned binding (see create_deploy_service_account()'s instance-
  # scoped grants below) — see scripts/provision-gcp.sh's own comment on
  # this same flag for the full explanation, confirmed live there.
  gcloud artifacts repositories add-iam-policy-binding "${AR_REPO_NAME}" \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/artifactregistry.writer" \
    --condition=None \
    --quiet >/dev/null

  # roles/iap.tunnelResourceAccessor is NOT one of the roles GCP allows
  # binding directly on a Compute instance resource (confirmed live via
  # `gcloud iam list-grantable-roles` against a real instance — it 400s
  # with "not supported for this resource"; only a handful of roles,
  # notably roles/compute.osLogin, support that instance-level API at
  # all). The narrowest mechanism GCP actually offers for this role is a
  # *project*-level binding with an IAM Condition whose expression
  # matches only this one instance's resource name — functionally
  # equivalent scoping, different API surface.
  local instance_resource="projects/${PROJECT_ID}/zones/${GCE_VM_ZONE}/instances/${GCE_VM_NAME}"
  local instance_condition="expression=resource.type == \"compute.googleapis.com/Instance\" && resource.name == \"${instance_resource}\",title=${GCE_VM_NAME}-only"

  log "Granting roles/iap.tunnelResourceAccessor on ${GCE_VM_NAME} (project-level binding, IAM Condition scopes it to this instance only)"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/iap.tunnelResourceAccessor" \
    --condition="${instance_condition}" \
    --quiet >/dev/null

  case "${DEPLOY_VM_ACCESS_MODE}" in
    oslogin)
      # roles/compute.osLogin *is* instance-level-grantable, but the
      # default OS_LOGIN_ROLE (osAdminLogin) is not — same "not supported
      # for this resource" 400 as above — so this uses the same
      # condition-scoped project-level binding for either value, rather
      # than branching on which role string was chosen.
      log "Granting ${OS_LOGIN_ROLE} on ${GCE_VM_NAME} (project-level binding, IAM Condition scopes it to this instance only)"
      gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
        --member="serviceAccount:${sa_email}" \
        --role="${OS_LOGIN_ROLE}" \
        --condition="${instance_condition}" \
        --quiet >/dev/null
      ;;
    instance-admin)
      log "Granting roles/compute.instanceAdmin.v1 on ${GCE_VM_NAME} (instance-scoped)"
      # This one *is* natively instance-level-grantable (unlike the two
      # above), so no IAM Condition is needed for scoping — but
      # --condition=None is still required once the project's policy has
      # any conditioned binding at all, same reasoning as elsewhere here.
      gcloud compute instances add-iam-policy-binding "${GCE_VM_NAME}" \
        --project="${PROJECT_ID}" \
        --zone="${GCE_VM_ZONE}" \
        --member="serviceAccount:${sa_email}" \
        --role="roles/compute.instanceAdmin.v1" \
        --condition=None \
        --quiet >/dev/null
      ;;
    *)
      echo "Unknown DEPLOY_VM_ACCESS_MODE='${DEPLOY_VM_ACCESS_MODE}' (expected 'oslogin' or 'instance-admin')" >&2
      exit 1
      ;;
  esac
}

# -----------------------------------------------------------------------------
# 3. Workload Identity Pool + OIDC Provider — trusts GitHub Actions' own
#    OIDC issuer. attribute-condition restricts token exchange to this
#    repo at all (defense in depth); the *branch* restriction happens in
#    step 4's principal binding, not here, since one provider can serve
#    multiple branches/environments.
# -----------------------------------------------------------------------------

create_workload_identity_pool() {
  if gcloud iam workload-identity-pools describe "${WIF_POOL_NAME}" --location=global --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Workload Identity Pool ${WIF_POOL_NAME} already exists"
  else
    log "Creating Workload Identity Pool ${WIF_POOL_NAME}"
    gcloud iam workload-identity-pools create "${WIF_POOL_NAME}" \
      --project="${PROJECT_ID}" \
      --location=global \
      --display-name="GitHub Actions" \
      --description="Federates GitHub Actions OIDC tokens for ${GITHUB_REPO} — no GCP SA keys stored in GitHub."
  fi
}

create_workload_identity_provider() {
  if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER_NAME}" \
    --workload-identity-pool="${WIF_POOL_NAME}" --location=global --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "Workload Identity Provider ${WIF_PROVIDER_NAME} already exists"
  else
    log "Creating Workload Identity Provider ${WIF_PROVIDER_NAME} (issuer: token.actions.githubusercontent.com)"
    gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER_NAME}" \
      --project="${PROJECT_ID}" \
      --location=global \
      --workload-identity-pool="${WIF_POOL_NAME}" \
      --display-name="GitHub Actions OIDC" \
      --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.actor=assertion.actor" \
      --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
  fi
}

# -----------------------------------------------------------------------------
# 4. Bind the deploy service account to the pool — only a workflow run
#    whose OIDC `sub` claim is exactly
#    repo:${GITHUB_REPO}:ref:refs/heads/<branch> may impersonate it, for
#    each branch listed. GitHub sets `sub` to that literal value for a
#    push-triggered run on a branch (not for pull_request runs or forks),
#    so a fork's PR workflow can never obtain these credentials.
# -----------------------------------------------------------------------------

bind_deploy_sa_to_wif() {
  local project_number sa_email
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  sa_email="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

  local branches=("${PROD_BRANCH}")
  if [[ -n "${STAGING_BRANCH}" ]]; then
    branches+=("${STAGING_BRANCH}")
  fi

  local branch member
  for branch in "${branches[@]}"; do
    member="principal://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/subject/repo:${GITHUB_REPO}:ref:refs/heads/${branch}"
    log "Binding roles/iam.workloadIdentityUser: ${sa_email} <- refs/heads/${branch}"
    gcloud iam service-accounts add-iam-policy-binding "${sa_email}" \
      --project="${PROJECT_ID}" \
      --member="${member}" \
      --role="roles/iam.workloadIdentityUser" \
      --quiet >/dev/null
  done
}

# -----------------------------------------------------------------------------
# main
# -----------------------------------------------------------------------------

main() {
  require_gcloud
  require_vm_exists
  enable_apis
  create_artifact_registry
  create_deploy_service_account
  create_workload_identity_pool
  create_workload_identity_provider
  bind_deploy_sa_to_wif

  local project_number sa_email wif_provider_resource
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  sa_email="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  wif_provider_resource="projects/${project_number}/locations/global/workloadIdentityPools/${WIF_POOL_NAME}/providers/${WIF_PROVIDER_NAME}"

  cat >&2 <<EOF

==> Done. Add these as GitHub Actions repo variables/secrets
    (Settings -> Secrets and variables -> Actions, on ${GITHUB_REPO}):

  WIF_PROVIDER              = ${wif_provider_resource}
  WIF_SERVICE_ACCOUNT       = ${sa_email}
  GCP_PROJECT_ID             = ${PROJECT_ID}
  ARTIFACT_REGISTRY_REGION   = ${REGION}
  GCE_VM_NAME                 = ${GCE_VM_NAME}
  GCE_VM_ZONE                 = ${GCE_VM_ZONE}

None of the above is secret in the credential sense (no key material) —
they're safe as either repo Variables or Secrets; Secrets is the more
conservative default since WIF_PROVIDER/WIF_SERVICE_ACCOUNT together
identify exactly what a workflow can impersonate.

In the workflow, exchange these for short-lived credentials with
google-github-actions/auth, e.g.:

  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: \${{ secrets.WIF_PROVIDER }}
      service_account: \${{ secrets.WIF_SERVICE_ACCOUNT }}

See docs/deployment.md's "CI/CD Auth" section for the full explanation of
why no JSON key is stored, and for the deploy step's IAP-tunneled SSH
pattern (DEPLOY_VM_ACCESS_MODE=${DEPLOY_VM_ACCESS_MODE} was used to grant
VM access above).

Re-run this script any time to add a STAGING_BRANCH binding, rotate which
repo is trusted (GITHUB_REPO), or after recreating the VM.
EOF
}

main "$@"
