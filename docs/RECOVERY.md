# Recovery procedures

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
broken, restart the server and repeat initialization; no Live recovery action
is needed because the shipped server cannot mutate or play a Live set.

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
