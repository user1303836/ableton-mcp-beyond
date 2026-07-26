# Recovery procedures

## Protocol and input errors

Correct the request and use a fresh request identifier. For malformed or oversized input, discard the rejected frame and inspect only the redacted stderr diagnostic. If authentication, framing, sequencing, or response correlation is no longer trustworthy, stop and restart the process; do not continue the stream.

## Configuration and installation errors

Verify that the path is explicit, regular, non-symlink, and owner-controlled; configuration is version 1 or 2; the bridge host is numeric loopback (`127.x.x.x` or `::1`); port and timeout are in range; and the separate secret is at least 32 non-whitespace characters with safe permissions. Never put a secret on the command line. Write a repaired configuration to a new path before using `--force`. Preserve any installer backup and never replace an unrelated destination.

## Adapter uncertainty

Authentication failure, registry mismatch, response-MAC failure, replay, sequence error, malformed response, timeout, cancellation, disconnect, or acknowledgement loss means the result is unknown. Stop mutation attempts. Reconnect only after checking that the bridge is the intended endpoint, then obtain a fresh status, epoch, snapshot, and discovery result. Never automatically replay a mutation.

For a cancelled stdio request, no cancellation response is emitted. Cancellation before handler dispatch may prevent work; cancellation after dispatch does not undo Live work. Treat the latter as uncertain and perform fresh readback before any further mutation.

## Transaction recovery

Preview expiry, stale epoch, stale revision, invalid parent, occupied Session slot, duplicate structure name, locator collision, unsupported or disabled parameter, out-of-range or incorrectly quantized value, failed verification, or failed compensation requires fresh authoritative discovery and a new preview. `live_undo` refuses uncertain or externally changed state. For device parameters, verify the same device-child relationship, applied value, and applied revision before undo; reconnects, automation changes, or external edits require manual inspection.

For scene audition, never replay an uncertain apply or stop. First perform
fresh authenticated playback discovery. If the connection epoch, Set name,
scene revision, recording state, arm/monitoring state, output evidence, or
active targets differ from the transaction, stop is refused and the operator
must inspect the Set manually. If playback is proven to be only the mapper-
owned scene, use the original stop confirmation and a new bounded idempotency
key; a successful exact replay returns the prior result without dispatch.

## Restart

1. Stop the supervisor and preserve redacted diagnostics.
2. Confirm that no generated archive or credential file is being collected.
3. Restart `dist/src/cli.js` with stdout and stderr separate.
4. Initialize with `2025-11-25`, then send `notifications/initialized`.
5. Obtain fresh status and discovery, preview again, and use a new bounded idempotency key.

If real Live is involved, stop and inspect the Set visibly before continuing. Repository-controlled evidence cannot substitute for that inspection or prove restoration.
