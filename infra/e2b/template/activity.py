#!/usr/bin/env python3
"""Read one VM's durable work state without starting the server or exposing message contents."""
import json
import sqlite3
import subprocess
from pathlib import Path

DB_PATH = Path("/home/user/.launchpad/userdata/state.sqlite")


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


def projection_activity(db_path=DB_PATH):
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
              LIMIT 1""", (thread_id, thread_id, generation)).fetchone()
        # These records are only candidates: the relay accepts them as inactive
        # after an empty, current-boot workload inventory and settled projection.
        process_work = db.execute("""SELECT work_id FROM thread_execution_work WHERE thread_id=? AND generation=?
            AND kind IN ('provider','terminal','setup') AND started=1 AND completed=0 ORDER BY work_id""", (thread_id, generation)).fetchall()
        queue = redacted_queue(row[0]) if row else {"enabled": True, "entries": [], "handoff": None, "awaitingTurnId": None}
        return {"threadId": thread_id, "environmentId": environment_id, "generation": generation,
                "phase": phase, "archived": thread[0] is not None, "unfinished": unfinished is not None, "processWorkIds": [row[0] for row in process_work], "queue": queue}
    finally:
        db.close()


def main():
    inventory = subprocess.run(["/usr/local/bin/launchpad-workload", "inspect"], check=True, capture_output=True, text=True, timeout=5)
    print(json.dumps({"workloads": json.loads(inventory.stdout), "projection": projection_activity()}, separators=(",", ":")))


if __name__ == "__main__":
    main()
