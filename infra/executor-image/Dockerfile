# The dev-mode executor image: a T3 Code server that enrolls itself with the
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

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /opt/t3code
COPY . .
RUN corepack install && pnpm install --frozen-lockfile

# Machine-local state (state.sqlite, secrets, checkpoints) lives under the
# T3 home; a named volume makes the executor survive container restarts.
ENV T3CODE_HOME=/data/t3code
VOLUME /data/t3code

EXPOSE 4483
CMD ["node", "apps/server/src/bin.ts", "serve", "--host", "0.0.0.0", "--port", "4483"]
