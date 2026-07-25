# Operations guide

## Start and observe

```sh
cd apps/mcp-server
npm ci
npm start
```

The process is intended to be supervised by an MCP client or process manager.
Keep stdout connected to the protocol consumer and capture stderr separately.
Do not parse human diagnostics as protocol messages.

Use `server_status` after initialization to verify the host state. In the
current release a healthy status still reports the Live adapter as unavailable;
this is expected and is not evidence of Live connectivity.

## Resource and input limits

The host bounds each input line at 64 MiB. PCM analysis bounds decoded input at
10,000,000 samples and 600 seconds, and limits sample rate, channels, and FFT
frame size to the ranges in the user guide. Analysis examines at most 32
spectral frames with an FFT of at most 4,096 points and does not retain audio.

Rate-limit handling returns JSON-RPC error `-32029` after 120 audio calls in a
rolling minute. Other malformed or invalid requests return standard validation
errors or an MCP tool error with remediation text.

## Shutdown and upgrades

There is no legacy `shutdown` method and no installed Live adapter to stop.
Terminate the supervising process using its normal service mechanism after
allowing the MCP client to close stdin. For an upgrade, stop the process,
install dependencies from the lockfile, run the checkpoint validation, and
restart only after it passes.
