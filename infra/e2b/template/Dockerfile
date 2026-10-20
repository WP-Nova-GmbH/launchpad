# Build with infra/relay/scripts/e2b-build-template.mjs. The context contains only
# a packaged CLI release, checksum and explicit workload helpers; never credentials.
# The current self-hosted runtime has been verified on Linux ARM64 only.
FROM debian:bookworm-20260824-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Native Linux only: pnpm probes WSLInterop, which otherwise triggers systemd's
# binfmt automount in restored build VMs. No foreign-binary handlers are needed.
RUN ln -sf /dev/null /etc/systemd/system/proc-sys-fs-binfmt_misc.automount \
 && umount --no-canonicalize --lazy /proc/sys/fs/binfmt_misc

RUN test "$(uname -m)" = aarch64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git gh libatomic1 openssh-client python3 ripgrep tar util-linux xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-arm64.tar.xz -o /tmp/node.tar.xz \
 && echo '81d8f0fdea9dcd3bfdcfeafc5f8359c151f097e9880b0007c0645ca670d07971  /tmp/node.tar.xz' | sha256sum --check --strict \
 && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
 && rm /tmp/node.tar.xz \
 && npm install --global --no-audit --no-fund @openai/codex@0.159.3 pnpm@11.10.0 \
 && npm cache clean --force

# Exec the pinned native harness in the captured workload PID. The npm Node
# wrapper would otherwise leave a second process and forward shutdown signals.
RUN node --input-type=module -e '\
 import fs from "node:fs"; import path from "node:path"; import {createRequire} from "node:module"; import {createHash} from "node:crypto"; \
 const root="/usr/local/lib/node_modules/@openai/codex"; const require=createRequire(root+"/package.json"); \
 const pkg=require.resolve("@openai/codex-linux-arm64/package.json"); \
 if(JSON.parse(fs.readFileSync(root+"/package.json")).version!=="0.159.3" || JSON.parse(fs.readFileSync(pkg)).version!=="0.159.3-linux-arm64") throw Error("Unexpected native package"); \
 const executable=fs.realpathSync(path.join(path.dirname(pkg),"vendor/aarch64-unknown-linux-musl/bin/codex")); \
 if(!executable.startsWith("/usr/local/lib/node_modules/") || !/^[a-zA-Z0-9@/._-]+$/.test(executable)) throw Error("Unexpected native executable"); \
 fs.mkdirSync("/opt/launchpad",{recursive:true}); \
 fs.writeFileSync("/opt/launchpad/codex-native.json",JSON.stringify({version:"0.159.3",executable,sha256:createHash("sha256").update(fs.readFileSync(executable)).digest("hex")}),{mode:0o644}); \
 fs.unlinkSync("/usr/local/bin/codex"); \
 const quote=String.fromCharCode(34); \
 const shim=["#!/bin/sh","export CODEX_MANAGED_PACKAGE_ROOT="+root,"unset CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS","export CODEX_MANAGED_BY_NPM=1","exec "+executable+" "+quote+"$@"+quote,""].join(String.fromCharCode(10)); \
 fs.writeFileSync("/usr/local/bin/codex",shim,{mode:0o755});' \
 && codex --version

# Same pinned connector asset as packages/shared/src/relayClient.ts.
RUN curl --fail --silent --show-error --location https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared \
 && echo '5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815  /usr/local/bin/cloudflared' | sha256sum --check --strict \
 && chmod 0755 /usr/local/bin/cloudflared \
 && cloudflared --version

# Cached build layers cold-boot with systemd; /tmp is not durable across layers.
COPY server.tar.gz /opt/launchpad-package/server.tar.gz
COPY server.sha256 /opt/launchpad-package/server.sha256
RUN cd /opt/launchpad-package \
 && sha256sum --check --strict server.sha256 \
 && mkdir -p /opt/launchpad/server \
 && tar -xzf server.tar.gz --strip-components=1 --no-same-owner -C /opt/launchpad/server \
 && chmod -R a+rX /opt/launchpad/server \
 && rm server.tar.gz server.sha256 \
 && test -f /opt/launchpad/server/client/index.html \
 && test -d /opt/launchpad/server/node_modules/node-pty \
 && test -x /opt/launchpad/server/resource-monitor/t3-resource-monitor \
 && /opt/launchpad/server/t3 --version \
 && codex --version \
 && pnpm --version

RUN (id user >/dev/null 2>&1 || useradd --create-home --uid 1000 --shell /bin/bash user) \
 && mkdir -p /workspace /home/user/.launchpad /home/user/.codex \
 && chown user:user /workspace /home/user/.launchpad /home/user/.codex \
 && ln -s /opt/launchpad/server/t3 /usr/local/bin/launchpad-server

COPY activity.py /usr/local/bin/launchpad-activity
COPY workload.py /usr/local/bin/launchpad-workload
COPY launchpad-workloads.service /etc/systemd/system/launchpad-workloads.service
RUN chmod 0755 /usr/local/bin/launchpad-workload /usr/local/bin/launchpad-activity \
 && mkdir -p /etc/systemd/system/multi-user.target.wants \
 && ln -s /etc/systemd/system/launchpad-workloads.service /etc/systemd/system/multi-user.target.wants/launchpad-workloads.service

ENV HOME=/home/user \
    T3CODE_HOME=/home/user/.launchpad \
    CODEX_HOME=/home/user/.codex \
    T3CODE_NO_BROWSER=1 \
    T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    T3CODE_EXECUTOR_SELF_UPDATE=0
USER user
WORKDIR /workspace
RUN launchpad-server --version && test -r /opt/launchpad/server/client/index.html
# No server autostart: enrollment/import and the ownership fence precede activation.
