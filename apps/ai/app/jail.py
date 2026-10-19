"""Starts a program with no secrets and bounded resources, for ffmpeg reading a member's
footage (app/clipping.py) and takes (app/aligning.py):

    python app/jail.py ffmpeg -i ...

This process is the service's, with its whole environment; it lowers its own limits and
priority, then becomes the program (exec, the same process) with an environment of PATH
alone, so nothing ffmpeg runs or is tricked into can read the database URL, the
service's keys or the caller secret. The limits hold whatever the input makes it do:
CPU time (the caller's wall clock timeout kills it sooner when it's merely slow), the
size of any file it writes, no core dumps, and on Linux its address space.

It is not a sandbox: ffmpeg still runs as the service's user, with its files and network.
In production clips are cut only in the Cloud Run clipper (app/clipper.py), whose
container holds no secrets or data at all; this keeps a local or development clipper
honest. Match cuts are lined up in this service until a Cloud Run aligner is deployed
(ALIGNER_URL), so there it's what keeps the service's secrets from a member's take.
"""

import os
import resource
import shutil
import sys

# Ten minutes of CPU, across ffmpeg's threads: decoding a 25-minute part to reach its last
# attempt and encoding a one-minute take need well under half of it.
CPU_SECONDS = 600
# The largest file it may write: the take, at most 15 MB (app/clipping.py's MAX_CLIP_BYTES).
FILE_BYTES = 64 * 1024 * 1024
# Its address space, where the limit exists (Linux; macOS refuses to set one): a 1080p
# decode and a 720p encode on two threads fit in a few hundred megabytes.
ADDRESS_BYTES = 2 * 1024 * 1024 * 1024
# Behind the service's own work for the CPU.
NICENESS = 10
# What the shell answers for a program that can't be started: the caller's cue that this
# machine is at fault, not the footage.
CANNOT_START = 127

LIMITS = [
    (resource.RLIMIT_CPU, CPU_SECONDS),
    (resource.RLIMIT_FSIZE, FILE_BYTES),
    (resource.RLIMIT_CORE, 0),
    *([(resource.RLIMIT_AS, ADDRESS_BYTES)] if sys.platform == "linux" else []),
]


def _lower(limit: int, value: int) -> None:
    """Lowers a limit to `value`, or to the hard limit already in place if that's lower,
    for good: the program can't raise it back."""
    _, hard = resource.getrlimit(limit)
    capped = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(limit, (capped, capped))


def main(argv: list[str]) -> None:
    for limit, value in LIMITS:
        _lower(limit, value)
    _ = os.nice(NICENESS)
    # PATH alone, to find the program: it's no secret, and it's where ffmpeg is here.
    path = os.environ.get("PATH", os.defpath)
    program = shutil.which(argv[0], path=path)
    if program is None:
        _ = sys.stderr.write(f"jail: can't start {argv[0]}: not found\n")
        sys.exit(CANNOT_START)
    # Becoming the program, not starting a child: the caller's timeout kills it, and
    # nothing is left behind. Its arguments are argv entries, never a shell's line.
    os.execve(program, argv, {"PATH": path})  # noqa: S606


if __name__ == "__main__":
    main(sys.argv[1:])
