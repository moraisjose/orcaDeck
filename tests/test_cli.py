#!/usr/bin/env python3
"""Light coverage for bin/orcadeck — stdlib unittest only.

The CLI script has no .py extension, so it is loaded via SourceFileLoader.
shutil.which and subprocess.run are patched so nothing real ever executes.
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
ORCADECK = REPO_ROOT / "bin" / "orcadeck"

_loader = importlib.machinery.SourceFileLoader("orcadeck_cli", str(ORCADECK))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
orcadeck = importlib.util.module_from_spec(_spec)
_loader.exec_module(orcadeck)


def run_cli(argv):
    """Invoke orcadeck.main() with argv, capturing stdout/stderr."""
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["orcadeck"] + argv):
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = orcadeck.main()
    return code, out.getvalue(), err.getvalue()


class OrcadeckCliTests(unittest.TestCase):
    def test_no_args_prints_usage_and_exits_0(self):
        code, out, _ = run_cli([])
        self.assertEqual(code, 0)
        self.assertIn("Usage: orcadeck", out)

    def test_help_prints_usage_and_exits_0(self):
        for flag in ("-h", "--help"):
            code, out, _ = run_cli([flag])
            self.assertEqual(code, 0, flag)
            self.assertIn("Usage: orcadeck", out)

    def test_unknown_command_exits_1(self):
        code, _, err = run_cli(["frobnicate"])
        self.assertEqual(code, 1)
        self.assertIn("unknown command 'frobnicate'", err)
        self.assertIn("Usage: orcadeck", err)

    def test_serve_without_orca_on_path_exits_1(self):
        with mock.patch("shutil.which", return_value=None):
            code, _, err = run_cli(["serve"])
        self.assertEqual(code, 1)
        self.assertIn("`orca` is not on PATH", err)

    def test_serve_execs_orcad_with_args(self):
        proc = mock.Mock(returncode=0)
        with mock.patch("shutil.which", return_value="/usr/local/bin/orca"):
            with mock.patch("subprocess.run", return_value=proc) as run:
                code, _, _ = run_cli(["serve", "--port", "9000"])

        self.assertEqual(code, 0)
        run.assert_called_once()
        args, kwargs = run.call_args
        self.assertEqual(
            args[0], [sys.executable, str(orcadeck.ORCAD), "--port", "9000"]
        )
        self.assertEqual(kwargs["env"]["PYTHONUNBUFFERED"], "1")

    def test_serve_propagates_orcad_exit_code(self):
        proc = mock.Mock(returncode=3)
        with mock.patch("shutil.which", return_value="/usr/local/bin/orca"):
            with mock.patch("subprocess.run", return_value=proc):
                code, _, _ = run_cli(["serve"])
        self.assertEqual(code, 3)


if __name__ == "__main__":
    unittest.main()
