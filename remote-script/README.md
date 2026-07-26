# Ableton Remote Script boundary

`ableton_mcp_remote_script.py` is a dependency-light Python 3 authenticated
boundary for an Ableton Control Surface. It does not import `ableton.v2` at
module load, so fake-Live contract tests can run without Live. It provides an
explicit `create_instance` entrypoint, loopback listener, main-thread queue,
epoch-scoped references, discovery, and bounded MIDI clip/note mapping.

The wire contract is `ableton-loopback/v1`, with HMAC-SHA256 signatures,
canonical JSON, strictly increasing request sequences, bounded request IDs and
nonces, and error responses instead of tracebacks. Responses are also
authenticated by the compatible TypeScript client boundary. Run deterministic
tests with:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

Install diagnostics must remain separate from capability status: the presence
of this source file is not evidence that Ableton Live, a Control Surface, or a
device is installed.

`create_instance` fails closed without an explicit loopback host, valid port,
and secret of at least 32 characters. Socket workers only frame, authenticate,
sequence, and enqueue; `update_display` or `drain_main_thread` executes the
Live-facing mapper work. Disconnect closes clients, resets the queue, and
advances the reference epoch. Fake-Live and Python socket tests remain
deterministic contract evidence, not proof of compatibility with a real Set or
Live version.
