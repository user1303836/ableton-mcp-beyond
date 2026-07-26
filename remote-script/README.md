# Ableton Remote Script boundary

`ableton_mcp_remote_script.py` is a dependency-free Python 3 authenticated
dispatch shim for a future Ableton Control Surface. It does not import
`ableton.v2`, create a Control Surface entrypoint, open a socket, schedule
Live work on the main thread, or claim Live availability. A future Control
Surface must supply the operation callback and authenticated localhost
transport, then map operations to Live's documented API.

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
