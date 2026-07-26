# Recovery procedures

Recovery is intentionally restart-based: the stdio host has no persistent
session, durable request queue, or in-place resume mechanism.

## Invalid request or tool error

Read the returned JSON-RPC error or the tool error’s `reason`. Correct the
request and retry with a new request ID. Do not retry an unchanged malformed
payload. For audio, verify little-endian float32 encoding, complete channel
frames, normalized sample values, supported sample rate, and the sample/time
limits. The base64 string must be canonical; re-encode the decoded bytes when
diagnosing padding or alphabet errors.

## Duplicate or exhausted request IDs

Generate a fresh non-empty string or safe-integer ID for each retry. The host
tracks up to 4,096 recent IDs; a duplicate currently fails deterministically.

## Oversized input or rate limiting

Split or reduce the audio payload so it fits the analysis bounds. If the audio
rate limit is reached, wait until the rolling one-minute window clears and then
retry with a fresh ID. Do not send a large stream without newline framing.

## Malformed stream

Discard the malformed line, inspect stderr for the redacted parse diagnostic,
and resume with a valid newline-delimited message. If the supervisor or pipe is
broken, restart `dist/src/cli.js`, repeat initialization and the initialized
notification, and retry with a new request ID. Invalid UTF-8 and oversized
records are rejected by the framer; oversized data is discarded through its
next newline. No Live recovery action is needed because the shipped server
cannot mutate or play a Live set.

## Suspected Live impact

Stop using the client, capture the request/response transcript without exposing
audio or credentials, and verify `server_status` and `capabilities`. The
current implementation has no Live mutation or playback path. Escalate any
contradictory observation as an implementation defect before enabling future
adapter functionality.

## Configuration or diagnostics failure

Do not use `--force` as a first response to a setup or migration error. Check
that the output parent exists, the command is non-empty, the document is
version 1 (or a valid legacy command-and-string-args document), and the
destination is disposable or backed up. Run `npm run diagnostics -- --config
/absolute/path/config.json`; `valid: false` means the config must be repaired or
migrated before use.

## Restart procedure

1. Stop the failed process through its supervisor.
2. Start `node dist/src/cli.js` with stdout and stderr kept on separate
   channels.
3. Send `initialize` with protocol version `2025-11-25` and valid client
   identity, then send `notifications/initialized`.
4. Retry only the operation that was not acknowledged, using a fresh request
   ID. The server has no persistent or resumable Live session state.

For a future adapter using the loopback boundary, stop on any authentication,
replay, or unexpected mutation result. Rotate the loopback secret, close the
subscription, discard outstanding nonces, and reconnect only after checking
adapter status and epoch. The current MCP host does not instantiate this
boundary.

For a failed package or configuration upgrade, preserve the old configuration,
discard only failed disposable output, rerun `npm ci`, `npm run build`, and
the checkpoint checks, then regenerate setup output with an explicit path. Do
not use `--force` without a backup.

The writer refuses symbolic-link destinations, refuses overwrite without
`--force`, requires an existing parent directory, and uses owner-only file
permissions where supported. Preserve the old file before any forced rewrite.

If a future adapter reports authentication, replay, epoch, or mutation
behavior inconsistent with its contract, stop the client and isolate the
adapter before retrying. The current host cannot enter that state because it
does not instantiate the loopback or simulator adapters.

## Guarded tempo recovery

Treat a tempo apply as incomplete until the response confirms the requested
tempo, then read `live_snapshot` and compare the authoritative value. Reusing
the same idempotency key is safe for a repeated apply or undo response. A
transaction error for expiry, an epoch change, or a changed tempo means the
operation was refused; obtain a fresh status/snapshot and preview again. If an
apply reports failure after contacting a future adapter, inspect the set before
retrying. Never force an undo after the postcondition or epoch check fails.
