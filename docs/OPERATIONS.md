# Operations guide

## Start and observe

```sh
cd apps/mcp-server
npm ci
npm run build
node dist/src/cli.js
```

The process is intended to be supervised by an MCP client or process manager.
Keep stdout connected to the protocol consumer and capture stderr separately.
Do not parse human diagnostics as protocol messages.

There is no in-place session resume. If stdin, stdout, or the process fails,
restart `cli.js`, repeat `initialize` and `notifications/initialized`, and
retry with a new request ID.

Use `server_status` after initialization to verify the host state. In the
current release a healthy status still reports the Live adapter as unavailable;
this is expected and is not evidence of Live connectivity.

Use `capabilities` as the authoritative feature list. The only implemented
tools are `server_status`, `capabilities`, and `audio_analyze`; caller metadata
or authority-like fields cannot enable unavailable capabilities.

## Resource and input limits

The host bounds each input line at 64 MiB. PCM analysis bounds decoded input at
10,000,000 samples and 600 seconds, and limits sample rate, channels, and FFT
frame size to the ranges in the user guide. Analysis examines at most 32
spectral frames with an FFT of at most 4,096 points and does not retain audio.

Rate-limit handling returns JSON-RPC error `-32029` after 120 audio calls in a
rolling minute. Other malformed or invalid requests return standard validation
errors or an MCP tool error with remediation text.

The process accepts one newline-delimited JSON-RPC message per line. A malformed
line returns parse error `-32700` and a redacted stderr diagnostic, then later
lines can still be processed. Lines over 64 MiB receive an invalid-request
error and are discarded through the next newline.

## Shutdown and upgrades

There is no legacy `shutdown` method and no installed Live adapter to stop.
Terminate the supervising process using its normal service mechanism after
allowing the MCP client to close stdin. For an upgrade, stop the process,
install dependencies from the lockfile, run the checkpoint validation, and
restart only after it passes. Use `npm start`, `node dist/src/cli.js`, or
generated setup configuration as the server command.

For a packaged installation, use the `ableton-mcp-server` binary or `npm
start` after build. The setup, migration, and diagnostics helpers write or
inspect local configuration only; they do not install or launch Live. The
deterministic simulator and authenticated loopback are development/test
components and are not evidence that a Live set is connected.

The independent Python boundary tests run from the repository root with
`python3 -m unittest discover -s remote-script -p 'test_*.py'`. Passing them
proves only deterministic transport validation and wire-safe errors.
