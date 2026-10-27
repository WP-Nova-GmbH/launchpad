#!/usr/bin/env python3
"""Build the trusted recovery init with the pinned Linux toolchain, without starting a VM."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def checksum(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New private build directory on the Linux host")
    args = parser.parse_args()
    source = Path(__file__).with_name("quarantine")
    lock_path = Path(__file__).with_name("runtime.lock.json")
    lock = json.loads(lock_path.read_text())
    output = args.output.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    shutil.copyfile(source / "init_linux.go", output / "init_linux.go")
    shutil.copyfile(source / "init_linux_test.go", output / "init_linux_test.go")
    image = lock["baseImages"]["golang:${GOLANG_VERSION}-${DEBIAN_VERSION}"]
    base = ["docker", "run", "--rm", "--pull=never", "--network", "none",
            "--mount", f"type=bind,source={output},target=/proof", "--entrypoint", "go", image]
    subprocess.run([*base, "test", "-race", "/proof/init_linux.go", "/proof/init_linux_test.go"], check=True)
    # Separate invocation keeps the test compiler's cgo dependency out of PID 1.
    subprocess.run([*base[:-3], "-e", "CGO_ENABLED=0", "-e", "GOOS=linux", "-e", "GOARCH=arm64",
                    *base[-3:], "build", "-trimpath", "-ldflags=-s -w", "-o", "/proof/init", "/proof/init_linux.go"], check=True)
    receipt = {"format": "launchpad-disk-probe-build-v1", "platform": "linux/arm64", "image": image,
               "sourceSha256": checksum(output / "init_linux.go"), "initSha256": checksum(output / "init"),
               "runtimeLockSha256": checksum(lock_path)}
    (output / "build.json").write_text(json.dumps(receipt) + "\n")
    (output / "build.json").chmod(0o600)
    print("Trusted disk probe built and tested; no VM started.")


if __name__ == "__main__":
    main()
