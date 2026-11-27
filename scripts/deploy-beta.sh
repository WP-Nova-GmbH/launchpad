#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

die() {
  printf 'Launchpad beta: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--env-file PATH]\n' "$0"
  printf 'Default config: ~/.config/launchpad-beta/beta.env\n'
}

config_path="${XDG_CONFIG_HOME:-$HOME/.config}/launchpad-beta/beta.env"
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --env-file) [[ $# == 2 ]] || die 'Supply one config file after --env-file.'; config_path=$2 ;;
  "") [[ $# == 0 ]] || die 'Expected --env-file PATH.' ;;
  *) usage >&2; exit 1 ;;
esac
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 && $EUID != 0 ]] ||
  die 'Run on the AMD64 Linux host as its deployment user with sudo access.'
[[ -f "$config_path" && -r "$config_path" ]] || die "Create $config_path from infra/beta/beta.env.example."
[[ "$(stat -c '%a' -- "$config_path")" =~ ^[0-7]00$ ]] || die "Run chmod 600 on $config_path."

required=(BETA_HOSTNAME BETA_TUNNEL_TOKEN CLOUDFLARE_API_TOKEN CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY)
integration_keys=(
  GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_PRIVATE_KEY
  LINEAR_WORKFLOW_CLIENT_ID LINEAR_WORKFLOW_CLIENT_SECRET LINEAR_WORKFLOW_ORGANIZATION_ID
  LINEAR_WORKFLOW_WEBHOOK_SECRET LINEAR_WORKFLOW_WEBHOOK_GENERATION LINEAR_WORKFLOW_ADMISSION_ENABLED
)
declare -A config=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || die 'Use one unquoted KEY=value per line in beta.env.'
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case " ${required[*]} ${integration_keys[*]} E2B_HOST_ADDRESSES " in
    *" $key "*) ;;
    *) die "Unknown beta config key: $key." ;;
  esac
  [[ ! ${config[$key]+set} ]] || die "Duplicate beta config key: $key."
  config[$key]=$value
done < "$config_path"
for key in "${required[@]}"; do
  [[ -n "${config[$key]:-}" ]] || die "Set $key in beta.env."
done
hostname=${config[BETA_HOSTNAME]}
[[ "$hostname" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?){2,}$ ]] ||
  die 'Use a lower-case beta hostname such as relay-beta.example.com.'
[[ "${config[CLOUDFLARE_API_TOKEN]}" =~ ^[A-Za-z0-9_-]+$ ]] || die 'Set a Cloudflare API bearer token.'
[[ "${config[BETA_TUNNEL_TOKEN]}" =~ ^[A-Za-z0-9_+/=-]+$ ]] || die 'Set the named tunnel connector token.'

for tool in curl docker flock git ip jq openssl python3 ss sudo vp; do
  command -v "$tool" >/dev/null || die "Install $tool on the beta host, then rerun."
done
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
source infra/beta/local-docker.sh
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || die 'Deploy from a clean beta checkout.'
revision="$(git rev-parse HEAD)"
state_dir=/var/lib/launchpad-beta
runtime_dir=/var/lib/launchpad-e2b
relay_image="launchpad-beta-relay:$revision"
relay_url="https://$hostname"
zone=${hostname#*.}
host_addresses=${config[E2B_HOST_ADDRESSES]:-}
if [[ -z "$host_addresses" ]]; then
  host_addresses="$(ip -j address show scope global | jq -er '[.[].addr_info[].local] | unique | join(",") | select(length > 0)')" ||
    die 'Set E2B_HOST_ADDRESSES to the compute host addresses.'
fi
python3 -c 'import ipaddress, sys; [ipaddress.ip_address(value.strip()) for value in sys.argv[1].split(",")]' "$host_addresses" ||
  die 'Set E2B_HOST_ADDRESSES to a comma-separated list of IP addresses.'

account_id="$(
  printf 'header = "Authorization: Bearer %s"\n' "${config[CLOUDFLARE_API_TOKEN]}" |
    curl -q -fsS --max-time 20 --config - "https://api.cloudflare.com/client/v4/zones?name=$zone&status=active" |
    jq -er --arg zone "$zone" 'select(.success == true) | [.result[] | select(.name == $zone)] |
      select(length == 1) | .[0].account.id | select(test("^[a-f0-9]{32}$"))'
)" || die "Use a beta hostname directly under an active Cloudflare zone and give the API token Zone Read access ($zone)."

sudo -v
require_local_docker
sudo -n docker compose version >/dev/null
sudo -n docker buildx version >/dev/null
sudo -n install -d -m 0755 /run/launchpad-beta
sudo -n touch /run/launchpad-beta/deploy.lock
sudo -n chmod 0644 /run/launchpad-beta/deploy.lock
exec 9</run/launchpad-beta/deploy.lock
flock -n 9 || die 'A beta deployment is in progress.'

# Keep the original sudo ticket valid through native packaging and its cleanup.
deploy_pid=$$
(while sleep 45; do sudo -n -v || { kill -TERM "$deploy_pid"; exit 1; }; done) 9<&- </dev/null >/dev/null 2>&1 &
sudo_refresh=$!
trap 'kill "$sudo_refresh" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

beta_compose() {
  sudo -n env "BETA_STATE_DIR=$state_dir" "BETA_RELAY_IMAGE=$relay_image" \
    docker compose --project-name launchpad-beta --env-file /dev/null -f infra/beta/compose.yaml "$@"
}

write_state_file() {
  sudo -n bash -euc '
    umask 077
    temporary=$(mktemp "$1.XXXXXX")
    trap '\''rm -f -- "$temporary"'\'' EXIT
    cat > "$temporary"
    mv -fT -- "$temporary" "$1"
  ' bash "$state_dir/$1"
}

if ! sudo -n test -d "$state_dir"; then
  occupied="$(sudo -n ss -H -ltn '( sport = :5433 or sport = :8610 or sport = :8611 )')"
  [[ -z "$occupied" ]] || die 'Launchpad beta needs host ports 5433, 8610, and 8611 available.'
fi
sudo -n install -d -m 0700 "$state_dir" "$state_dir/relay-data" "$state_dir/relay-data/thread-artifacts"
if ! sudo -n test -f "$state_dir/postgres.env"; then
  if sudo -n docker volume inspect launchpad-beta_postgres >/dev/null 2>&1; then
    die 'Restore the existing beta postgres.env before using the beta database volume.'
  fi
  printf 'POSTGRES_USER=launchpad_relay\nPOSTGRES_DB=launchpad_relay\nPOSTGRES_PASSWORD=%s\n' \
    "$(openssl rand -hex 24)" | write_state_file postgres.env
fi
password="$(sudo -n sed -n 's/^POSTGRES_PASSWORD=//p' "$state_dir/postgres.env")"
[[ "$password" =~ ^[a-f0-9]{48}$ ]] || die 'Restore the generated beta database password.'
for file in provisioned.env relay.env runner.env tunnel.token; do
  sudo -n test -e "$state_dir/$file" || write_state_file "$file" </dev/null
done
beta_compose config --quiet
occupied="$(sudo -n ss -H -ltn 'sport = :8611')"
if [[ -n "$occupied" && -z "$(beta_compose ps --status running --quiet tunnel)" ]]; then
  die 'Host port 8611 is in use by another service.'
fi

printf 'Building beta relay and preparing stock E2B\n'
if ! sudo -n docker image inspect "$relay_image" >/dev/null 2>&1; then
  git archive --format=tar "$revision" |
    sudo -n docker build -t "$relay_image" -f infra/relay/Dockerfile -
fi
# Include host build and verification tools without installing mobile or desktop.
vp i --frozen-lockfile --filter @t3tools/monorepo \
  --filter 'launchpad-relay...' --filter '@t3tools/scripts...'
E2B_RUNTIME_DIR="$runtime_dir" bash infra/beta/bootstrap-e2b.sh

export E2B_API_URL=http://127.0.0.1:3000 E2B_SANDBOX_URL=http://127.0.0.1:3002
e2b_project="$(sudo -n jq -er '.composeProject' "$runtime_dir/build.json")"
e2b_key="$(sudo -n docker compose --project-name "$e2b_project" --project-directory "$runtime_dir" \
  -f "$runtime_dir/compose.yaml" -f "$runtime_dir/runtime.override.json" \
  -f "$runtime_dir/compose.override.yaml" exec -T api cat /run/e2b/team-api-key)"
[[ -n "$e2b_key" ]] || die 'E2B has no team key.'
key_fingerprint="$(printf '%s' "$e2b_key" | sha256sum | cut -d ' ' -f 1)"
build_dir="${XDG_CACHE_HOME:-$HOME/.cache}/launchpad-beta/$key_fingerprint/$revision"
mkdir -p "$build_dir"
export E2B_API_KEY_FILE="$build_dir/team-key"
export E2B_TEMPLATE_FILE="$build_dir/template.json"
printf '%s\n' "$e2b_key" > "$E2B_API_KEY_FILE"
proof_file="$build_dir/workflow-models.json"

read_runner_selection() {
  template_ref="$(jq -er '.templateRef | strings | select(test("^[a-zA-Z0-9_-]+:build-[a-f0-9-]+$"))' "$E2B_TEMPLATE_FILE")" &&
    build_id="$(jq -er '.buildId | strings | select(test("^[a-zA-Z0-9_-]+$"))' "$E2B_TEMPLATE_FILE")"
}

build_receipt() {
  local build_tag="${template_ref#*:}"
  printf 'infra/relay/.t3/e2b-builds/%s.json\n' "$build_tag"
}

receipt=
model_proof=
if [[ -s "$E2B_TEMPLATE_FILE" ]]; then
  read_runner_selection || die 'The saved runner selection is invalid.'
  if model_proof="$(vp env exec node infra/relay/scripts/e2b-verify-runner.mjs \
    "$template_ref" "$build_id" "$proof_file")"; then
    printf 'Reusing the verified AMD64 runner\n'
  else
    status=$?
    model_proof=
    case "$status" in
      2) printf 'The cached runner is no longer available in E2B\n' ;;
      3) receipt="$(build_receipt)" ;;
      *) die 'Could not verify the cached runner in E2B. Retry before rolling out the relay.' ;;
    esac
  fi
fi
if [[ -z "$model_proof" ]]; then
  if [[ ! -s "$receipt" ]]; then
    printf 'Building AMD64 runner\n'
    # The build wrapper loads the checkout's relay .env. Keep Docker on the checked default.
    E2B_API_KEY="$e2b_key" DOCKER_HOST= DOCKER_CONTEXT= DOCKER_CONFIG= BUILDX_BUILDER= \
      vp run build:vm-template
    read_runner_selection || die 'The new runner selection is invalid.'
    receipt="$(build_receipt)"
  fi
  printf 'Verifying AMD64 runner before relay rollout\n'
  smoke_dir="$(mktemp -d "$build_dir/smoke.XXXXXX")/proof"
  vp env exec node infra/relay/scripts/e2b-runner-smoke.mjs \
    --receipt "$receipt" --output "$smoke_dir" --workflow-isolation
  jq -e '.architecture == "x86_64"' "$smoke_dir/result.json" >/dev/null
  model_proof="$(jq -ce --arg ref "$template_ref" --arg build "$build_id" \
    'select(.templateRef == $ref and .buildId == $build)' "$smoke_dir/workflow-models.json")" ||
    die 'The smoke proof does not match the selected runner.'
  printf '%s\n' "$model_proof" > "$proof_file.tmp"
  mv -f -- "$proof_file.tmp" "$proof_file"
fi

printf 'Starting beta database and applying relay migrations\n'
beta_compose up -d --wait --wait-timeout 90 postgres
database_url="postgres://launchpad_relay:$password@127.0.0.1:5433/launchpad_relay"
deployment_id="$(openssl rand -hex 16)"
{
  printf 'DEV_RELAY_DATABASE_URL=%s\nDEV_RELAY_ISSUER=%s\n' "$database_url" "$relay_url"
  printf 'DEV_RELAY_DEPLOYMENT_ID=%s\n' "$deployment_id"
  printf 'DEV_RELAY_CLOUD_MINT_PRIVATE_KEY_PATH=/var/lib/launchpad-relay/cloud-mint-private.pem\n'
  printf 'DEV_RELAY_ARTIFACT_ROOT=/var/lib/launchpad-relay/thread-artifacts\n'
} | write_state_file provisioned.env
beta_compose stop relay
beta_compose run --rm --no-deps -T --workdir /opt/launchpad/infra/relay relay \
  bash -euc 'RELAY_DATABASE_URL="$DEV_RELAY_DATABASE_URL" pnpm exec drizzle-kit migrate'

{
  printf 'CLERK_PUBLISHABLE_KEY=%s\nCLERK_SECRET_KEY=%s\n' "${config[CLERK_PUBLISHABLE_KEY]}" "${config[CLERK_SECRET_KEY]}"
  printf 'APNS_ENABLED=false\n'
  printf 'CLOUDFLARE_ACCOUNT_ID=%s\nCLOUDFLARE_API_TOKEN=%s\nRELAY_TUNNEL_ZONE_NAME=%s\nMANAGED_ENDPOINT_NAMESPACE=beta\n' \
    "$account_id" "${config[CLOUDFLARE_API_TOKEN]}" "$zone"
  for key in "${integration_keys[@]}"; do
    [[ -n "${config[$key]:-}" ]] && printf '%s=%s\n' "$key" "${config[$key]}"
  done
  printf '\n'
} | write_state_file relay.env
{
  printf 'E2B_API_URL=%s\nE2B_SANDBOX_URL=%s\nE2B_API_KEY=%s\n' "$E2B_API_URL" "$E2B_SANDBOX_URL" "$e2b_key"
  printf 'E2B_PUBLIC_RELAY_URL=%s\nE2B_HOST_ID=beta-amd64-1\nE2B_HOST_ADDRESSES=%s\nE2B_MAX_RUNNING_VMS=1\n' "$relay_url" "$host_addresses"
  printf 'E2B_TEMPLATE_REF=%s\nE2B_TEMPLATE_BUILD_ID=%s\nE2B_WORKFLOW_MODEL_PROOF=%s\n' "$template_ref" "$build_id" "$model_proof"
  printf 'RELAY_THREAD_VM_PROVISIONING_ENABLED=true\nRELAY_WORKFLOW_VM_EXECUTION_ENABLED=true\n'
} | write_state_file runner.env
printf '%s\n' "${config[BETA_TUNNEL_TOKEN]}" | write_state_file tunnel.token

beta_compose up -d --wait --wait-timeout 90 relay
beta_compose stop tunnel
occupied="$(sudo -n ss -H -ltn 'sport = :8611')"
[[ -z "$occupied" ]] || die 'Host port 8611 is in use. The tunnel needs it for its readiness check.'
# Recreate the connector so it remounts the current token file.
beta_compose up -d --no-deps --force-recreate tunnel
curl -q -fsS --max-time 5 --retry 12 --retry-delay 2 --retry-all-errors --noproxy 127.0.0.1 \
  http://127.0.0.1:8611/ready |
  jq -e '.status == 200 and (.readyConnections | type) == "number" and .readyConnections > 0' >/dev/null ||
  die 'The beta tunnel did not connect to Cloudflare. Check the connector token and tunnel logs.'
(
  body="$(mktemp)" || exit 1
  trap 'rm -f -- "$body"' EXIT
  identity="$(curl -q -fsS --max-time 10 --retry 10 --retry-delay 2 --retry-all-errors \
    --output "$body" --write-out '%header{x-launchpad-deployment-id}' \
    "$relay_url/health?deployment=$deployment_id")" || exit 1
  [[ "$identity" == "$deployment_id" ]] &&
    jq -e '.ok == true and .threadVmCapabilities.configured == true and .workflowVmCapabilities.execution == true' "$body" >/dev/null
) ||
  die "Public health at $relay_url/health did not confirm this relay rollout. Check the tunnel route."
printf 'Launchpad beta is ready at %s\n' "$relay_url"
