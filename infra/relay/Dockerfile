# The relay as deployed on the self-hosted Hetzner host (infra/hetzner): the
# Node relay entry with the workspace installed inside the image, so the host
# carries no Node toolchain and deploys ship the local working tree instead of
# a Git remote. Build from the repository root:
#
#   docker build -t launchpad-relay -f infra/relay/Dockerfile .
#
# The container runs with --network=host, because the relay binds loopback
# and must reach the loopback endpoints its Docker machines advertise, and
# with the host's Docker socket mounted, because machines are sibling
# containers on the host daemon.
FROM node:24-bookworm

# The Docker CLI only; the daemon is the host's, reached through the socket.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /opt/launchpad

COPY package.json ./
RUN corepack install

# Only the relay's workspace subtree, plus the root for its prepare hook — a
# full-lockfile install drags React Native, Expo, and Electron into an image
# that never loads them. The store lives in a build cache mount, so it is
# reused across builds without ever occupying an image layer.
COPY . .
RUN --mount=type=cache,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store \
    --filter @t3tools/monorepo --filter "t3code-relay..."

EXPOSE 8610
CMD ["node", "infra/relay/scripts/dev-server.ts"]
