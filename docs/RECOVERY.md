# Recovery procedures

## Protocol or input errors

Use a fresh request ID after correcting the request. For malformed or oversized
input, discard the rejected line, inspect only the redacted stderr diagnostic,
and resume with valid newline-delimited JSON. Restart if the pipe or process
has failed. Reinitialize after every restart.

## Configuration or installation errors

Check that the parent exists, the configuration is version 1 or 2, the bridge
host is loopback, the port and timeout are in range, and the secret is a
regular owner-only file of at least 32 non-whitespace characters. Do not put a
secret on the command line. Repair or migrate to a new explicit path before
using `--force`. For installation, preserve the reported backup and do not
replace an unrelated destination.

## Adapter uncertainty

Authentication failure, response-MAC failure, replay, sequence error,
malformed response, timeout, disconnect, or acknowledgement loss means the
remote result is unknown. Stop mutation attempts, reconnect only after checking
status and epoch, and read authoritative state before any retry. Never
automatically replay a mutation.

## Transaction recovery

Preview expiry, epoch change, stale revision, occupied Session slot, locator
collision, failed verification, or compensation failure requires fresh
discovery and a new preview. Arrangement uncertainty must be resolved by
reading locators; `live_undo` refuses uncertain or externally changed state.
Tempo and MIDI undo likewise refuse when the captured postcondition or epoch no
longer matches. Do not force an undo.

## Process restart

1. Stop the supervisor.
2. Confirm no generated or credential files are being collected.
3. Restart `dist/src/cli.js` with separate stdout/stderr.
4. Send `initialize` with `2025-11-25`, then `notifications/initialized`.
5. Use fresh request IDs and fresh transaction previews.

If a real Live session is ever involved, stop and inspect the Set visibly before
continuing. The current deterministic evidence cannot substitute for that
inspection.
