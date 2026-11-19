# Sourced by the beta deployment and stock E2B bootstrap.
require_local_docker() {
  sudo -n bash -euc '
    fail() {
      printf "Launchpad beta: %s\n" "$*" >&2
      exit 1
    }

    socket=/var/run/docker.sock
    [[ -S "$socket" ]] || fail "Start the local Docker daemon at $socket."
    socket=$(realpath -e -- "$socket")

    local_endpoint() {
      [[ "$1" == unix:///* && "$(realpath -e -- "${1#unix://}")" == "$socket" ]]
    }
    check_context() {
      local context endpoint
      context=$(docker context show) &&
        endpoint=$(docker context inspect --format "{{.Endpoints.docker.Host}}" "$context") &&
        local_endpoint "$endpoint" ||
        fail "Root Docker must target the local socket at /var/run/docker.sock."
    }

    if [[ -n "${DOCKER_HOST:-}" ]]; then
      local_endpoint "$DOCKER_HOST" || fail "Remove the root Docker host override before deployment."
    fi
    [[ -z "${BUILDX_BUILDER:-}" || "$BUILDX_BUILDER" == default ]] ||
      fail "Remove the root Buildx builder override before deployment."
    check_context
    # The stock verifier runs Docker with these overrides removed.
    unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG
    check_context
  '
}
