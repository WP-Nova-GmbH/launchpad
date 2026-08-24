# The dev-mode executor image: a Launchpad server that enrolls itself with the
# relay on startup using the seeded credentials the Docker compute driver
# passes as environment variables (T3CODE_MACHINE_ENROLLMENT_*).
#
# Build from the repository root so the whole workspace is the context:
#
#   docker build -t t3code-executor-dev -f infra/executor-image/Dockerfile .
#
# Dependencies install inside the image rather than being mounted, so native
# modules match the container's platform regardless of the host.
FROM node:24-bookworm

ARG CODEX_VERSION=0.149.0
ARG CLAUDE_CODE_VERSION=2.1.238
ARG CURSOR_AGENT_VERSION=2026.08.11-e8db854
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && npm install --global \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Cursor publishes one archive per Linux architecture rather than an npm
# package. Pin both the release and checksum so rebuilding an executor cannot
# silently pick up a different agent binary.
RUN set -eu; \
  case "${TARGETARCH}" in \
    arm64) cursor_arch=arm64; cursor_sha=ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed ;; \
    amd64) cursor_arch=x64; cursor_sha=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a ;; \
    *) echo "Unsupported executor architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  cursor_archive=/tmp/cursor-agent.tar.gz; \
  curl -fsSL \
    "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz" \
    -o "${cursor_archive}"; \
  echo "${cursor_sha}  ${cursor_archive}" | sha256sum --check --strict; \
  mkdir -p "/usr/local/lib/cursor-agent/${CURSOR_AGENT_VERSION}"; \
  tar --strip-components=1 -xzf "${cursor_archive}" \
    -C "/usr/local/lib/cursor-agent/${CURSOR_AGENT_VERSION}"; \
  ln -s "/usr/local/lib/cursor-agent/${CURSOR_AGENT_VERSION}/cursor-agent" /usr/local/bin/agent; \
  ln -s "/usr/local/lib/cursor-agent/${CURSOR_AGENT_VERSION}/cursor-agent" /usr/local/bin/cursor-agent; \
  rm "${cursor_archive}"

WORKDIR /opt/t3code
COPY . .
RUN corepack install && pnpm install --frozen-lockfile

# Machine-local state (state.sqlite, secrets, checkpoints) and provider account
# sessions live under one durable home. Keeping HOME on the named volume makes
# the provider-native auth stores survive container replacement without copying
# them through the relay.
ENV T3CODE_HOME=/data/t3code
ENV HOME=/data/t3code/home
VOLUME /data/t3code

EXPOSE 4483
CMD ["node", "apps/server/src/bin.ts", "serve", "--host", "0.0.0.0", "--port", "4483"]
