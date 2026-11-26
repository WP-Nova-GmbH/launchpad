#!/usr/bin/python3 -IS
"""Read one VM's durable work state without starting the server or exposing message contents."""
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

DB_PATH = Path("/home/user/.launchpad/userdata/state.sqlite")
BACKGROUND_RECEIPT_PATH = DB_PATH.with_name("workflow-vm-background.json")


def background_activity(workloads, receipt_path=BACKGROUND_RECEIPT_PATH, proc_path=Path("/proc")):
    live_codex = workloads.get("codexOnly") is True
    try:
        receipt = json.loads(receipt_path.read_text())
        if (receipt["bootId"] != workloads["bootId"] or
                not re.fullmatch(r"[0-9a-f]{32}", receipt["revision"]) or
                type(receipt["busy"]) is not bool):
            raise ValueError("Invalid workflow background receipt")
        revision = receipt["revision"]
        if not live_codex:
            return {"backgroundRevision": revision + ":stopped" if receipt["busy"] else revision}
        pid = receipt["coordinatorPid"]
        if (type(pid) is not int or pid <= 1 or len(workloads["groups"]) != 1 or
                receipt["groupId"] != workloads["groups"][0]["id"]):
            raise ValueError("Workflow background receipt has a different owner")
        stat = (proc_path / str(pid) / "stat").read_text()
        if stat[stat.rindex(") ") + 2:].split()[19] != receipt["coordinatorStartTicks"]:
            raise ValueError("Workflow coordinator has changed")
        return {"backgroundBusy": receipt["busy"], "backgroundRevision": revision}
    except (FileNotFoundError, ProcessLookupError, ValueError, TypeError, KeyError, IndexError):
        return {"backgroundBusy": True} if live_codex else {}


def redacted_queue(raw):
    queue = json.loads(raw)
    if not isinstance(queue, dict) or not isinstance(queue.get("enabled"), bool):
        raise ValueError("Invalid queue")
    entries = queue.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Invalid queue entries")
    redacted = []
    for entry in entries:
        states = ("pending", "moving", "blocked", "cancelling") if entry.get("kind") == "move" else ("pending", "delivering", "unknown")
        if entry.get("kind", "prompt") not in ("prompt", "move") or entry.get("state") not in states:
            raise ValueError("Invalid queue entry")
        redacted.append({"state": entry["state"]})
    for key in ("handoff", "awaitingTurnId"):
        if key not in queue:
            raise ValueError("Incomplete queue")
    result = {"enabled": queue["enabled"], "entries": redacted,
              "handoff": True if queue["handoff"] is not None else None,
              "awaitingTurnId": True if queue["awaitingTurnId"] is not None else None}
    if "preparation" in queue:
        prep = queue["preparation"]
        if prep["state"] not in ("pending", "running", "ready", "failed") or not isinstance(prep["settled"], bool):
            raise ValueError("Invalid preparation")
        result["preparation"] = {"state": prep["state"], "settled": prep["settled"]}
    return result


def verify_cancelled_workloads(db, owner, workloads):
    thread_id, environment_id, generation, phase, project_id, operation_id = owner
    if (phase != "active" or workloads.get("stopped") is not True or workloads.get("groups") != [] or
            not workloads.get("sealedBy") or type(workloads.get("epoch")) is not int or workloads["epoch"] < 1):
        raise ValueError("Cancelled VM workloads are unconfirmed")
    row = db.execute("""SELECT j.job_id,j.record_json,p.provider_instance_id,p.runtime_payload_json
        FROM repository_workflow_jobs j JOIN provider_session_runtime p USING(thread_id)
        WHERE j.thread_id=? AND j.status='cancelled' AND j.execution_reserved=0
          AND p.status='stopped' AND p.provider_name='codex'""", (thread_id,)).fetchone()
    if row is None:
        raise ValueError("Cancelled VM runtime is unconfirmed")
    job_id, run_json, instance_id, provider_json = row
    run, provider = json.loads(run_json), json.loads(provider_json)
    runtime, progress = run["runtime"], run["progress"]
    # Match the guest run's ownership-release predicate before accepting its stop proof.
    pending_controls = ("manualPause", "approvalAttempt", "cancellationAttempt",
                        "pendingQueueDismissal", "pendingPreparationRetry")
    if (run["jobId"] != job_id or run["executionReserved"] is not False or
            progress["status"] != "cancelled" or progress["threadId"] != thread_id or
            any(run.get(field) is not None for field in pending_controls) or
            any(command["stopped"] is not True for action in run.get("actions", []) for command in action["commands"])):
        raise ValueError("Cancelled VM execution is still reserved")
    proof, continuation = provider["workflowVmCancellation"], provider["providerContinuation"]
    identity = {"jobId": job_id, "threadId": thread_id, "environmentId": environment_id,
                "generation": generation, "operationId": operation_id}
    if (runtime["kind"] != "vm" or runtime["projectId"] != project_id or
            type(generation) is not int or generation < 1 or
            type(runtime["generation"]) is not int or type(proof["generation"]) is not int or
            any(runtime[key] != value or proof[key] != value for key, value in identity.items()) or
            proof["allocationId"] != runtime["allocationId"] or
            not all(isinstance(value, str) and value for value in (
                job_id, thread_id, environment_id, project_id, operation_id, proof["allocationId"],
            ))):
        raise ValueError("Cancelled VM stop proof does not match its current owner")
    if (proof["providerInstanceId"] != instance_id or
            run["providerContinuation"]["driver"] != "codex" or
            run["providerContinuation"]["continuationKey"] != proof["continuationKey"] or
            continuation["workflowJobId"] != job_id or continuation["runtimeEpisode"] != proof["runtimeEpisode"] or
            continuation["continuationKey"] != proof["continuationKey"] or
            continuation["shutdownConfirmed"] is not True or type(continuation["shutdownEvidenceVersion"]) is not int or
            continuation["shutdownEvidenceVersion"] != 2 or
            provider["stoppedRuntimeEventsDrained"] is not True or
            not all(isinstance(value, str) and value for value in (
                instance_id, proof["runtimeEpisode"], proof["continuationKey"],
            ))):
        raise ValueError("Cancelled VM provider shutdown is unconfirmed")
    if (not isinstance(proof["bootId"], str) or not proof["bootId"] or proof["bootId"] != workloads["bootId"] or
            type(proof["epoch"]) is not int or proof["epoch"] != workloads["epoch"] or
            not isinstance(proof["cancellationId"], str) or not proof["cancellationId"]):
        raise ValueError("Cancelled VM stop proof does not match its current boot")
    stop_operation = f"workflow:{job_id}:cancel:{proof['cancellationId']}"
    if workloads["sealedBy"] != hashlib.sha256(stop_operation.encode()).hexdigest()[:32]:
        raise ValueError("Cancelled VM seal does not match its stop proof")


def projection_activity(db_path=DB_PATH, *, codex_only=False, cancelled_workloads=None):
    # mode=ro keeps WAL visibility; immutable mode would miss recently acknowledged queue writes.
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        db.execute("BEGIN")
        owners = db.execute("SELECT thread_id,environment_id,generation,phase,project_id,operation_id FROM thread_execution_fences LIMIT 2").fetchall()
        if len(owners) != 1:
            raise ValueError("One current VM owner is required")
        thread_id, environment_id, generation, phase, _, _ = owners[0]
        cancelled_stopped = cancelled_workloads is not None
        if cancelled_stopped:
            verify_cancelled_workloads(db, owners[0], cancelled_workloads)
        thread = db.execute("SELECT archived_at FROM projection_threads WHERE thread_id=? AND deleted_at IS NULL", (thread_id,)).fetchone()
        if thread is None:
            raise ValueError("VM thread projection is unavailable")
        row = db.execute("SELECT state_json FROM projection_thread_prompt_queues WHERE thread_id=?", (thread_id,)).fetchone()
        unfinished = db.execute("""SELECT 1 FROM projection_turns WHERE thread_id=?
            AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
            UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=? AND (completed=0 OR relay_completed=0)
              AND NOT (generation=? AND kind IN ('provider','terminal','setup') AND (started=1 OR ?) AND completed=0)
              LIMIT 1""", (thread_id, thread_id, generation, cancelled_stopped)).fetchone() is not None
        if codex_only and not unfinished:
            waiting = db.execute("""SELECT 1 FROM projection_thread_sessions s
                JOIN projection_threads t ON t.thread_id=s.thread_id
                WHERE s.thread_id=? AND s.provider_name='codex' AND s.status IN ('ready','error')
                  AND s.active_turn_id IS NULL AND t.pending_approval_count=0
                  AND t.pending_user_input_count=0""", (thread_id,)).fetchone()
            unfinished = waiting is None
        # An empty, cancellation-sealed VM can reconcile a process reservation
        # even if the relay's admission reply was lost before it could start.
        process_work = db.execute("""SELECT work_id FROM thread_execution_work WHERE thread_id=? AND generation=?
            AND kind IN ('provider','terminal','setup') AND (started=1 OR ?) AND completed=0 ORDER BY work_id""",
            (thread_id, generation, cancelled_stopped)).fetchall()
        queue = redacted_queue(row[0]) if row else {"enabled": True, "entries": [], "handoff": None, "awaitingTurnId": None}
        return {"threadId": thread_id, "environmentId": environment_id, "generation": generation,
                "phase": phase, "archived": thread[0] is not None, "unfinished": unfinished,
                "processWorkIds": [row[0] for row in process_work], "queue": queue,
                **({"cancelledStopped": True} if cancelled_stopped else {})}
    finally:
        db.close()


def inspect_workloads(action):
    inventory = subprocess.run(["/opt/launchpad/bin/launchpad-workload", action], check=True, capture_output=True, text=True, timeout=5)
    return json.loads(inventory.stdout)


def read_activity(workflow, db_path=DB_PATH):
    try:
        workloads = inspect_workloads("workflow-activity-state" if workflow else "inspect")
    except subprocess.CalledProcessError:
        if not workflow:
            raise
        # The normal workflow report rejects sealed gates. Cancellation keeps its
        # seal until recovery takes ownership, so verify the persisted stop instead.
        workloads = inspect_workloads("inspect")
        projection = projection_activity(db_path, cancelled_workloads=workloads)
    else:
        projection = projection_activity(db_path, codex_only=workloads.get("codexOnly") is True)
        if workflow:
            projection.update(background_activity(workloads))
    return {"workloads": workloads, "projection": projection}


def main():
    args = sys.argv[1:]
    if args not in ([], ["--workflow"]):
        raise ValueError("Invalid activity scope")
    print(json.dumps(read_activity(bool(args)), separators=(",", ":")))


if __name__ == "__main__":
    main()
