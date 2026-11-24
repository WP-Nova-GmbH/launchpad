#!/usr/bin/python3 -IS
"""Read one VM's durable work state without starting the server or exposing message contents."""
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


def projection_activity(db_path=DB_PATH, *, codex_only=False):
    # mode=ro keeps WAL visibility; immutable mode would miss recently acknowledged queue writes.
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        db.execute("BEGIN")
        owners = db.execute("SELECT thread_id,environment_id,generation,phase FROM thread_execution_fences LIMIT 2").fetchall()
        if len(owners) != 1:
            raise ValueError("One current VM owner is required")
        thread_id, environment_id, generation, phase = owners[0]
        thread = db.execute("SELECT archived_at FROM projection_threads WHERE thread_id=? AND deleted_at IS NULL", (thread_id,)).fetchone()
        if thread is None:
            raise ValueError("VM thread projection is unavailable")
        row = db.execute("SELECT state_json FROM projection_thread_prompt_queues WHERE thread_id=?", (thread_id,)).fetchone()
        unfinished = db.execute("""SELECT 1 FROM projection_turns WHERE thread_id=?
            AND (completed_at IS NULL OR state IN ('pending','running') OR checkpoint_status='pending')
            UNION ALL SELECT 1 FROM thread_execution_work WHERE thread_id=? AND (completed=0 OR relay_completed=0)
              AND NOT (generation=? AND kind IN ('provider','terminal','setup') AND started=1 AND completed=0)
              LIMIT 1""", (thread_id, thread_id, generation)).fetchone() is not None
        if codex_only and not unfinished:
            waiting = db.execute("""SELECT 1 FROM projection_thread_sessions s
                JOIN projection_threads t ON t.thread_id=s.thread_id
                WHERE s.thread_id=? AND s.provider_name='codex' AND s.status IN ('ready','error')
                  AND s.active_turn_id IS NULL AND t.pending_approval_count=0
                  AND t.pending_user_input_count=0""", (thread_id,)).fetchone()
            unfinished = waiting is None
        # The relay matches these against its own admissions when observing idleness.
        process_work = db.execute("""SELECT work_id FROM thread_execution_work WHERE thread_id=? AND generation=?
            AND kind IN ('provider','terminal','setup') AND started=1 AND completed=0 ORDER BY work_id""", (thread_id, generation)).fetchall()
        queue = redacted_queue(row[0]) if row else {"enabled": True, "entries": [], "handoff": None, "awaitingTurnId": None}
        return {"threadId": thread_id, "environmentId": environment_id, "generation": generation,
                "phase": phase, "archived": thread[0] is not None, "unfinished": unfinished, "processWorkIds": [row[0] for row in process_work], "queue": queue}
    finally:
        db.close()


def main():
    args = sys.argv[1:]
    if args not in ([], ["--workflow"]):
        raise ValueError("Invalid activity scope")
    action = "workflow-activity-state" if args else "inspect"
    inventory = subprocess.run(["/opt/launchpad/bin/launchpad-workload", action], check=True, capture_output=True, text=True, timeout=5)
    workloads = json.loads(inventory.stdout)
    projection = projection_activity(codex_only=workloads.get("codexOnly") is True)
    if args:
        projection.update(background_activity(workloads))
    print(json.dumps({"workloads": workloads, "projection": projection}, separators=(",", ":")))


if __name__ == "__main__":
    main()
