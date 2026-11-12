#!/bin/bash
set -euo pipefail

# E2B executes RUN through a login shell, which resets the image's ENV PATH.
# Keep installation in one process and one native snapshot layer.
export PATH=/opt/launchpad/bin:/opt/launchpad/node/bin:/usr/sbin:/usr/bin:/sbin:/bin

# pnpm's WSL probe otherwise triggers systemd's binfmt automount after restore.
ln -sf /dev/null /etc/systemd/system/proc-sys-fs-binfmt_misc.automount
umount --no-canonicalize --lazy /proc/sys/fs/binfmt_misc
test "$(uname -m)" = aarch64
apt-get update
apt-get install -y --no-install-recommends bash ca-certificates curl git gh libatomic1 openssh-client python3 ripgrep tar util-linux xz-utils
rm -rf /var/lib/apt/lists/*

# Stock finalization makes /usr/local writable; trusted tools stay under /opt.
mkdir -p /opt/launchpad/bin /opt/launchpad/node
curl --fail --silent --show-error --location https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-arm64.tar.xz -o /tmp/node.tar.xz
echo '81d8f0fdea9dcd3bfdcfeafc5f8359c151f097e9880b0007c0645ca670d07971  /tmp/node.tar.xz' | sha256sum --check --strict
tar -xJf /tmp/node.tar.xz --strip-components=1 --no-same-owner -C /opt/launchpad/node
rm /tmp/node.tar.xz
npm install --global --no-audit --no-fund @openai/codex@0.159.3 pnpm@11.10.0
npm cache clean --force

# Exec the native harness in the tracked PID rather than its npm Node wrapper.
node --input-type=module <<'JAVASCRIPT'
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const root = "/opt/launchpad/node/lib/node_modules/@openai/codex";
const require = createRequire(root + "/package.json");
const pkg = require.resolve("@openai/codex-linux-arm64/package.json");
if (JSON.parse(fs.readFileSync(root + "/package.json")).version !== "0.159.3" ||
    JSON.parse(fs.readFileSync(pkg)).version !== "0.159.3-linux-arm64")
  throw Error("Unexpected native package");
const executable = fs.realpathSync(path.join(path.dirname(pkg), "vendor/aarch64-unknown-linux-musl/bin/codex"));
if (!executable.startsWith("/opt/launchpad/node/lib/node_modules/") || !/^[a-zA-Z0-9@/._-]+$/.test(executable))
  throw Error("Unexpected native executable");
fs.mkdirSync("/opt/launchpad", { recursive: true });
fs.writeFileSync("/opt/launchpad/codex-native.json", JSON.stringify({
  version: "0.159.3", executable,
  sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex"),
}), { mode: 0o644 });
fs.unlinkSync("/opt/launchpad/node/bin/codex");
const shim = [
  "#!/bin/sh",
  "export CODEX_MANAGED_PACKAGE_ROOT=" + root,
  "unset CODEX_MANAGED_BY_BUN CODEX_MANAGED_BY_PNPM CODEX_MANAGED_BY_VITE_PLUS",
  "export CODEX_MANAGED_BY_NPM=1",
  'exec ' + executable + ' "$@"',
  "",
].join("\n");
fs.writeFileSync("/opt/launchpad/node/bin/codex", shim, { mode: 0o755 });
JAVASCRIPT
codex --version

# Same pinned connector asset as packages/shared/src/relayClient.ts.
curl --fail --silent --show-error --location https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-arm64 -o /opt/launchpad/bin/cloudflared
echo '5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815  /opt/launchpad/bin/cloudflared' | sha256sum --check --strict
chmod 0755 /opt/launchpad/bin/cloudflared
cloudflared --version

# The explicit build context contains only the verified server and image helpers.
cd /opt/launchpad-package
sha256sum --check --strict server.sha256
install -m0444 -o root -g root runner-build-tag /opt/launchpad/runner-build-tag
rm runner-build-tag
mkdir -p /opt/launchpad/server
tar -xzf server.tar.gz --strip-components=1 --no-same-owner -C /opt/launchpad/server
chmod -R a+rX /opt/launchpad/server
rm server.tar.gz server.sha256
test -f /opt/launchpad/server/client/index.html
test -d /opt/launchpad/server/node_modules/node-pty
test -x /opt/launchpad/server/resource-monitor/t3-resource-monitor
/opt/launchpad/server/t3 --version
codex --version
pnpm --version

id user >/dev/null 2>&1 || useradd --create-home --uid 1000 --shell /bin/bash user
test "$(id -u user)" = 1000 && test "$(id -g user)" = 1000
groupadd --gid 10001 launchpad-workflow
useradd --create-home --uid 10001 --gid 10001 --shell /usr/sbin/nologin launchpad-workflow
chmod 0700 /home/launchpad-workflow
install -d -m0700 -o launchpad-workflow -g launchpad-workflow /home/launchpad-workflow/.codex
mkdir -p /workspace /home/user/.launchpad /home/user/.codex
chown user:user /workspace /home/user/.launchpad /home/user/.codex
ln -s /opt/launchpad/server/t3 /opt/launchpad/bin/launchpad-server
install -m0644 /opt/launchpad-package/install.sh /opt/launchpad/install.sh
install -m0755 /opt/launchpad-package/activity.py /opt/launchpad/bin/launchpad-activity
install -m0755 /opt/launchpad-package/workload.py /opt/launchpad/bin/launchpad-workload
install -m0644 /opt/launchpad-package/workflow-checkpoint-reader.py /opt/launchpad/bin/launchpad-workflow-checkpoint-reader.py
install -m0751 -o root -g user "$(readlink -f /usr/bin/python3)" /opt/launchpad/bin/launchpad-workflow-reader-python
test "$(/usr/bin/git --exec-path)" = /usr/lib/git-core
install -m0751 -o root -g user "$(readlink -f /usr/bin/git)" /opt/launchpad/bin/launchpad-workflow-git
install -m0751 -o root -g user /opt/launchpad/server/resource-monitor/t3-resource-monitor /opt/launchpad/bin/launchpad-workflow-setup-owner
install -m0644 /opt/launchpad-package/launchpad-workloads.service /etc/systemd/system/launchpad-workloads.service
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -s /etc/systemd/system/launchpad-workloads.service /etc/systemd/system/multi-user.target.wants/launchpad-workloads.service

# envd command sessions need not inherit the image PATH.
for tool in node npm npx pnpm pnpx codex; do
  ln -s /opt/launchpad/node/bin/$tool /usr/bin/$tool
done
for tool in launchpad-server launchpad-workload launchpad-activity cloudflared; do
  ln -s /opt/launchpad/bin/$tool /usr/bin/$tool
done

# Project dependency installs may compile native modules through node-gyp.
apt-get update
apt-get install -y --no-install-recommends build-essential
rm -rf /var/lib/apt/lists/*
cc -std=c17 -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -Wl,-z,relro,-z,now -o /opt/launchpad-package/workflow-exec /opt/launchpad-package/workflow-exec.c
install -m4750 -o root -g user /opt/launchpad-package/workflow-exec /opt/launchpad/bin/launchpad-workload-exec

# Verify the final tools as the runtime user without retaining another snapshot.
runuser -u user -- env PATH="$PATH" HOME=/home/user bash -euc '
  cd /workspace
  test "$(id -u)" = 1000
  launchpad-server --version
  test -r /opt/launchpad/server/client/index.html
  make --version
  c++ --version
'
cd /
rm -rf /opt/launchpad-package
