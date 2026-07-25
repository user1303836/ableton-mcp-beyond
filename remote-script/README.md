# Ableton Remote Script boundary

`ableton_mcp_remote_script.py` is a dependency-free Python 3 transport shim
for an Ableton Control Surface. It does not import `ableton.v2`, open a socket,
or claim Live availability by itself. A real Control Surface supplies the
operation callback and an authenticated localhost transport, then maps the
operations to Live's documented API.

The wire contract is `ableton-loopback/v1`, with HMAC-SHA256 signatures,
monotonic nonces, bounded request IDs, and error responses instead of
tracebacks. Run its deterministic tests with:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

Install diagnostics must remain separate from capability status: the presence
of this source file is not evidence that Ableton Live, a Control Surface, or a
device is installed.
