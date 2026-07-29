# Capability-aware user journeys

English · [简体中文](../zh-CN/USER_JOURNEYS.md) · [日本語](../ja/USER_JOURNEYS.md)

Five guided composition workflows — beat/song creation, advanced drums, sound
design, reference comparison, and performance diagnosis — exposed through the
read-only `plan_user_journey` tool, the `ableton://journeys` resource, and five
MCP prompts.

A journey is a plan over the same purpose-specific guarded tools used by direct
callers. A plan is **not** mutation authority: it contains no transaction
token, confirmation token, or idempotency key.

## Shared contract

1. Call `live_status` and plan against the reported adapter, epoch,
   capabilities, operations, registry hash, and provenance.
2. Announce each ordered text stage. Status is never represented by color alone.
3. Discover fresh exact refs and revisions before previewing.
4. Show the impact, targets, bounds, expected result, and recovery route.
5. Stop at every confirmation gate. A confirmation from one preview never
   authorizes another stage.
6. Apply through only the purpose-specific tool named in the stage. Do not use
   a generic invocation or infer authority from natural language.
7. Verify fresh authoritative postconditions. Cancellation, timeout, lost
   acknowledgement, or contradictory readback means `uncertain`, not success.
8. Recover with the transaction-owned undo/stop/cleanup route or independent
   emergency authority, then list every residual.

`traits` is bounded to 1,000 printable characters, `bars` to 1–16, and plans
cap note creation at 512. Only allowlisted rhythmic, density, energy, timbre,
space, dynamics, harmony, and arrangement descriptors enter derived guidance.
The original request remains labelled untrusted for operator context. If
identity or exact-copy language is detected, **all** extraction is blocked —
even coincident words such as "Bright" or "Major" — and the caller must restate
traits without names. Identity/copy text never enters note, topology, or
diagnostic guidance. If no safe trait is recognized, every stage is
`blocked-by-intent`, mode is `intent-clarification-required`, and no journey is
executable. Plan IDs are deterministic for the same normalized request and
negotiated Live state; a changed connection state, adapter, epoch, provenance,
registry hash, operation set, capability set, safe translation, or input
produces a different plan.

## 1. Create an editable beat or song section

Prompt: `create_beat_or_song`

The journey translates allowlisted high-level rhythmic, harmonic, arrangement,
and production traits into bounded tempo, role-event, grid, section, and
pitch-unset guidance before an exact structure/MIDI preview. It discovers the
Set, empty target slots, tempo, devices, and stopped playback; previews Session
structure and MIDI separately; requires exact confirmation for each mutation;
auditions only after a separate output-safety preview; revises notes by stable
IDs; and verifies or guardedly undoes the result. Arrangement, revision, and
audition stages are marked `planned` only when their exact capabilities and
operations are negotiated; otherwise each is `unavailable` with a non-mutating
fallback.

If required Session/MIDI capabilities are missing, the server returns an
editable note/structure plan and names each unavailable operation. It does not
claim that Live contains or played the result.

## 2. Sequence advanced drums

Prompt: `sequence_advanced_drums`

This journey discovers Drum Rack pad pitches instead of guessing a mapping. It
can preview and verify bounded velocity, fractional timing, probability,
velocity deviation, and release velocity when those fields are advertised.
Unsupported MPE, groove extraction, per-note expression, or modulation remains
explicitly unavailable; ordinary timing or velocity is never relabelled as one
of those features. Audition and recovery target only the exact owned clip.

## 3. Design a sound using available owned/native devices

Prompt: `design_owned_sound`

The journey derives semantic topology/control directions, searches the Browser
with stable result IDs, and previews loading one selected result. A Set with no
device can still advertise Browser loading; `devices`, `parameters`, and
`device.parameter.set` are therefore renegotiated after load. The client must
replan after that connection-scoped negotiation rather than assuming the old
plan changed. Parameter changes use exact published numeric controls and
bounds. Plug-ins that expose no Live parameter or preset API get manual
instructions only. Presence of a device is not claimed as causal audio proof.

## 4. Compare against a user-supplied reference

Prompt: `compare_reference_mix`

Local standards analysis remains available when Live is disconnected. The
journey accepts caller-supplied/generated PCM with an explicit rights and
consent relationship, runs bounded disposable workers, reports ITU-R
BS.1770-5/EBU R128 loudness and true peak, alignment confidence, dynamics,
spectrum, and transient aggregates, and returns no raw PCM. Fresh Live context
or guarded Session Resampling capture is optional. Observed topology,
measurements, and hypotheses remain separate; no causal claim is made from mere
device or routing presence.

Automatic alignment ambiguity causes refusal or a documented manual/disabled
fallback. A proposed mixer experiment is one reversible hypothesis with fresh
same-scope measurement, not mastering certainty.

## 5. Diagnose a mix, recording, or performance setup

Prompt: `diagnose_performance_setup`

The read-only first pass aggregates playback, arm, monitoring, routing, mixer,
device, automation, project, subscription, and realtime recovery state. It
ranks exact-ref findings before proposing a change. Feedback-prone routing,
recording, audible playback, and realtime arming use separate previews and
confirmations. Realtime reports distinguish accepted packets from applied
changes and require bounded token expiry/disarm plus independent TCP emergency
stop. Unknown latency remains unknown; the server does not claim a low-latency
path from UDP availability alone.

When routing, mixer, transport, recording, or stop authority is unavailable,
the fallback is a read-only checklist. It never arms, monitors, records,
routes, plays, or claims readiness.

## Rights-aware intent translation

Artist, record, song, person, and exact-copy wording in `traits` is retained
only as `untrustedOriginalRequest` and excluded from derived creative guidance.
Detection blocks the entire extraction because names can contain vocabulary
words; the user must resubmit recognized allowlisted high-level descriptors
without identity/copy wording. Such a request produces a clarification
requirement rather than a fake translation. Plans do not request or claim
access to protected source material, do not promise exact replication, and do
not assert legal clearance. Reference PCM must be supplied or generated by the
caller under a relationship the caller is authorized to use. The server cannot
determine copyright ownership or licensing.

## Progress and recovery language

Every plan supplies this ordered execution vocabulary:

`discovering` → `planned` → `awaiting_confirmation` → `applying` →
`verifying` → `completed`

The returned stage status is explicitly a planning template (`planned` or
`unavailable`), not execution truth. A client/agent derives runtime progress
from actual purpose-specific tool results, and a terminal path can instead be
`recovered` or `uncertain`. A terminal result must state residual playback,
recording, routing, temporary media, realtime authority, and created-object
state as applicable. Clients should announce the stage title before details and
keep beginner summaries separate from exact refs, epochs, revisions, and
registry hashes.

## Accessibility scope and known limitations

The shipped product is a JSON-RPC/MCP stdio service and CLI, not a graphical
editor. Its accessible contract is therefore text-first:

- semantic tool, resource, prompt, stage, impact, confirmation, and status names;
- deterministic reading order in arrays and prompt text;
- no mouse-only server instruction and no color-only result;
- text alternatives required for waveform, spectrum, meter, and other visual
  summaries;
- bounded output suitable for client announcements and cancellation.

There is no server-owned focus cursor, panel, canvas, or keyboard shortcut, so
focus management and contrast are not applicable at the stdio boundary. The
host does **not** control the accessibility behavior of an MCP client,
terminal, or Ableton Live. VoiceOver/Narrator support, focus order, key
bindings, and the accessibility of Live plug-in windows depend on those
products and versions. Operators requiring assistive technology should validate
their chosen client and Live version; inaccessible plug-in UI remains a manual
limitation rather than a claimed capability.
