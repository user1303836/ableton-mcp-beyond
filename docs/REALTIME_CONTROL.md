# Realtime control plane

The production Remote Script can expose a separately configured loopback UDP
endpoint for short-lived high-rate control. It is disabled unless the version-2
bridge configuration contains a distinct `realtimePort`:

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 9765,
    "realtimePort": 9766,
    "secretFile": "/absolute/owner-only/bridge.secret",
    "timeoutMs": 5000
  }
}
```

Generate this shape with `ableton-mcp-setup --realtime-port 9766`. Both TCP and
UDP listeners bind only to the configured numeric loopback address. A port
conflict fails startup rather than silently disabling the plane.

## Authority lifecycle

1. Call `live_realtime_arm_preview` with one or more explicit channels
   (`udp-json`, `osc`, `xy`, `max`), an exact allowlist of 0–32 authoritative
   published parameter refs, a TTL from 1–30 seconds, optional allowed sender
   ports, and authoritative output-safety evidence. An empty ref list permits
   emergency-stop packets only.
2. Apply the unexpired transaction once with `confirmation=apply` and an
   idempotency key. The host carries the final preview's exact parameter,
   owner, track, and ordered-sibling identity descriptors in the canonical arm
   request; Live compares every descriptor atomically before creating the
   token. A replacement at the same traversal ref is refused. Arming is also
   refused unless adapter provenance is `real-live`.
3. The result contains the loopback endpoint, an unpredictable bearer token,
   expiry, selected channels and exact parameter refs, 512-byte packet limit,
   64-packet/s token-bucket
   rate, and burst size 16. Do not log or persist the token.
4. Send positive safe-integer sequences. Sequence state is one replay domain
   per arm. Re-arm invalidates the prior token and queued generation.
5. Call `live_realtime_stats` to distinguish accepted, pending, applied,
   callback failures, pre-dispatch drops, endpoint/token/replay/rate/queue
   drops, unauthorized-target drops, sequence gaps, and inter-arrival/transit
   jitter.
6. Call `live_realtime_disarm` with `confirmation=disarm`. Disarm, re-arm,
   expiry, bridge teardown, and main-thread deadline expiry fence queued work.

`accepted` means admitted to Live's bounded main-thread queue, not delivered.
Only `applied` confirms the scheduled callback completed and synchronously
verified its published parameter value. UDP itself has no acknowledgement.

## UDP JSON

Every datagram is a single UTF-8 JSON object no larger than 512 bytes. Unknown
fields are rejected.

Published parameter:

```json
{"token":"<arm token>","seq":1,"channel":"udp-json","op":"parameter.set","ref":"<parameter ref>","value":0.5,"sentAtMs":1700000000000}
```

Atomic XY pair with best-effort rollback if either verified write fails:

```json
{"token":"<arm token>","seq":2,"channel":"xy","op":"xy.set","xRef":"<parameter ref>","x":0.4,"yRef":"<parameter ref>","y":0.6,"sentAtMs":1700000000000}
```

An operator-authored client, including a Max patch, may serialize the same
strict objects with `channel:"max"`. This is only an authenticated extension
packet label: runtime status does not advertise a `max` capability, no Max
handshake occurs, and no `.amxd` device is bundled. A patch may send it with
`udpsend` to the returned loopback endpoint; distribution and validation of a
ready-made Max device remain a separately versioned extension.

Emergency stop:

```json
{"token":"<arm token>","seq":3,"channel":"udp-json","op":"emergency-stop","sentAtMs":1700000000000}
```

The callback obtains exact fresh active targets and invokes the guarded stop on
Live's thread. The authenticated TCP `live_session_emergency_stop` remains an
independent recovery path when no realtime token is available.

## OSC

OSC bundles and unsupported types are rejected. Supported messages are:

- `/ableton-mcp/parameter` — arguments `string token`, `int32|int64 seq`,
  `string ref`, `float|double value`, optional `double sentAtMs`.
- `/ableton-mcp/xy` — arguments `string token`, `int32|int64 seq`, `string
  xRef`, `float|double x`, `string yRef`, `float|double y`, optional `double
  sentAtMs`.
- `/ableton-mcp/emergency-stop` — arguments `string token`, `int32|int64 seq`,
  optional `double sentAtMs`.

OSC packets require the `osc` channel in the arm. JSON XY packets require `xy`;
Max-labelled JSON packets require `max`. Emergency stop is allowed through any
selected channel but still requires the current token, endpoint, sequence, and
TTL.

## Live-thread and value safety

Socket threads only decode, authenticate, account, and enqueue. Parameter
resolution, bounds, enabled state, quantization, writes, XY rollback, value
verification, playback observation, and emergency stop all execute on Live's
scheduled Control Surface thread. Before each write, Live recomputes the same
parameter/owner/track/sibling descriptor retained at arm time; topology drift
revokes the generation and refuses the queued write. Values outside
authoritative bounds are rejected, never clamped silently. The queue is bounded to 128 callbacks and a
realtime callback has a one-second pre-dispatch deadline.

The realtime plane only writes already published numeric Live parameters. It
does not load devices, select Browser items, change routing, arm recording,
write files, or expose a generic Live-object operation.

## Recovery

- On any `applyFailures`, `revokedBeforeApply`, `droppedBeforeDispatch`, or
  persistent `pending` value, disarm and perform fresh discovery before retry.
- A sender-port mismatch, bad token/channel, replay, invalid packet, overload,
  or full queue is dropped and counted; it is never retried automatically.
- If the MCP host restarts while Live and the bridge remain up, a current token
  remains usable only until its original expiry. Reconnect does not extend it.
- If Live or the bridge restarts, the socket closes and every token disappears.
- Always restore touched parameters and confirm stopped/non-recording state in
  a disposable Set after a realtime test.

Real-Live macOS evidence is recorded in
`docs/evidence/phase-7c-realtime-live.json`. It does not substitute for Windows
Live evidence or prove a bundled Max for Live device.
