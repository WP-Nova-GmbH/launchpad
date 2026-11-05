"""Read selected checkout files as the workflow user. Stdout is a private binary pipe."""

import os
import stat
import struct
import sys


MAX_MANIFEST = 32 * 1024 * 1024
MAX_EXCLUDE = 64 * 1024
MAX_PATH = 4096
FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
DIRECTORY_FLAGS = FLAGS | os.O_DIRECTORY
COMPLETE, FILE, EXECUTABLE, SYMLINK, MISSING, DIRECTORY = range(6)


def paths_from_manifest(data):
    if len(data) > MAX_MANIFEST or (data and not data.endswith(b"\0")):
        raise ValueError("Invalid manifest")
    root = {}
    for path in data.split(b"\0")[:-1]:
        if len(path) > MAX_PATH:
            raise ValueError("Path too long")
        tree = root
        for name in path.split(b"/"):
            if not name or name in (b".", b"..") or name.lower() == b".git":
                raise ValueError("Invalid path")
            tree = tree.setdefault(name, {})
    return root


def entry_info(directory, name):
    try:
        return os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None


def checked_open(directory, name, before, flags, owner):
    fd = os.open(name, flags, dir_fd=directory)
    actual = os.fstat(fd)
    if (actual.st_dev, actual.st_ino, actual.st_uid, stat.S_IFMT(actual.st_mode)) != (
        before.st_dev, before.st_ino, owner, stat.S_IFMT(before.st_mode)
    ):
        os.close(fd)
        raise ValueError("Checkout entry changed")
    return fd


def transfer_file(fd, info, out):
    remaining = info.st_size
    while remaining:
        chunk = os.read(fd, min(remaining, 64 * 1024))
        if not chunk:
            raise ValueError("Truncated checkout file")
        out.write(chunk)
        remaining -= len(chunk)
    after = os.fstat(fd)
    if (after.st_size, after.st_ctime_ns) != (info.st_size, info.st_ctime_ns):
        raise ValueError("Checkout file changed")


def frame(out, kind, path=b"", size=0):
    out.write(struct.pack(">BIQ", kind, len(path), size))
    out.write(path)


def stream_entries(directory, tree, owner, out, prefix=b""):
    for name, children in tree.items():
        path = prefix + name
        info = entry_info(directory, name)
        if info is None:
            frame(out, MISSING, path)
        elif info.st_uid != owner:
            raise ValueError("Invalid checkout entry owner")
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(name, dir_fd=directory)
            frame(out, SYMLINK, path, len(target))
            out.write(target)
        elif stat.S_ISDIR(info.st_mode):
            if not children:
                frame(out, MISSING, path)
                continue
            fd = checked_open(directory, name, info, DIRECTORY_FLAGS, owner)
            try:
                frame(out, DIRECTORY, path)
                stream_entries(fd, children, owner, out, path + b"/")
            finally:
                os.close(fd)
        elif stat.S_ISREG(info.st_mode):
            fd = checked_open(directory, name, info, FLAGS, owner)
            try:
                actual = os.fstat(fd)
                frame(out, EXECUTABLE if actual.st_mode & stat.S_IXUSR else FILE, path, actual.st_size)
                transfer_file(fd, actual, out)
            finally:
                os.close(fd)
        else:
            raise ValueError("Unsupported checkout entry")


def stream_exclude(root, owner, out):
    opened = []
    try:
        directory = root
        for name, optional in [(b".git", False), (b"info", True), (b"exclude", True)]:
            info = entry_info(directory, name)
            if info is None and optional:
                return
            if info is None or info.st_uid != owner:
                raise ValueError("Invalid ignore rules path")
            if name == b"exclude":
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_EXCLUDE:
                    raise ValueError("Invalid ignore rules file")
                fd = checked_open(directory, name, info, FLAGS, owner)
                opened.append(fd)
                actual = os.fstat(fd)
                if (actual.st_size, actual.st_ctime_ns, actual.st_nlink) != (
                    info.st_size, info.st_ctime_ns, info.st_nlink
                ):
                    raise ValueError("Ignore rules changed")
                transfer_file(fd, actual, out)
                return
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("Invalid ignore rules directory")
            directory = checked_open(directory, name, info, DIRECTORY_FLAGS, owner)
            opened.append(directory)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def main(mode, source, out):
    root = os.open(b".", DIRECTORY_FLAGS)
    try:
        owner = os.getuid()
        if os.fstat(root).st_uid != owner:
            raise ValueError("Invalid checkout owner")
        if mode == "capture":
            tree = paths_from_manifest(source.read(MAX_MANIFEST + 1))
            stream_entries(root, tree, owner, out)
            frame(out, COMPLETE)
        elif mode == "exclude":
            stream_exclude(root, owner, out)
        else:
            raise ValueError("Unknown checkpoint read")
        out.flush()
    finally:
        os.close(root)


if __name__ == "__main__":
    try:
        main(sys.argv[1], sys.stdin.buffer, sys.stdout.buffer)
    except (IndexError, OSError, RecursionError, ValueError):
        sys.exit(74)
