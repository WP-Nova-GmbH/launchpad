#!/usr/bin/env python3
"""Build the standalone Linux snapshot collector without building or starting E2B."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile


def build(output, arch, module=None):
    module = module or Path(__file__).with_name("snapshot-collector")
    output = Path(output).absolute()
    receipt = output.with_name(output.name + ".json")
    if output.exists() or receipt.exists():
        raise ValueError("Choose a new output path; installed binaries are never overwritten")
    manifest = (module / "go.mod").read_text()
    parser = re.search(r"github.com/e2b-dev/infra/packages/shared\s+(v\S+)", manifest)
    if not parser or not (module / "go.sum").is_file():
        raise ValueError("The collector requires a pinned native parser and dependency checksums")
    if arch not in ("arm64", "amd64"):
        raise ValueError("Collector target must be Linux arm64 or amd64")
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "USER", "TMPDIR", "GOPATH", "GOMODCACHE", "GOCACHE",
        "GOPROXY", "GOSUMDB", "GOTOOLCHAIN", "GOENV", "SSL_CERT_FILE", "SSL_CERT_DIR",
    }}
    env.update(CGO_ENABLED="0", GOOS="linux", GOARCH=arch, GOWORK="off", GOFLAGS="-mod=readonly")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".snapshot-collector-build-", dir=output.parent) as scratch:
        binary = Path(scratch) / "launchpad-snapshot-collector"
        subprocess.run(["go", "build", "-p=1", "-trimpath", "-buildvcs=false", "-mod=readonly", "-ldflags=-s -w", "-o", str(binary), "."],
                       cwd=module, env=env, check=True)
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        data = {"schemaVersion": 1, "target": "linux/" + arch,
                "nativeParser": parser.group(1), "binarySha256": digest,
                "binaryBytes": binary.stat().st_size}
        # Link creation refuses a destination which appeared while building.
        os.link(binary, output)
        try:
            with receipt.open("x") as file:
                json.dump(data, file, indent=2)
                file.write("\n")
        except BaseException:
            if output.exists() and os.path.samefile(binary, output):
                output.unlink()
            raise
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="New binary path")
    parser.add_argument("--arch", choices=["arm64", "amd64"],
                        default={"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}.get(platform.machine()))
    args = parser.parse_args()
    result = build(args.output, args.arch)
    print(f"Built {result['target']} collector: {args.output}")
    print("No E2B services were started or changed.")


if __name__ == "__main__":
    main()
