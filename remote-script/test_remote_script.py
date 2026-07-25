import unittest

from ableton_mcp_remote_script import AuthenticatedRemoteScript, PROTOCOL


class RemoteScriptTests(unittest.TestCase):
    def test_authentication_and_replay_protection(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: {"method": method})
        unsigned = {"version": PROTOCOL, "id": "one", "method": "status", "nonce": "0000000000000001"}
        request = {**unsigned, "mac": remote.sign(unsigned)}
        self.assertTrue(remote.dispatch(request)["ok"])
        self.assertFalse(remote.dispatch(request)["ok"])

    def test_operation_failures_are_wire_errors(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: (_ for _ in ()).throw(RuntimeError("not available")))
        unsigned = {"version": PROTOCOL, "id": "one", "method": "snapshot", "nonce": "0000000000000001"}
        result = remote.dispatch({**unsigned, "mac": remote.sign(unsigned)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "not available")

    def test_random_ordered_nonces_and_unknown_fields(self):
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: method)
        first = {"version": PROTOCOL, "id": "one", "method": "status", "nonce": "zzzzzzzzzzzzzzzz1"}
        second = {"version": PROTOCOL, "id": "two", "method": "status", "nonce": "aaaaaaaaaaaaaaaa2"}
        self.assertTrue(remote.dispatch({**first, "mac": remote.sign(first)})["ok"])
        self.assertTrue(remote.dispatch({**second, "mac": remote.sign(second)})["ok"])
        extra = {**second, "id": "three", "nonce": "bbbbbbbbbbbbbbbb3", "unexpected": True}
        self.assertFalse(remote.dispatch({**extra, "mac": remote.sign(extra)})["ok"])

    def test_unknown_method_is_rejected_before_operation(self):
        called = []
        remote = AuthenticatedRemoteScript("0123456789abcdef0123456789abcdef", lambda method, request: called.append(method))
        request = {"version": PROTOCOL, "id": "one", "method": "delete", "nonce": "cccccccccccccccc4"}
        self.assertFalse(remote.dispatch({**request, "mac": remote.sign(request)})["ok"])
        self.assertEqual(called, [])


if __name__ == "__main__":
    unittest.main()
