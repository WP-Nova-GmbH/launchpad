#!/usr/bin/env python3
"""Configure one new stock E2B project's runner disk and lifetime before its API starts."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid


SOURCE_COMMIT = "518278060a154124a80d98f37253f8af77baf478"
RUNNER_DISK_MB = 32768
DEFAULT_MAX_LENGTH_HOURS = 720
MAX_LENGTH_HOURS = 8760
COMPOSE_FILES = ("compose.yaml", "runtime.override.json", "compose.override.yaml")
LIMIT_COLUMNS = (
    "max_length_hours", "concurrent_sandboxes", "concurrent_template_builds",
    "max_vcpu", "max_ram_mb", "disk_mb", "events_ttl_days",
    "default_free_disk_size_mb", "max_disk_size_mb", "max_free_disk_size_mb",
    "api_team_rps_list", "api_team_rps_delete", "max_secrets",
)


def project_limits_sql(project_id, max_length_hours=DEFAULT_MAX_LENGTH_HOURS):
    project_id = str(uuid.UUID(project_id))
    if project_id == str(uuid.UUID(int=0)):
        raise ValueError("Choose one nonzero E2B project UUID")
    # Native code converts hours to Go's nanosecond time.Duration. A one-year
    # ceiling keeps that conversion bounded and makes the operational cap clear.
    if type(max_length_hours) is not int or not 1 <= max_length_hours <= MAX_LENGTH_HOURS:
        raise ValueError(f"Maximum VM lifetime must be an integer from 1 to {MAX_LENGTH_HOURS} hours")
    values = [str(RUNNER_DISK_MB) if column == "disk_mb" else
              str(max_length_hours) if column == "max_length_hours" else
              "d.max_disk_size_mb" if column == "max_free_disk_size_mb" else
              "d." + column for column in LIMIT_COLUMNS]
    return f"""BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $configure$
BEGIN
    IF (SELECT count(*) FROM public.default_limits) <> 1 THEN
        RAISE EXCEPTION 'stock-project: expected exactly one default limits row';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = '{project_id}'::uuid) THEN
        RAISE EXCEPTION 'stock-project: the selected project does not exist';
    END IF;
    IF EXISTS (SELECT 1 FROM public.envs WHERE team_id = '{project_id}'::uuid) THEN
        RAISE EXCEPTION 'stock-project: configure a new project before building templates';
    END IF;
END;
$configure$;
INSERT INTO public.project_limits (team_id,{','.join(LIMIT_COLUMNS)})
SELECT '{project_id}'::uuid,{','.join(values)} FROM public.default_limits d
ON CONFLICT (team_id) DO UPDATE SET disk_mb = EXCLUDED.disk_mb,
                                  max_length_hours = EXCLUDED.max_length_hours;
SELECT json_build_object('projectId',team_id::text,'diskMb',disk_mb,
                         'maxLengthHours',max_length_hours)
FROM public.project_limits WHERE team_id = '{project_id}'::uuid;
COMMIT;
"""


def run(*args, input=None):
    # Resolve only this deployment's Compose files and .env, never caller overrides.
    env = {name: os.environ[name] for name in ("PATH", "HOME", "USER", "LOGNAME", "TMPDIR")
           if name in os.environ}
    result = subprocess.run(args, input=input, capture_output=True, text=True, env=env)
    if result.returncode:
        raise ValueError("Stock project configuration command failed; no other deployment was selected")
    return result.stdout


def configure(directory, project_id, max_length_hours=DEFAULT_MAX_LENGTH_HOURS):
    sql = project_limits_sql(project_id, max_length_hours)
    directory = Path(directory).resolve(strict=True)
    receipt = json.loads((directory / "build.json").read_text())
    if not isinstance(receipt, dict):
        raise ValueError("The stock build receipt must be a JSON object")
    project = receipt.get("composeProject", "")
    if (receipt.get("schemaVersion") != 1 or receipt.get("sourceCommit") != SOURCE_COMMIT
            or not isinstance(project, str) or not re.fullmatch(r"launchpad-e2b-stock-[a-f0-9]{16}", project)):
        raise ValueError("Choose the supported stock runtime's generated deployment directory")
    checksums = receipt.get("configurationSha256")
    if not isinstance(checksums, dict):
        raise ValueError("The stock build receipt needs its Compose checksums")
    for name in COMPOSE_FILES:
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != checksums.get(name):
            raise ValueError("Compose files differ from the selected stock build receipt")
    compose = ["docker", "compose", "--project-directory", str(directory), "--project-name", project,
               *[item for name in COMPOSE_FILES for item in ("--file", str(directory / name))]]
    ids = run(*compose, "ps", "--all", "--quiet", "postgres", "api", "dashboard-api").split()
    if not ids or any(not re.fullmatch(r"[a-f0-9]{64}", identity) for identity in ids):
        raise ValueError("Start this deployment's seed and PostgreSQL before configuring its project")
    containers = json.loads(run("docker", "inspect", *ids))
    if not isinstance(containers, list) or len(containers) != len(ids):
        raise ValueError("Cannot establish the selected deployment's service identities")
    postgres = []
    for container in containers:
        labels = container.get("Config", {}).get("Labels") or {}
        role = labels.get("com.docker.compose.service")
        if (container.get("Id") not in ids or labels.get("com.docker.compose.project") != project
                or role not in ("postgres", "api", "dashboard-api")):
            raise ValueError("A selected container does not belong to this stock deployment")
        running = container.get("State", {}).get("Running")
        if type(running) is not bool:
            raise ValueError("Cannot establish the selected deployment's service state")
        if role == "postgres" and running:
            postgres.append(container["Id"])
        elif role in ("api", "dashboard-api") and running:
            raise ValueError("Configure the new project before starting its API or dashboard API")
    if len(postgres) != 1:
        raise ValueError("The selected deployment needs exactly one running PostgreSQL service")
    output = run("docker", "exec", "--interactive", postgres[0], "psql", "-X", "--quiet", "--tuples-only",
                 "--no-align", "--no-password", "--set", "ON_ERROR_STOP=1", "--username", "postgres",
                 "--dbname", "postgres", input=sql)
    report = json.loads(output)
    if (not isinstance(report, dict) or report.get("projectId") != str(uuid.UUID(project_id)) or report.get("diskMb") != RUNNER_DISK_MB
            or type(report.get("maxLengthHours")) is not int or report["maxLengthHours"] != max_length_hours):
        raise ValueError("The selected project's limits could not be confirmed")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--project-id", required=True, help="Exact E2B project UUID; no all-projects mode")
    parser.add_argument("--max-length-hours", type=int, default=DEFAULT_MAX_LENGTH_HOURS,
                        help=f"Continuous VM lifetime cap, 1–{MAX_LENGTH_HOURS} hours (default: 720 / 30 days)")
    args = parser.parse_args()
    try:
        print(json.dumps(configure(args.runtime_dir, args.project_id, args.max_length_hours)))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"stock-project: {error}\n")


if __name__ == "__main__":
    main()
