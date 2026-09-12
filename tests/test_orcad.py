#!/usr/bin/env python3
"""Tests for orcad/orcad.py — stdlib unittest only, no third-party deps.

All subprocess interaction is mocked: the suite never invokes a real `orca`
binary. The HTTP layer is exercised against a real ThreadingHTTPServer bound
to port 0 on loopback.
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from orcad import orcad  # noqa: E402  (namespace-package import needs the path above)
from orcad import auth, cli  # noqa: E402


class BuildTerminalIndexTests(unittest.TestCase):
    TERMINALS = [
        {"tabId": "t1", "leafId": "l1", "handle": "h1", "connected": True, "writable": False},
        {"tabId": "t1"},  # missing leafId -> skipped
        {"leafId": "l2"},  # missing tabId -> skipped
        {"tabId": "", "leafId": "l3"},  # empty tabId -> skipped
        {"tabId": "t2", "leafId": "l2", "handle": "h2", "connected": False, "writable": True},
    ]

    def test_bare_list(self):
        index = orcad.build_terminal_index(self.TERMINALS)
        self.assertEqual(set(index), {"t1:l1", "t2:l2"})
        self.assertEqual(
            index["t1:l1"], {"handle": "h1", "connected": True, "writable": False}
        )
        self.assertEqual(
            index["t2:l2"], {"handle": "h2", "connected": False, "writable": True}
        )

    def test_wrapped_dict(self):
        wrapped = orcad.build_terminal_index({"terminals": self.TERMINALS})
        self.assertEqual(wrapped, orcad.build_terminal_index(self.TERMINALS))

    def test_empty_and_garbage(self):
        self.assertEqual(orcad.build_terminal_index(None), {})
        self.assertEqual(orcad.build_terminal_index({}), {})
        self.assertEqual(orcad.build_terminal_index({"terminals": None}), {})


class NestAgentsTests(unittest.TestCase):
    TERM_INDEX = {"t:l1": {"handle": "h1", "connected": True, "writable": True}}

    def test_nesting_and_terminal_join(self):
        agents = [
            {"paneKey": "t:l1", "agentType": "claude", "state": "working"},
            {"paneKey": "t:l2", "parentPaneKey": "t:l1", "agentType": "codex"},
            {"paneKey": "t:l3", "parentPaneKey": "t:missing"},  # unknown parent -> top
            {"agentType": "no-pane-key"},  # dropped entirely
            {"paneKey": "t:l4"},  # plain top-level
        ]
        top = orcad._nest_agents(agents, self.TERM_INDEX)

        self.assertEqual([n["paneKey"] for n in top], ["t:l1", "t:l3", "t:l4"])

        parent = top[0]
        self.assertEqual(parent["terminalHandle"], "h1")
        self.assertIs(parent["connected"], True)
        self.assertIs(parent["writable"], True)
        self.assertEqual([c["paneKey"] for c in parent["children"]], ["t:l2"])

        child = parent["children"][0]
        self.assertIsNone(child["terminalHandle"])  # not present in the index
        self.assertIsNone(child["connected"])
        self.assertEqual(child["children"], [])

        # The agent without a paneKey appears nowhere in the tree.
        all_nodes = top + [c for n in top for c in n["children"]]
        self.assertNotIn("no-pane-key", [n["agentType"] for n in all_nodes])

    def test_self_parent_stays_top_level(self):
        agents = [{"paneKey": "t:l1", "parentPaneKey": "t:l1"}]
        top = orcad._nest_agents(agents, {})
        self.assertEqual([n["paneKey"] for n in top], ["t:l1"])
        self.assertEqual(top[0]["children"], [])

    def test_empty_input(self):
        self.assertEqual(orcad._nest_agents([], {}), [])


class ProjectStateTests(unittest.TestCase):
    def test_end_to_end_projection(self):
        ps = {
            "worktrees": [
                {
                    "worktreeId": "w1",
                    "repo": "orcaDeck",
                    "displayName": "rockling",
                    "branch": "main",
                    "path": "/tmp/w1",
                    "status": "open",
                    "workspaceStatus": "clean",
                    "isMainWorktree": True,
                    "isPinned": False,
                    "isActive": True,
                    "unread": 3,
                    "preview": "last line",
                    "lastActivityAt": "2026-09-12T00:00:00Z",
                    "lastOutputAt": "2026-09-12T00:01:00Z",
                    "linkedPR": {"number": 7},
                    "linkedIssue": None,
                    "linkedLinearIssue": None,
                    "linkedGitLabMR": None,
                    "linkedGitLabIssue": None,
                    "agents": [
                        {"paneKey": "t:l1", "agentType": "claude", "state": "working"},
                        {
                            "paneKey": "t:l2",
                            "parentPaneKey": "t:l1",
                            "agentType": "codex",
                            "state": "idle",
                        },
                    ],
                }
            ]
        }
        terminals = {
            "terminals": [
                {"tabId": "t", "leafId": "l1", "handle": "h1", "connected": True, "writable": True}
            ]
        }

        doc = orcad.project_state(ps, terminals)

        self.assertEqual(doc["schema"], orcad.SCHEMA)
        self.assertTrue(doc["generatedAt"])  # ISO-8601 timestamp string

        self.assertEqual(len(doc["worktrees"]), 1)
        wt = doc["worktrees"][0]
        for field, expected in (
            ("worktreeId", "w1"),
            ("repo", "orcaDeck"),
            ("displayName", "rockling"),
            ("branch", "main"),
            ("path", "/tmp/w1"),
            ("status", "open"),
            ("workspaceStatus", "clean"),
            ("isMainWorktree", True),
            ("isPinned", False),
            ("isActive", True),
            ("unread", 3),
            ("preview", "last line"),
            ("lastActivityAt", "2026-09-12T00:00:00Z"),
            ("lastOutputAt", "2026-09-12T00:01:00Z"),
            ("linkedPR", {"number": 7}),
        ):
            self.assertEqual(wt[field], expected, field)

        # Agents nested, terminal info joined onto the parent only.
        self.assertEqual(len(wt["agents"]), 1)
        parent = wt["agents"][0]
        self.assertEqual(parent["paneKey"], "t:l1")
        self.assertEqual(parent["terminalHandle"], "h1")
        self.assertEqual([c["paneKey"] for c in parent["children"]], ["t:l2"])
        self.assertIsNone(parent["children"][0]["terminalHandle"])

    def test_bare_list_ps_result(self):
        doc = orcad.project_state([{"worktreeId": "w1", "agents": []}], [])
        self.assertEqual(doc["worktrees"][0]["worktreeId"], "w1")
        self.assertEqual(doc["worktrees"][0]["agents"], [])

    def test_empty_inputs(self):
        doc = orcad.project_state({}, None)
        self.assertEqual(doc["worktrees"], [])
        self.assertEqual(doc["schema"], orcad.SCHEMA)


class ProjectRateLimitsTests(unittest.TestCase):
    def test_only_usable_readings_in_label_order(self):
        account = {
            "rateLimits": {
                "claude": {
                    "status": "ok",
                    "session": {"usedPercent": 12.5, "resetsAt": "soon"},
                    "weekly": {"usedPercent": 40},
                },
                "codex": {"status": "error", "session": {"usedPercent": 1}},
                # status ok but no window carries a numeric usedPercent -> dropped
                "gemini": {"status": "ok", "session": {"resetsAt": "later"}},
                # usedPercent 0 is still a real reading
                "opencodeGo": {"status": "ok", "monthly": {"usedPercent": 0}},
                "kimi": "not-a-dict",
                # a provider with no label is never emitted
                "mystery": {"status": "ok", "session": {"usedPercent": 99}},
            }
        }
        out = orcad.project_rate_limits(account)

        self.assertEqual([p["provider"] for p in out], ["claude", "opencodeGo"])
        self.assertEqual([p["label"] for p in out], ["Claude", "OpenCode"])

        claude = out[0]
        self.assertEqual(list(claude["windows"].keys()), ["session", "weekly"])
        self.assertEqual(claude["windows"]["session"]["usedPercent"], 12.5)
        self.assertEqual(claude["windows"]["session"]["resetsAt"], "soon")
        self.assertIsNone(claude["windows"]["weekly"]["resetsAt"])

        self.assertEqual(list(out[1]["windows"].keys()), ["monthly"])

    def test_window_without_numeric_used_percent_dropped(self):
        account = {
            "rateLimits": {
                "claude": {
                    "status": "ok",
                    "session": {"usedPercent": "lots"},  # not numeric -> dropped
                    "weekly": {"usedPercent": 5},
                }
            }
        }
        out = orcad.project_rate_limits(account)
        self.assertEqual(len(out), 1)
        self.assertEqual(list(out[0]["windows"].keys()), ["weekly"])

    def test_empty_and_garbage(self):
        self.assertEqual(orcad.project_rate_limits(None), [])
        self.assertEqual(orcad.project_rate_limits({}), [])
        self.assertEqual(orcad.project_rate_limits({"rateLimits": None}), [])
        self.assertEqual(orcad.project_rate_limits({"rateLimits": {}}), [])


class SendTextConfirmedTests(unittest.TestCase):
    def test_reissues_with_retry_request_until_turn_started(self):
        first = {"send": {"prompt": {"requestId": "r1", "stages": ["submitted"]}}}
        confirmed = {"send": {"prompt": {"requestId": "r1", "stages": ["turn_started"]}}}
        with mock.patch.object(cli, "run_orca_json", side_effect=[first, confirmed]) as run:
            out = orcad.send_text_confirmed("orca", "h1", "hello", True)

        self.assertIs(out, confirmed)
        self.assertEqual(run.call_count, 2)

        args, kwargs = run.call_args_list[1]
        self.assertEqual(args[0], "orca")
        self.assertIn("--retry-request", args)
        self.assertEqual(args[args.index("--retry-request") + 1], "r1")
        self.assertIn("--wait-submit", args)
        self.assertIn("--enter", args)  # original send flags are kept on reissue
        self.assertEqual(kwargs["timeout"], 8.0 + orcad.CLI_TIMEOUT_SEC)

    def test_turn_started_on_first_send_means_no_reissue(self):
        first = {"send": {"prompt": {"requestId": "r1", "stages": ["turn_started"]}}}
        with mock.patch.object(cli, "run_orca_json", return_value=first) as run:
            out = orcad.send_text_confirmed("orca", "h1", "hello", False)

        self.assertIs(out, first)
        self.assertEqual(run.call_count, 1)
        args, _ = run.call_args_list[0]
        self.assertNotIn("--enter", args)

    def test_cli_error_carrying_request_id_reissues(self):
        err = orcad.OrcaCliError(
            "agent_prompt_blocked",
            error={"data": {"orchestrationRequestId": "r1"}},
        )
        confirmed = {"send": {"prompt": {"requestId": "r1", "stages": ["turn_started"]}}}
        with mock.patch.object(cli, "run_orca_json", side_effect=[err, confirmed]) as run:
            out = orcad.send_text_confirmed("orca", "h1", "hello", True)

        self.assertIs(out, confirmed)
        self.assertEqual(run.call_count, 2)
        args, _ = run.call_args_list[1]
        self.assertEqual(args[args.index("--retry-request") + 1], "r1")

    def test_cli_error_without_request_id_propagates(self):
        err = orcad.OrcaCliError("boom")
        with mock.patch.object(cli, "run_orca_json", side_effect=err) as run:
            with self.assertRaises(orcad.OrcaCliError):
                orcad.send_text_confirmed("orca", "h1", "hello", True)
        self.assertEqual(run.call_count, 1)


class StateStoreTests(unittest.TestCase):
    def test_initial_snapshot_is_stale_with_error(self):
        store = orcad.StateStore()
        snap = store.snapshot()
        self.assertEqual(snap["error"], "not polled yet")
        self.assertIs(snap["stale"], True)
        self.assertEqual(snap["worktrees"], [])
        self.assertEqual(snap["schema"], orcad.SCHEMA)

    def test_set_ok_clears_error_and_staleness(self):
        store = orcad.StateStore()
        store.set_error("boom")
        store.set_ok({"schema": 1, "generatedAt": "now", "worktrees": [{"worktreeId": "w1"}]})
        snap = store.snapshot()
        self.assertIsNone(snap["error"])
        self.assertIs(snap["stale"], False)
        self.assertEqual(snap["worktrees"], [{"worktreeId": "w1"}])

    def test_set_error_keeps_state_but_flags_error(self):
        store = orcad.StateStore()
        store.set_ok({"schema": 1, "generatedAt": "now", "worktrees": []})
        store.set_error("poll failed")
        snap = store.snapshot()
        self.assertEqual(snap["error"], "poll failed")
        self.assertIs(snap["stale"], False)  # last successful poll is still fresh


class HttpLayerTests(unittest.TestCase):
    DOC = {
        "schema": orcad.SCHEMA,
        "generatedAt": "2026-09-12T00:00:00+00:00",
        "worktrees": [{"worktreeId": "w1"}],
        "rateLimits": [],
    }

    def setUp(self):
        self.store = orcad.StateStore()
        self.store.set_ok(dict(self.DOC))
        handler_cls = orcad.make_handler_class(self.store, binary="orca", token="t")
        handler_cls.log_message = staticmethod(lambda *a: None)  # keep test output quiet
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def _request(self, method, path, body=None, token=None):
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token is not None:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, exc.read()

    def test_get_state_200_without_auth(self):
        status, body = self._request("GET", "/v1/state")
        self.assertEqual(status, 200)
        doc = json.loads(body)
        self.assertEqual(doc["worktrees"], [{"worktreeId": "w1"}])
        self.assertEqual(doc["schema"], orcad.SCHEMA)
        self.assertIsNone(doc["error"])
        self.assertIs(doc["stale"], False)

    def test_get_index_200(self):
        status, body = self._request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>orcaDeck</title>", body)

    def test_get_action_is_404(self):
        status, _ = self._request("GET", "/v1/action")
        self.assertEqual(status, 404)

    def test_post_action_without_token_401(self):
        status, body = self._request(
            "POST", "/v1/action", body={"type": "send-text", "terminalHandle": "h1", "text": "hi"}
        )
        self.assertEqual(status, 401)
        self.assertIs(json.loads(body)["ok"], False)

    def test_post_action_with_wrong_token_401(self):
        status, _ = self._request(
            "POST",
            "/v1/action",
            body={"type": "send-text", "terminalHandle": "h1", "text": "hi"},
            token="wrong",
        )
        self.assertEqual(status, 401)

    def test_static_path_traversal_never_serves_files(self):
        marker = b"companion daemon"  # from orcad.py's module docstring
        for path in ("/../orcad.py", "/%2e%2e/orcad.py", "/..%2Forcad.py"):
            status, body = self._request("GET", path)
            self.assertIn(status, (403, 404), path)
            self.assertNotIn(marker, body, path)


class LoadOrCreateTokenTests(unittest.TestCase):
    def test_creates_then_reuses_token_file(self):
        with tempfile.TemporaryDirectory() as td:
            state_dir = Path(td) / "state"
            token_path = state_dir / "token"
            with mock.patch.object(auth, "STATE_DIR", state_dir), mock.patch.object(
                auth, "TOKEN_PATH", token_path
            ):
                first = orcad.load_or_create_token()
                self.assertTrue(first)
                self.assertTrue(token_path.exists())
                self.assertEqual(token_path.read_text().strip(), first)

                second = orcad.load_or_create_token()
                self.assertEqual(second, first)

    def test_regenerates_when_token_file_is_empty(self):
        with tempfile.TemporaryDirectory() as td:
            state_dir = Path(td)
            token_path = state_dir / "token"
            token_path.write_text("\n")
            with mock.patch.object(auth, "STATE_DIR", state_dir), mock.patch.object(
                auth, "TOKEN_PATH", token_path
            ):
                token = orcad.load_or_create_token()
                self.assertTrue(token)
                self.assertEqual(token_path.read_text().strip(), token)


if __name__ == "__main__":
    unittest.main()
