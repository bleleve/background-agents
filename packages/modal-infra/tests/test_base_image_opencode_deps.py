"""Guard: the baked OpenCode plugin deps must stay a superset of what OpenCode loads.

At sandbox boot the supervisor symlinks ``<workdir>/.opencode/node_modules`` to the
read-only ``/app/opencode-deps/node_modules`` baked into the base image
(``entrypoint._materialize_node_modules``). That tree is read-only, so the only thing
that keeps boot safe is OpenCode's startup ``Npm.install()`` finding the lockfile in
sync and SKIPPING arborist reify — i.e. performing no writes.

If the baked dependency set ever drops something OpenCode resolves (e.g. langfuse
removed, or an OpenCode bump re-pins ``@opencode-ai/plugin``), reify would try to write
into the read-only symlink target → EROFS → hard boot failure. These guards fail loudly
in CI so that drift is caught before it ships, instead of silently degrading at boot.
"""

from pathlib import Path

BASE_PY = Path(__file__).resolve().parents[1] / "src" / "images" / "base.py"

# Declared in the package.json baked into /app/opencode-deps. Must remain a superset
# of what OpenCode loads at runtime (the plugins wired in entrypoint.start_opencode /
# _configure_langfuse) so reify stays a no-op against the read-only node_modules.
REQUIRED_BAKED_DEPS = ('"@opencode-ai/plugin":', '"opencode-plugin-langfuse":')


def _base_source() -> str:
    return BASE_PY.read_text(encoding="utf-8")


def test_opencode_plugin_deps_are_baked():
    """The plugin deps OpenCode loads must be declared in the baked package.json."""
    source = _base_source()
    for dep in REQUIRED_BAKED_DEPS:
        assert dep in source, (
            f"{dep} is no longer baked into /app/opencode-deps (base.py). The boot-time "
            "symlink makes .opencode/node_modules read-only, so a missing dep makes "
            "OpenCode reify into it → EROFS → hard boot failure. Re-add it to the "
            "/app/opencode-deps package.json dependencies."
        )


def test_baked_deps_lockfile_is_generated():
    """An `npm install` in /app/opencode-deps must run so the lockfile exists in sync."""
    source = _base_source()
    assert "/app/opencode-deps" in source
    assert "npm install" in source, (
        "The baked deps must be installed (generating package-lock.json) so OpenCode's "
        "startup Npm.install() finds the lockfile in sync and skips reify."
    )
