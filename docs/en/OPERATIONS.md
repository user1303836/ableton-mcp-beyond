# Operations guide

English · [简体中文](../zh-CN/OPERATIONS.md) · [日本語](../ja/OPERATIONS.md)

Running the bridge day to day: starting it, checking it, its limits, and what
it writes to disk. To install it, see [delivery](DELIVERY.md). When something
fails, see [recovery](RECOVERY.md).

## Start

The MCP client starts the server, one process per client:

```sh
/absolute/path/ableton-mcp-server --config /absolute/path/bridge-config.json
```

The server reads MCP messages as JSON lines on stdin and writes them on stdout.
Keep stdout for MCP alone. The server's own log lines go to stderr, prefixed
`mcp-host:`. Set the [deployment policy](USER_GUIDE.md#deployment-policy) and
any other [environment variables](USER_GUIDE.md#environment-variables) in the
server's environment.

Kumi starts its sibling native server, sets the policy to the tools it uses, and waits up to
65 seconds for an answer. The analysis worker stays beside the server.

## Check the connection

Call `live_status`. A working connection shows:

- `"connected": true`;
- `"adapter": "remote-script"`;
- `"provenance": "real-live"`;
- a numeric `epoch`;
- the registry hash and operations the Remote Script offers.

Don't take an open port or a running Live as proof: only an authenticated
`live_status` is.

`ableton-mcp-server diagnostics --config <path>` checks the same from a terminal. It
reports the native runtime, the package, the configuration and the secret's permissions. It
then makes a short authenticated read of the Set (set, scenes, tracks,
playback, one track's clip slots). [Delivery](DELIVERY.md) explains the report
stage by stage.

## Limits

| Limit | Value |
| --- | --- |
| One MCP message | 500 MiB |
| One message from the Remote Script | 256 MiB |
| Requests waiting on the Remote Script | 4,096 |
| Requests in flight | 16 at a time; past 64 waiting, new ones get `-32000 Server is busy` |
| Deadline for a request to Live | `timeoutMs` (5 s by default). Snapshots and discovery get six times that, and previews and applies get 15–45 s plus 20 ms per track in the Set. Never over 60 s. |
| Preview lifetime | 10 minutes; batch, MIDI clip and device-state previews 30 s; capture previews 60 s |
| Undo records kept | 1 GiB in all; 512 each for batches, MIDI clips and device states (the oldest applied change gives up its undo first) |
| Events queued for a slow client | 65,536, then `notifications/live_event_overflow` |
| Notes per page | 2,000 |
| Parameters in one change | 10,000 |
| Batch | 32 operations |
| Audio analysis | 10,000,000 samples or 600 s; 2 workers at a time, 4 waiting, 30 s each |
| Reference comparison | 4,000,000 samples, 30 s per source, 10 s alignment lag |

Tool calls have no rate limit. [Realtime control](REALTIME_CONTROL.md) and
[audio intelligence](AUDIO_INTELLIGENCE.md) list their own limits.

## Answers, cancellation and shutdown

Each answer goes out as soon as its request finishes, so a slow request (a big
Set's export, a render) doesn't hold up the others. Match answers to requests
by `id`.

A `notifications/cancelled` stops a request that hasn't started. If the request
has already reached Live, cancelling doesn't undo it. The change may have
happened, so read before changing anything else.

Closing stdin ends the server. It closes an undo step left open, then lets Live
go. Restarting the server starts with no undo records; see
[recovery](RECOVERY.md#after-a-restart).

## Files the bridge writes

| What | Where |
| --- | --- |
| Configuration, secret, receipt, journal | The lifecycle's state folder: `~/.config/ableton-mcp`, or `%APPDATA%\ableton-mcp` on Windows, unless you chose another |
| Remote Script diagnostics log | `bridge-diagnostics.log` in the state folder, only after `ableton-mcp-server lifecycle install --enable-bridge-diagnostics`. It holds event codes without names or data; capped at 16 MiB, then it starts over. |
| Copies of imported audio | `~/.config/ableton-mcp/import-staging` (`%APPDATA%\ableton-mcp\import-staging`), or `ABLETON_MCP_IMPORT_STAGING_DIR`. Live plays these copies, so remove them only once no clip uses them; see [Live safety](LIVE_SAFETY.md). |
| Drum Sampler carrier presets | The `Kumi` folder in Live's User Library, removed once loaded |
| Device states | The folder you name to `live_device_state_save` |
| Set backups | Beside the saved Set (`live_project_backup_apply`) |
| Renders | The Live extension's temporary folder, kept 6 hours |

## Several clients

Each client starts its own server, and the Remote Script accepts up to 64
connections. Servers don't share undo records or know each other's changes. An
apply refused with "Live state changed since the preview" may be another
client's doing: read again and preview again.
