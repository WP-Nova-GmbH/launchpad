#!/usr/bin/env python3
"""Build the pinned E2B development baseline without starting or replacing services."""

import argparse
import hashlib
import json
import platform
import re
import shlex
import shutil
import subprocess
import tarfile
from pathlib import Path


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def capture(*args):
    return subprocess.check_output(args, text=True).strip()


def sha256(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def verify(path, expected):
    if sha256(path) != expected:
        raise ValueError(f"Checksum mismatch: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory on the dedicated Linux host")
    parser.add_argument("--archive", type=Path, help="Already downloaded, checksum-verified source archive")
    parser.add_argument("--patch", type=Path, action="append", default=[],
                        help="Reviewed local runtime patch; repeat to apply in order")
    args = parser.parse_args()
    lock_path = Path(__file__).with_name("runtime.lock.json")
    lock = json.loads(lock_path.read_text())
    if lock["schemaVersion"] != 1:
        raise ValueError("Unsupported runtime lock format")
    arch = {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if platform.system() != "Linux" or f"linux/{arch}" != lock["embed"]["platform"]:
        raise ValueError("This baseline is pinned for Linux ARM64. Run inside the dedicated Lima/Linux host.")
    docker_version = capture("docker", "version", "--format", "{{.Server.Version}}")
    buildx_version = capture("docker", "buildx", "version")
    override_source = Path(__file__).with_name("compose.override.yaml")
    keeper_source = Path(__file__).with_name("e2b-keepalive.ts")
    collector_recipe = Path(__file__).with_name("build-collector.Dockerfile")
    if not keeper_source.is_file():
        keeper_source = Path(__file__).parent.parent / "relay/scripts/e2b-keepalive.ts"
    if not override_source.is_file() or not keeper_source.is_file():
        raise ValueError("Copy the Launchpad Compose override and keeper beside this builder")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(override_source, output / "compose.override.yaml")
    shutil.copyfile(keeper_source, output / "e2b-keepalive.ts")
    archive = output / "runtime-source.tar.gz"
    if args.archive:
        shutil.copyfile(args.archive, archive)
    else:
        run("curl", "--fail", "--location", "--retry", "3", "--output", str(archive), lock["source"]["archiveUrl"])
    verify(archive, lock["source"]["archiveSha256"])
    # A new directory and tar's data filter prevent archive links escaping extraction.
    with tarfile.open(archive) as source_tar:
        source_tar.extractall(output / "source", filter="data")
    source = output / "source" / lock["source"]["archiveDirectory"]
    embed = source / "embed" / "compose"
    verify(embed / "compose.yaml", lock["embed"]["composeSha256"])
    verify(embed / ".env", lock["embed"]["defaultsSha256"])
    patches = []
    for index, patch in enumerate(args.patch):
        saved = output / f"{index + 1:04d}.patch"
        shutil.copyfile(patch, saved)
        run("git", "apply", "--check", str(saved), cwd=source)
        run("git", "apply", str(saved), cwd=source)
        patches.append({"file": saved.name, "sha256": sha256(saved)})
    patch_hash = hashlib.sha256(json.dumps(patches, sort_keys=True).encode()).hexdigest() if patches else "none"
    collector_enabled = (source / "packages/api/cmd/launchpad-build-collector/main.go").is_file()
    if collector_enabled and not collector_recipe.is_file():
        raise ValueError("Copy build-collector.Dockerfile beside this builder")
    suffix = "baseline" if not patches else f"patched-{patch_hash[:12]}"
    version = f'launchpad-{suffix}-{lock["source"]["commit"][:12]}'
    # Routing keys changed upstream: API, host and client-proxy must share this source.
    # Patches may introduce a migration; pin the API and migrator together.
    migration = max(p.name.split("_", 1)[0] for p in (source / "packages/db/migrations").glob("*.sql"))
    if not re.fullmatch(r"[0-9]{14}", migration):
        raise ValueError("Cannot determine the patched API's required database migration")
    images = {}
    for component, package in [("orchestrator", "orchestrator"), ("api", "api"), ("client-proxy", "client-proxy"), ("db-migrator", "db")]:
        recipe = (source / "packages" / package / "Dockerfile").read_text()
        for variable, image in lock["baseImages"].items():
            recipe = recipe.replace(variable, image)
        if any("${" in line for line in recipe.splitlines() if line.startswith("FROM ")):
            raise ValueError(f"Unpinned base image in {component}")
        dockerfile = output / f"{component}.Dockerfile"
        dockerfile.write_text(recipe)
        tag = f"launchpad-e2b-{component}:{version}"
        run("docker", "build", "--platform", f"linux/{arch}", "--progress=plain",
            "--build-arg", f'COMMIT_SHA={lock["source"]["commit"]}',
            "--build-arg", f"VERSION={version}",
            "--build-arg", f"EXPECTED_MIGRATION_TIMESTAMP={migration}",
            "--label", f'org.opencontainers.image.revision={lock["source"]["commit"]}',
            "--label", f'org.opencontainers.image.source={lock["source"]["repository"]}',
            "--label", f"org.opencontainers.image.version={version}",
            "--label", f"io.launchpad.runtime.patches={patch_hash}",
            "--tag", tag, "--file", str(dockerfile), str(source / "packages"))
        # Local image IDs bind this deployment to the actual build, even if tags move.
        images[component] = {"tag": tag, "id": capture("docker", "image", "inspect", tag, "--format", "{{.Id}}")}

    if collector_enabled:
        tag = f"launchpad-e2b-build-collector:{version}"
        run("docker", "build", "--platform", f"linux/{arch}", "--progress=plain",
            "--label", f'org.opencontainers.image.revision={lock["source"]["commit"]}',
            "--label", f"io.launchpad.runtime.patches={patch_hash}",
            "--tag", tag, "--file", str(collector_recipe), str(source / "packages"))
        images["build-collector"] = {"tag": tag, "id": capture("docker", "image", "inspect", tag, "--format", "{{.Id}}")}

    artifacts = output / "artifacts"
    artifacts.mkdir()
    container = capture("docker", "create", images["orchestrator"]["id"])
    try:
        run("docker", "cp", f"{container}:/usr/local/bin/orchestrator", str(artifacts / "orchestrator"))
        cold_probe_enabled = (source / "packages/orchestrator/pkg/sandbox/rootfs/cold_probe_linux.go").is_file()
        if cold_probe_enabled:
            run("docker", "cp", f"{container}:/opt/launchpad-probe", str(artifacts / "launchpad-probe"))
    finally:
        run("docker", "rm", container)
    (artifacts / "orchestrator").chmod(0o755)
    if collector_enabled:
        container = capture("docker", "create", images["build-collector"]["id"])
        try:
            run("docker", "cp", f"{container}:/launchpad-build-collector", str(artifacts / "launchpad-build-collector"))
        finally:
            run("docker", "rm", container)
        (artifacts / "launchpad-build-collector").chmod(0o755)

    # Preserve Embed's host namespace launcher and its sandbox shutdown handling.
    # Replacing this service with the orchestrator image bypasses that handling.
    command = shlex.join(["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-C", "-w/", "--",
                          "/usr/bin/env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                          str(artifacts / "orchestrator")])
    services = {
        "api": {"image": images["api"]["id"], "pull_policy": "never"},
        "db-migrator": {"image": images["db-migrator"]["id"], "pull_policy": "never"},
        "client-proxy": {"image": images["client-proxy"]["id"], "pull_policy": "never"},
        "orchestrator": {"environment": {
            "OL_COMMAND": command.replace("$", "$$"),
            "TEMPLATE_STORAGE_URL": (output / "state/templates").as_uri().replace("$", "$$"),
            "BUILD_CACHE_STORAGE_URL": (output / "state/build-cache").as_uri().replace("$", "$$"),
            "ORCHESTRATOR_BASE_PATH": str(output / "state/orchestrator").replace("$", "$$"),
            "SANDBOX_DIR": str(output / "state/sandboxes").replace("$", "$$"),
        }},
    }
    if cold_probe_enabled:
        services["orchestrator"]["environment"].update({
            "RESTORE_COLD_PROBE_SCRIPT": str(artifacts / "launchpad-probe/quarantine-probe.py").replace("$", "$$"),
            "RESTORE_COLD_PROBE_BUILD": str(artifacts / "launchpad-probe/build").replace("$", "$$"),
        })
    pins = lock["embed"]["images"]
    for service in ["postgres", "redis", "clickhouse", "vector"]:
        pin = pins[service]
        services[service] = {"image": f'{pin["tag"]}@{pin["digest"]}'}
    # Disk-full diagnostics must not consume every byte recovered by an operator.
    for service in services.values():
        service["logging"] = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}
    # Compose volumes must follow the same build directory as the disk artifacts.
    project_name = f"launchpad-e2b-proof-{hashlib.sha256(str(output).encode()).hexdigest()[:16]}"
    (output / "runtime.override.json").write_text(json.dumps({"name": project_name, "services": services}, indent=2) + "\n")
    shutil.copyfile(embed / "compose.yaml", output / "compose.yaml")
    # Only upstream public defaults; installation secrets are generated by Embed.
    defaults = (embed / ".env").read_text()
    for pin in pins.values():
        defaults = defaults.replace(pin["tag"], f'{pin["tag"]}@{pin["digest"]}')
    (output / ".env").write_text(defaults)
    shutil.copyfile(lock_path, output / "runtime.lock.json")
    receipt = {"sourceCommit": lock["source"]["commit"], "sourceArchiveSha256": sha256(archive),
               "lockSha256": sha256(lock_path), "platform": f"linux/{arch}",
               "composeOverrideSha256": sha256(output / "compose.override.yaml"),
               "keeperSha256": sha256(output / "e2b-keepalive.ts"),
               "patches": patches, "patchSetSha256": patch_hash,
               "dockerVersion": docker_version, "buildxVersion": buildx_version,
               "expectedMigration": migration, "images": images, "composeProject": project_name,
               "orchestratorSha256": sha256(artifacts / "orchestrator")}
    if collector_enabled:
        receipt["buildCollectorSha256"] = sha256(artifacts / "launchpad-build-collector")
    if cold_probe_enabled:
        receipt["coldProbeSha256"] = {
            name: sha256(artifacts / "launchpad-probe" / name)
            for name in ("quarantine-probe.py", "runtime.lock.json", "quarantine/init_linux.go",
                         "build/init", "build/init_linux.go", "build/build.json")
        }
    (output / "build.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"Built runtime: {output / 'build.json'}\nNo services started. Keep this directory for the host launcher.")


if __name__ == "__main__":
    main()
