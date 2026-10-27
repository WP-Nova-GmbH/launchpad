"""Disposable workload: retain committed WAL and dirty files, discard an open transaction."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = Path('/home/user/launchpad-busy-proof')
COMMITTED = 'committed-before-snapshot'
UNCOMMITTED = 'must-not-survive-cold-restore'
DIRTY = b'page-cache-data-without-explicit-fsync\n' * 8192


def verify():
    with sqlite3.connect(ROOT / 'work.sqlite') as db:
        assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
        rows = db.execute('select value from proof order by rowid').fetchall()
        assert rows == [(COMMITTED,)], 'Committed WAL missing or unfinished transaction committed'
    assert (ROOT / 'dirty.bin').read_bytes() == DIRTY, 'Dirty file contents were lost'
    return {'committedWalRetained': True, 'uncommittedTransactionAbsent': True, 'dirtyFileRetained': True}


def serve():
    ROOT.mkdir(mode=0o700)
    db = sqlite3.connect(ROOT / 'work.sqlite')
    assert db.execute('pragma journal_mode=WAL').fetchone()[0] == 'wal'
    db.execute('pragma synchronous=FULL')
    db.execute('pragma wal_autocheckpoint=0')
    db.execute('create table proof(value text not null)')
    db.commit()
    db.execute('insert into proof values (?)', (COMMITTED,))
    db.commit()
    # Keep an actual write transaction and its connection open across snapshotting.
    db.execute('begin immediate')
    db.execute('insert into proof values (?)', (UNCOMMITTED,))
    assert db.in_transaction
    dirty = (ROOT / 'dirty.bin').open('wb')
    dirty.write(DIRTY)
    dirty.flush()  # Intentionally no fsync and no guest-wide sync.
    assert (ROOT / 'work.sqlite-wal').stat().st_size > 32

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/proof':
                self.send_error(404)
                return
            assert db.in_transaction
            payload = json.dumps({**verify(), 'writerTransactionOpen': True, 'pid': os.getpid()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = HTTPServer(('127.0.0.1', 3765), Handler)
    print(json.dumps({'ready': True, 'port': 3765}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        dirty.close()
        db.rollback()
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['serve', 'verify'])
    args = parser.parse_args()
    if args.action == 'serve':
        serve()
    else:
        print(json.dumps(verify()))
