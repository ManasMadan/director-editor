"""BullMQ's Node and Python packages must bundle the same Lua scripts: both sides change
the same queues in Redis with them (see app/queues.py). Upgrading one without the other
fails here, before it can reach a queue."""

import re
from importlib.resources import files
from pathlib import Path

NODE_SCRIPTS = Path(__file__).resolve().parents[3] / "node_modules/bullmq/dist/esm/scripts"
PYTHON_SCRIPTS = files("bullmq") / "commands"
# Node bundles each script as `const content = `...`;` with its includes inlined.
_CONTENT = re.compile(r"const content = `(.*?)`;\n", re.DOTALL)


def _lines(script: str) -> list[str]:
    """The script without blank lines or trailing spaces, which the two packages format
    differently."""
    return [line.rstrip() for line in script.splitlines() if line.strip()]


def _node() -> dict[str, list[str]]:
    scripts: dict[str, list[str]] = {}
    for path in NODE_SCRIPTS.glob("*.js"):
        match = _CONTENT.search(path.read_text())
        if match:
            scripts[path.stem] = _lines(match.group(1))
    return scripts


def test_both_packages_run_the_same_lua_scripts() -> None:
    assert NODE_SCRIPTS.is_dir(), "run `bun install`: the Node package is compared too"
    node = _node()
    python = {
        entry.name.removesuffix(".lua"): _lines(entry.read_text())
        for entry in PYTHON_SCRIPTS.iterdir()
        if entry.name.endswith(".lua")
    }
    assert python, "the Python package bundles no scripts"
    assert set(python) == set(node)
    different = sorted(name for name in python if python[name] != node[name])
    assert different == [], f"upgrade BullMQ in both languages together: {different}"
