# Build with infra/relay/scripts/e2b-build-template.mjs. Its explicit context
# contains only the verified CLI release and image helpers; never credentials.
FROM debian:bookworm-20260824-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Native E2B snapshots each build step. Install together to avoid retaining a
# separate disk and RAM snapshot for every downloaded tool and copied helper.
COPY . /opt/launchpad-package/
RUN bash /opt/launchpad-package/install.sh

ENV PATH=/opt/launchpad/bin:/opt/launchpad/node/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/user \
    T3CODE_HOME=/home/user/.launchpad \
    CODEX_HOME=/home/user/.codex \
    T3CODE_NO_BROWSER=1 \
    T3CODE_CLOUDFLARED_PATH=/opt/launchpad/bin/cloudflared \
    T3CODE_EXECUTOR_SELF_UPDATE=0
USER user
WORKDIR /workspace
# No server autostart: enrollment/import and the ownership fence precede activation.
